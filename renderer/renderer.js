'use strict';

(function () {
  const api = window.mdviewer;
  const mdlib = window.mdlib; // Pure helpers from lib.js, loaded by the preceding <script>.

  const contentEl = document.getElementById('content');
  const welcomeEl = document.getElementById('welcome');
  const toolbarEl = document.getElementById('toolbar');
  const outlineEl = document.getElementById('outline');
  const outlineListEl = document.getElementById('outline-list');
  const outlineToggleEl = document.getElementById('outline-toggle');
  const findbarEl = document.getElementById('findbar');
  const findInputEl = document.getElementById('find-input');
  const findCountEl = document.getElementById('find-count');
  const toastEl = document.getElementById('zoom-toast');

  let currentPath = null;
  let currentBaseDir = null;
  let renderToken = 0;

  marked.setOptions({ gfm: true, breaks: false });

  const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

  // Everything in sanitized Markdown that makes the page fetch something. It is more than <img
  // src>, because DOMPurify keeps far more than Markdown can produce: <video poster>, <input
  // type=image src>, <source srcset>, a `background` on a table cell. Each of these resolves
  // against renderer/index.html unless it is rewritten, and DOMPurify passes any value that does
  // not start with a scheme — so a host-relative '//host/x.png' arrives untouched, resolves to
  // file://host/x.png, and Windows fetches it over SMB from an attacker-chosen server, handing
  // that server an NTLM authentication attempt with nothing on screen and no click.
  //
  // One URL each, so they can be resolved against the document's folder:
  const URL_ATTRIBUTES = ['src', 'poster'];
  // Comma-separated candidate lists, which no Markdown produces. Dropped rather than parsed; an
  // <img> that had one falls back to its src, which is resolved like any other.
  const DROPPED_ATTRIBUTES = ['srcset', 'sizes', 'background'];

  // Matches main/zoom.js: one wheel notch is one menu zoom step.
  const ZOOM_STEP = 0.5;
  const TOAST_MS = 800;
  const FIND_DEBOUNCE_MS = 150;
  // How much of the top of the viewport the floating toolbar and find bar cover.
  const FIND_TOP_CLEARANCE = 100;
  const COPY_FEEDBACK_MS = 1200;
  const SCROLL_SAVE_MS = 250;
  const MAX_SCROLL_ENTRIES = 50;
  // How far below the top of the viewport a heading counts as "the section being read".
  const ACTIVE_HEADING_OFFSET = 90;

  const WIDTHS = { narrow: '680px', default: '760px', wide: '980px', full: '100%' };

  function decode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  // ------------------------------------------------------------ stored state
  //
  // localStorage can be missing or full; none of it is worth an error, so every access is
  // wrapped and the UI falls back to its defaults.

  const SETTING_PREFIX = 'mdviewer:';
  const SCROLL_PREFIX = 'scroll:';

  function readSetting(key, fallback) {
    try {
      const value = localStorage.getItem(SETTING_PREFIX + key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      localStorage.setItem(SETTING_PREFIX + key, value);
    } catch {
      /* not persisted */
    }
  }

  function readScrollPosition(filePath) {
    try {
      const raw = localStorage.getItem(SCROLL_PREFIX + filePath);
      if (!raw) return 0;
      const entry = JSON.parse(raw);
      return Number.isFinite(entry.y) && entry.y > 0 ? entry.y : 0;
    } catch {
      return 0;
    }
  }

  function writeScrollPosition(filePath, y) {
    try {
      const entry = JSON.stringify({ y: Math.round(y), t: Date.now() });
      localStorage.setItem(SCROLL_PREFIX + filePath, entry);
    } catch {
      return;
    }
    pruneScrollPositions();
  }

  /** Keeps the MAX_SCROLL_ENTRIES most recently written positions and drops the rest. */
  function pruneScrollPositions() {
    const entries = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || key.indexOf(SCROLL_PREFIX) !== 0) continue;
        let timestamp = 0;
        try {
          timestamp = JSON.parse(localStorage.getItem(key)).t || 0;
        } catch {
          timestamp = 0; // Unreadable entry: oldest possible, so it is evicted first.
        }
        entries.push({ key, timestamp });
      }
      if (entries.length <= MAX_SCROLL_ENTRIES) return;
      entries.sort((a, b) => a.timestamp - b.timestamp);
      for (const entry of entries.slice(0, entries.length - MAX_SCROLL_ENTRIES)) {
        localStorage.removeItem(entry.key);
      }
    } catch {
      /* nothing to prune */
    }
  }

  let scrollSaveTimer = null;

  function scheduleScrollSave() {
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveScrollPosition, SCROLL_SAVE_MS);
  }

  function saveScrollPosition() {
    if (scrollSaveTimer) {
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = null;
    }
    if (currentPath) writeScrollPosition(currentPath, window.scrollY);
  }

  // ------------------------------------------------------------ rendering

  function addHeadingIds() {
    const unique = mdlib.createSlugger();
    for (const heading of contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const id = heading.id || mdlib.slugify(heading.textContent || '');
      if (!id) continue;
      heading.id = unique(id);
    }
  }

  /**
   * Points every resource in the rendered document at the document's own folder — see
   * URL_ATTRIBUTES above for why this is not just images.
   *
   * This must stay in the same synchronous block as the innerHTML assignment that produced the
   * nodes. Chromium queues a resource fetch to run after the current script, so an attribute
   * removed or rewritten here is never requested with the value it arrived with.
   */
  function resolveResources(baseDir) {
    for (const element of contentEl.querySelectorAll('[srcset], [sizes], [background]')) {
      for (const name of DROPPED_ATTRIBUTES) element.removeAttribute(name);
    }
    for (const element of contentEl.querySelectorAll('[src], [poster]')) {
      for (const name of URL_ATTRIBUTES) {
        const value = element.getAttribute(name);
        if (!value) continue;
        // '//host/x.png' (or '\\host\x.png') is the SMB case described above: never leave the
        // machine for it.
        if (/^[\\/]{2}/.test(value)) {
          element.removeAttribute(name);
          continue;
        }
        if (ABSOLUTE_URL.test(value)) continue;
        element.setAttribute(name, mdlib.toFileUrl(mdlib.resolvePath(baseDir, decode(value))));
      }
    }
  }

  /** @type {Promise<boolean>|null} Resolves once highlight.js has loaded, or failed to. */
  let highlighter = null;

  /**
   * Appends highlight.js and its two themes, once, the first time a document needs them. They are
   * ~130 KB of script and CSS that a document with no code block never has to parse, which is why
   * index.html does not load them up front. `script-src 'self'` covers a same-origin <script>
   * appended from here, so the CSP is untouched.
   */
  function loadHighlighter() {
    if (highlighter) return highlighter;
    highlighter = new Promise((resolve) => {
      // One theme per colour scheme; styles.css owns the code block itself (background, padding,
      // text colour), so these only paint tokens.
      for (const [href, media] of [
        ['vendor/github.min.css', '(prefers-color-scheme: light)'],
        ['vendor/github-dark.min.css', '(prefers-color-scheme: dark)']
      ]) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.media = media;
        link.href = href;
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      // Vendored file missing: resolve either way, so plain code blocks still work.
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      script.src = 'vendor/highlight.min.js';
      document.head.appendChild(script);
    });
    return highlighter;
  }

  /** Resolves once the browser has painted the frame that the caller's DOM changes are in. */
  function afterPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /**
   * Highlights every code block, loading highlight.js first if this is the first document that
   * needs it.
   *
   * Deliberately not awaited by render(), and deliberately behind afterPaint(): highlighting adds
   * colour to text that is already legible, and highlight.js can spend tens of milliseconds per
   * document guessing the language of a fence that did not name one. Waiting for it before the
   * first frame would hold the whole window back for a repaint that changes no layout, so the
   * document is shown as soon as it is readable and the colours arrive a frame or two later.
   */
  async function highlightCode(token) {
    if (!contentEl.querySelector('pre > code')) return;
    await afterPaint();
    if (token !== renderToken) return; // A newer document arrived; it will run its own pass.
    if (!(await loadHighlighter())) return;
    if (token !== renderToken) return;
    for (const code of contentEl.querySelectorAll('pre > code')) hljs.highlightElement(code);
    // Every code block's text nodes have just been replaced with coloured ones, so a find range
    // pointing into one now points outside the document. Search again over the nodes that exist.
    if (findOpen) runFind(false, false);
  }

  /**
   * Wraps every code block so the copy button can sit in a corner that does not slide away when
   * the code is scrolled sideways — an absolutely positioned child of the <pre> would.
   */
  function addCopyButtons() {
    for (const pre of contentEl.querySelectorAll('pre')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-button';
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy code');
      button.title = 'Copy code';
      wrapper.appendChild(button);
    }
  }

  /** The raw block, shown as text and never parsed: it is data about the file, not content. */
  function showFrontmatter(text) {
    const details = document.createElement('details');
    details.className = 'frontmatter';
    const summary = document.createElement('summary');
    summary.textContent = 'Front matter';
    const pre = document.createElement('pre');
    pre.textContent = text;
    // Opening the block adds text a running search should see; closing it takes that text away.
    details.addEventListener('toggle', () => {
      if (findOpen) runFind(false, false);
    });
    details.append(summary, pre);
    contentEl.prepend(details);
  }

  // Freshly inserted images have no height yet, so the document can still be shorter than the
  // saved offset and scrollTo() clamps. Re-apply as each image settles, unless a newer render
  // happened or the reader has already scrolled past the target themselves.
  function restoreScroll(scrollY, token) {
    window.scrollTo(0, scrollY);
    if (scrollY === 0) return;
    const reapply = () => {
      if (token === renderToken && window.scrollY < scrollY) window.scrollTo(0, scrollY);
    };
    for (const img of contentEl.querySelectorAll('img')) {
      if (img.complete) continue;
      img.addEventListener('load', reapply, { once: true });
      img.addEventListener('error', reapply, { once: true });
    }
  }

  function render(payload) {
    const sameFile = payload.path === currentPath;
    // A reload of the file on screen keeps the reader where they are; a different file starts
    // wherever it was last left, or at the top when it has never been opened.
    if (!sameFile) saveScrollPosition();
    const scrollY = sameFile ? window.scrollY : readScrollPosition(payload.path);
    const token = ++renderToken;

    const { frontmatter, body } = mdlib.splitFrontmatter(payload.content);
    contentEl.innerHTML = DOMPurify.sanitize(marked.parse(body));
    addHeadingIds();
    resolveResources(payload.baseDir);
    addCopyButtons();
    // After addCopyButtons, so the front matter block gets neither a copy button nor highlighting
    // — it is a bare <pre> with no <code>, which is what highlightCode() looks for.
    if (frontmatter !== null) showFrontmatter(frontmatter);

    currentPath = payload.path;
    currentBaseDir = payload.baseDir;
    welcomeEl.hidden = true;
    contentEl.hidden = false;
    buildOutline();
    restoreScroll(scrollY, token);
    // A search that is still open was over the document that just went away: run it over this one,
    // so the count matches what is on screen. A reload keeps the reader's place in the results; a
    // different document starts at its first match, never part-way through a lap of a page the
    // reader has not seen.
    if (findOpen) runFind(!sameFile, false);
    highlightCode(token);
  }

  // ------------------------------------------------------------ links

  function scrollToAnchor(hash) {
    const id = decode(hash);
    if (!id) return;
    const target =
      document.getElementById(id) || contentEl.querySelector(`[name="${CSS.escape(id)}"]`);
    if (target) target.scrollIntoView();
  }

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    event.preventDefault();

    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) {
      scrollToAnchor(href.slice(1));
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      api.openExternal(href);
      return;
    }
    if (ABSOLUTE_URL.test(href)) return; // Any other scheme is ignored.

    const [filePart] = href.split('#');
    if (currentBaseDir && /\.(md|markdown)$/i.test(filePart)) {
      api.openPath(mdlib.resolvePath(currentBaseDir, decode(filePart)));
    }
  });

  // ------------------------------------------------------------ copy buttons
  //
  // One delegated listener, because the buttons are rebuilt with every render.

  let copiedButton = null;
  let copyTimer = null;

  function resetCopyButton() {
    if (!copiedButton) return;
    copiedButton.classList.remove('copied');
    copiedButton.textContent = 'Copy';
    copiedButton = null;
  }

  contentEl.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.copy-button') : null;
    if (!button) return;
    const code = button.parentElement.querySelector('pre code, pre');
    if (!code) return;

    api.writeClipboardText(code.innerText);

    if (copyTimer) clearTimeout(copyTimer);
    resetCopyButton();
    copiedButton = button;
    button.classList.add('copied');
    button.textContent = 'Copied';
    copyTimer = setTimeout(() => {
      copyTimer = null;
      resetCopyButton();
    }, COPY_FEEDBACK_MS);
  });

  // ------------------------------------------------------------ outline

  /** The headings the outline lists, in document order, paired with their buttons. */
  let headings = [];
  let outlineItems = [];
  let activeHeading = -1;
  let outlineOpen = false;

  function buildOutline() {
    headings = Array.from(contentEl.querySelectorAll('h1, h2, h3')).filter((h) => h.id);
    outlineItems = [];
    activeHeading = -1;
    outlineListEl.textContent = '';

    if (headings.length === 0) {
      const note = document.createElement('p');
      note.className = 'outline-empty';
      note.textContent = currentPath ? 'No headings in this document.' : 'No document open.';
      outlineListEl.appendChild(note);
      return;
    }

    for (const heading of headings) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `outline-item level-${heading.tagName.slice(1)}`;
      item.dataset.target = heading.id;
      item.textContent = (heading.textContent || '').trim();
      item.title = item.textContent;
      outlineListEl.appendChild(item);
      outlineItems.push(item);
    }
    updateActiveHeading();
  }

  /** Highlights the last heading that has scrolled past the top of the viewport. */
  function updateActiveHeading() {
    if (outlineItems.length === 0) return;
    let index = 0;
    for (let i = 0; i < headings.length; i += 1) {
      if (headings[i].getBoundingClientRect().top > ACTIVE_HEADING_OFFSET) break;
      index = i;
    }
    if (index === activeHeading) return;

    const previous = outlineItems[activeHeading];
    if (previous) {
      previous.classList.remove('active');
      previous.removeAttribute('aria-current');
    }
    activeHeading = index;
    const item = outlineItems[index];
    item.classList.add('active');
    item.setAttribute('aria-current', 'true');

    if (!outlineOpen) return; // Nothing to keep in view while the sidebar is closed.
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < outlineEl.scrollTop) outlineEl.scrollTop = top;
    else if (bottom > outlineEl.scrollTop + outlineEl.clientHeight) {
      outlineEl.scrollTop = bottom - outlineEl.clientHeight;
    }
  }

  function setOutlineOpen(open, persist) {
    outlineOpen = open;
    outlineEl.classList.toggle('open', open);
    document.body.classList.toggle('outline-open', open);
    outlineToggleEl.setAttribute('aria-pressed', String(open));
    if (persist) writeSetting('outline', open ? 'open' : 'closed');
    if (open) updateActiveHeading();
  }

  outlineListEl.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.outline-item') : null;
    if (!item) return;
    const target = document.getElementById(item.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  outlineToggleEl.addEventListener('click', () => setOutlineOpen(!outlineOpen, true));

  // ------------------------------------------------------------ content width

  const widthButtons = Array.from(toolbarEl.querySelectorAll('.segment'));

  function setWidth(name, persist) {
    const width = Object.prototype.hasOwnProperty.call(WIDTHS, name) ? name : 'default';
    document.documentElement.style.setProperty('--content-width', WIDTHS[width]);
    for (const button of widthButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.width === width));
    }
    if (persist) writeSetting('width', width);
  }

  for (const button of widthButtons) {
    button.addEventListener('click', () => setWidth(button.dataset.width, true));
  }

  // ------------------------------------------------------------ find
  //
  // The search runs here, over the rendered document and nothing else. Chromium's own
  // webContents.findInPage searches the whole page, form fields included — and with the bar open
  // the find field itself holds the query, so it counted as a match of itself: every count was one
  // too high, and one stop per lap highlighted nothing because the "match" was the search box.
  // Searching #content cannot have that problem, and the count is simply the matches found.
  //
  // Matches are painted with the CSS Custom Highlight API — ranges handed to CSS — so showing a
  // search result never inserts a wrapper element into the rendered document.

  let findTimer = null;
  let findOpen = false;
  /** One range per match, in document order, and the index of the active one. */
  let findRanges = [];
  let findIndex = 0;

  const matchHighlight = new Highlight();
  const activeHighlight = new Highlight();
  // Both highlights cover the active match; the priority is what makes the active one paint on top.
  activeHighlight.priority = 1;
  CSS.highlights.set('find-match', matchHighlight);
  CSS.highlights.set('find-active', activeHighlight);

  /** Controls the renderer injects into #content, whose labels are not part of the document. */
  const SEARCH_EXCLUDED = '.copy-button, .frontmatter > summary';

  /**
   * The document's text nodes, each with the offset it starts at, and all of them joined into one
   * string — so a match found in the text can be turned back into a range over the nodes.
   */
  function collectFindText() {
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, (node) => {
      const parent = node.parentElement;
      // Text inside a collapsed <details> — the front matter block — is in the document but not on
      // screen, and a match nothing can scroll to is exactly the dead stop this search avoids.
      if (!parent || !parent.checkVisibility()) return NodeFilter.FILTER_REJECT;
      // #content holds the app's own controls as well as the document. Their labels are not the
      // reader's text: matching them inflates the count and parks the active match on a button.
      // Anything added to #content by the renderer belongs in SEARCH_EXCLUDED.
      if (parent.closest(SEARCH_EXCLUDED)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    });
    const nodes = [];
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.nodeValue;
    }
    return { nodes, text };
  }

  /**
   * Turns text offsets back into ranges. A match can span several nodes, because a word can be
   * split by inline markup. Both lists are in document order, so the walk only moves forward.
   */
  function rangesFor(nodes, matches) {
    const ends = (index) => nodes[index].start + nodes[index].node.length;
    const ranges = [];
    let first = 0;
    for (const match of matches) {
      while (first < nodes.length - 1 && ends(first) <= match.start) first += 1;
      let last = first;
      while (last < nodes.length - 1 && ends(last) < match.end) last += 1;
      const range = document.createRange();
      range.setStart(nodes[first].node, match.start - nodes[first].start);
      range.setEnd(nodes[last].node, match.end - nodes[last].start);
      ranges.push(range);
    }
    return ranges;
  }

  function scrollMatchIntoView(range) {
    // A match inside a sideways-scrolled code block or wide table is on the page but off the side
    // of its own container, so the container has to be scrolled too. 'nearest' moves each scroll
    // parent by the least it can, which leaves the page itself alone when the match is already
    // vertically in view.
    const element = range.startContainer.parentElement;
    if (element) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const rect = range.getBoundingClientRect();
    // The toolbar and the find bar float over the top of the page, so a match up there is covered
    // rather than in view.
    if (rect.top >= FIND_TOP_CLEARANCE && rect.bottom <= window.innerHeight - 8) return;
    // A third of the way down reads better than hard against the top; scrollTo clamps the rest.
    window.scrollTo(0, window.scrollY + rect.top - window.innerHeight / 3);
  }

  /** Drops every match. The highlighting goes with them: it is those ranges. */
  function clearFind() {
    matchHighlight.clear();
    activeHighlight.clear();
    findRanges = [];
  }

  function showActiveMatch(scroll) {
    activeHighlight.clear();
    const ordinal = findRanges.length === 0 ? 0 : findIndex + 1;
    findCountEl.textContent = `${ordinal}/${findRanges.length}`;
    if (findRanges.length === 0) return;
    activeHighlight.add(findRanges[findIndex]);
    if (scroll) scrollMatchIntoView(findRanges[findIndex]);
  }

  /**
   * Searches the document as it stands now and paints the result.
   *
   * @param {boolean} fromStart Land on the first match, as typing a query does. False keeps the
   *   reader's place across a re-render of the document they are searching.
   * @param {boolean} scroll    Bring the active match into view.
   */
  function runFind(fromStart, scroll) {
    clearFind();
    const query = findInputEl.value;
    if (!query) {
      findIndex = 0;
      findCountEl.textContent = '';
      return;
    }
    const { nodes, text } = collectFindText();
    findRanges = rangesFor(nodes, mdlib.findMatches(text, query));
    for (const range of findRanges) matchHighlight.add(range);
    if (fromStart || findIndex >= findRanges.length) findIndex = 0;
    showActiveMatch(scroll);
  }

  function stepFind(forward) {
    if (findRanges.length === 0) return;
    findIndex = (findIndex + (forward ? 1 : -1) + findRanges.length) % findRanges.length;
    showActiveMatch(true);
    // Enter must keep stepping after a click on one of the arrows, so the field keeps focus.
    findInputEl.focus({ preventScroll: true });
  }

  function openFind() {
    findbarEl.classList.add('open');
    findOpen = true;
    findInputEl.focus();
    findInputEl.select();
    if (findInputEl.value) runFind(true, true);
  }

  function closeFind() {
    if (findTimer) {
      clearTimeout(findTimer);
      findTimer = null;
    }
    findbarEl.classList.remove('open');
    findOpen = false;
    findIndex = 0;
    clearFind();
    findCountEl.textContent = '';
    contentEl.focus({ preventScroll: true });
  }

  findInputEl.addEventListener('input', () => {
    if (findTimer) clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      findTimer = null;
      runFind(true, true);
    }, FIND_DEBOUNCE_MS);
  });

  document.getElementById('find-prev').addEventListener('click', () => stepFind(false));

  document.getElementById('find-next').addEventListener('click', () => stepFind(true));

  document.getElementById('find-close').addEventListener('click', () => closeFind());

  // ------------------------------------------------------------ keyboard & wheel

  // The find keys are handled here rather than on the field itself, so that Escape and Enter still
  // work while the bar is open and the reader has clicked into the document.
  window.addEventListener('keydown', (event) => {
    // The View menu owns Ctrl+F as well; whichever arrives first opens the same bar.
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
      return;
    }
    if (!findOpen) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (findTimer) {
        // Enter beat the debounce, so the query on screen has not been searched for yet: this
        // Enter runs that search rather than stepping through the previous query's matches.
        clearTimeout(findTimer);
        findTimer = null;
        runFind(true, true);
        return;
      }
      stepFind(!event.shiftKey);
    }
  });

  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      // Without this Chromium applies its own zoom on top of the one main sets.
      event.preventDefault();
      api.zoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    },
    { passive: false, capture: true }
  );

  // ------------------------------------------------------------ scroll

  let scrollFrame = 0;

  window.addEventListener(
    'scroll',
    () => {
      scheduleScrollSave();
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updateActiveHeading();
      });
    },
    { passive: true }
  );

  // The debounced save has up to SCROLL_SAVE_MS of work outstanding when the window closes.
  window.addEventListener('beforeunload', saveScrollPosition);

  // ------------------------------------------------------------ zoom toast

  let toastTimer = null;

  api.onZoomChanged((payload) => {
    toastEl.textContent = `${payload.percent}%`;
    toastEl.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastEl.classList.remove('visible');
    }, TOAST_MS);
  });

  // ------------------------------------------------------------ drag & drop

  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      document.body.classList.add('dragging');
    });
  }
  window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('dragging');
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (!file) return;
    const filePath = api.getPathForFile(file);
    if (filePath) api.openPath(filePath);
  });

  welcomeEl.addEventListener('click', () => api.openFileDialog());

  // ------------------------------------------------------------ start

  setWidth(readSetting('width', 'default'), false);
  setOutlineOpen(readSetting('outline', 'closed') === 'open', false);
  buildOutline();

  api.onFileLoaded(render);
  api.onToggleOutline(() => setOutlineOpen(!outlineOpen, true));
  api.onOpenFind(() => openFind());
})();
