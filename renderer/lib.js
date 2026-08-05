'use strict';

// Pure helpers shared by the renderer. The renderer has no Node access, so the path handling
// here is hand-rolled (paths arrive as plain strings from the main process).
//
// Loaded both as a plain <script> (exports on window.mdlib) and by node:test (module.exports),
// so it must not touch the DOM or require anything.

(function (exports) {
  /**
   * Joins a base directory and a relative path, collapsing '.' and '..' and normalising
   * backslashes. Keeps a leading '//' so UNC paths stay UNC.
   */
  function resolvePath(baseDir, relative) {
    const unc = /^[\\/]{2}/.test(baseDir) ? '//' : '';
    const segments = String(baseDir)
      .replace(/\\/g, '/')
      .split('/')
      .concat(String(relative).replace(/\\/g, '/').split('/'));
    const out = [];
    for (const segment of segments) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') out.pop();
      else out.push(segment);
    }
    return unc + out.join('/');
  }

  /** Turns an absolute Windows path into a file: URL the renderer can put in an <img src>. */
  function toFileUrl(absolutePath) {
    // encodeURI keeps ':' and '/' intact, so 'C:/dir/a b.png' becomes 'C:/dir/a%20b.png'.
    const normalized = absolutePath.replace(/\\/g, '/');
    const escaped = encodeURI(normalized.replace(/^\/+/, ''))
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
    // A UNC path keeps its server as the URL host: '//srv/share/a.png' -> 'file://srv/share/a.png'.
    // Dropping it would produce 'file:///srv/...', a local path that does not exist.
    return (/^\/{2}[^/]/.test(normalized) ? 'file://' : 'file:///') + escaped;
  }

  /** Heading text -> anchor id. Returns '' when nothing usable is left (e.g. non-Latin text). */
  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }

  /**
   * Returns a function that hands out document-unique ids, appending '-1', '-2', … to
   * repeats. One slugger per render; ids are only unique within the document it walked.
   */
  function createSlugger() {
    const used = new Set();
    return function unique(id) {
      let candidate = id;
      let n = 1;
      while (used.has(candidate)) candidate = `${id}-${n++}`;
      used.add(candidate);
      return candidate;
    };
  }

  // A leading '---' line, the block, and a closing '---' line. The block is captured with its
  // trailing newline so that the closing fence can only match at the start of a line — without
  // that, '---\nnot front matter---\n' would look like a terminated block.
  const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

  /**
   * Splits a leading YAML-style front matter block off a document. Only a block that starts on
   * the very first line counts, and only a terminated one: an unclosed '---' is ordinary Markdown
   * (a document may legitimately open with a thematic break).
   *
   * @returns {{frontmatter: string|null, body: string}} The raw block without its fences (null
   *   when there is none), and the Markdown that follows it.
   */
  function splitFrontmatter(text) {
    const source = String(text);
    const match = FRONTMATTER.exec(source);
    if (!match) return { frontmatter: null, body: source };
    return {
      frontmatter: (match[1] || '').replace(/\r?\n$/, ''),
      body: source.slice(match[0].length)
    };
  }

  /**
   * Lower-cases without moving anything: a few characters lower-case to more than one unit ('İ'
   * becomes 'i' plus a combining dot), which would shift every offset after them onto the wrong
   * characters. Those characters are left as they are, so only they stay case-sensitive — folding
   * the whole document case-sensitively because of one of them is a worse trade.
   */
  function foldCase(text) {
    let folded = '';
    for (const character of text) {
      const lower = character.toLowerCase();
      folded += lower.length === character.length ? lower : character;
    }
    return folded;
  }

  /**
   * Every place `query` occurs in `text`, case-insensitively, as offsets into `text`.
   *
   * Plain text only: nothing here is a pattern, so 'a.b', 'c++' and '(x)' search for exactly those
   * characters. Matches never overlap — the scan resumes after the one it just found, so 'aa' in
   * 'aaaa' is two matches, which is what stepping through them with Enter should visit.
   *
   * @param {string} query Text to search for. An empty query matches nothing.
   * @returns {Array<{start: number, end: number}>} Matches in ascending order of `start`.
   */
  function findMatches(text, query) {
    const matches = [];
    if (!query) return matches;
    const haystack = foldCase(text);
    const needle = foldCase(query);

    let at = haystack.indexOf(needle);
    while (at !== -1) {
      matches.push({ start: at, end: at + needle.length });
      at = haystack.indexOf(needle, at + needle.length);
    }
    return matches;
  }

  exports.resolvePath = resolvePath;
  exports.toFileUrl = toFileUrl;
  exports.slugify = slugify;
  exports.createSlugger = createSlugger;
  exports.splitFrontmatter = splitFrontmatter;
  exports.findMatches = findMatches;
})(typeof module !== 'undefined' ? module.exports : (window.mdlib = {}));
