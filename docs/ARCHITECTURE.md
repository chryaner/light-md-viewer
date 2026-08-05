# Architecture

About 2,000 lines of JavaScript. No bundler, no framework, no runtime npm dependencies. marked,
DOMPurify and highlight.js are vendored as five files in `renderer/vendor/`. The packaged archive is
286 KB of application code; the ~95 MB download is Chromium, which Electron carries.

## Process model

The main process owns the disk, the menu, the window and the shell. The renderer owns the page and
nothing else: it runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`,
so page scripts have no Node and no filesystem access. The boundary sits there because the Markdown
on screen is untrusted input. The renderer gets file contents as strings and asks main for anything
that leaves the page. `preload.js` is the only crossing, and it validates nothing: main re-checks
every value it receives.

## Files

| File                   | What it is for                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`              | Window, menu wiring, file load and watch, IPC handlers, the `--smoke` flag CI boots the app with.                                            |
| `main/paths.js`        | `validatePath`, `hasAllowedExtension`, `fileArgFrom`. The only place a string becomes a file main will read.                                 |
| `main/menu.js`         | `buildMenu(deps)`. Template built from injected callbacks, no state.                                                                         |
| `main/settings.js`     | `settings.json` in `userData`: theme, recent files, window bounds. Atomic write, per-key validation on read, unknown keys dropped.           |
| `main/window-state.js` | `restoreBounds(saved, displays)`. Discards remembered bounds that no longer overlap a live display.                                          |
| `main/recent.js`       | The recent list: the cap, and what counts as the same file (case-insensitively on Windows).                                                  |
| `main/zoom.js`         | `clampZoomLevel`, `nextZoomLevel`, `zoomPercent`. The only definition of what a zoom request means.                                          |
| `main/association.js`  | Windows "Open with" registration. Builds the `reg.exe` argument arrays.                                                                      |
| `preload.js`           | The `contextBridge` exposure of `window.mdviewer`: the channels below plus `getPathForFile`.                                                 |
| `renderer/index.html`  | Page skeleton, CSP meta tag, toolbar and find bar markup, script order. highlight.js is not loaded here.                                     |
| `renderer/lib.js`      | Pure helpers: `resolvePath`, `toFileUrl`, `slugify`, `createSlugger`, `splitFrontmatter`, `findMatches`. UMD, so `node:test` can require it. |
| `renderer/renderer.js` | Render, heading ids, resource URLs, highlighting, copy buttons, outline, find, links, drag and drop, scroll restore.                         |
| `renderer/styles.css`  | Styling, the dark theme, the two `::highlight()` rules the find bar paints with, the print layout.                                           |
| `renderer/vendor/`     | marked, DOMPurify, highlight.js and its two themes. Copied out of `node_modules` by `scripts/vendor.js` and committed.                       |
| `test/`                | `node:test` suites for every module above that has no Electron import. 95 tests.                                                             |

## IPC channels

| Channel                | Direction               | Payload                      | Validation in main                                                                                                                     |
| ---------------------- | ----------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `file:loaded`          | main → renderer         | `{ path, content, baseDir }` | Outbound. Only sent for a path that already passed `validatePath`. A leading UTF-8 BOM is stripped before send.                        |
| `file:open-dialog`     | renderer → main, invoke | none                         | The path comes from the OS dialog and still goes through `validatePath`. Returns boolean.                                              |
| `file:open-path`       | renderer → main, invoke | path string                  | `validatePath`: non-empty string resolving to an existing regular file with a `.md`, `.markdown` or `.txt` extension. Returns boolean. |
| `link:open-external`   | renderer → main, invoke | URL string                   | Must parse with `new URL()` and have protocol `http:` or `https:`. Only then `shell.openExternal`. Returns boolean.                    |
| `view:zoom`            | renderer → main, invoke | number delta, or `'reset'`   | A finite number with `abs(delta) <= 5`, or `'reset'`. Anything else changes nothing. Returns the new level, clamped to `[-3, 5]`.      |
| `zoom:changed`         | main → renderer         | `{ level, percent }`         | Outbound, after every accepted zoom change from either the menu or IPC.                                                                |
| `clipboard:write-text` | renderer → main, invoke | string                       | A string of at most 1 MB. Write only, the clipboard is never read. Returns boolean.                                                    |
| `ui:toggle-outline`    | main → renderer         | none                         | Outbound: View > Toggle Outline. The renderer owns the outline UI.                                                                     |
| `ui:open-find`         | main → renderer         | none                         | Outbound: View > Find. The renderer owns the find bar.                                                                                 |

There are no other channels. `getPathForFile` is not IPC: it turns a dropped `File` into a path
with `webUtils.getPathForFile`, and that path then goes over `file:open-path`. Menu actions that
need no renderer call into `main.js` directly. Find is not a channel either. It runs in the
renderer over `#content` and paints matches with the CSS Custom Highlight API, because
`webContents.findInPage` also matched the query sitting in the find field. The comment above the
find section of `renderer.js` has the rest.

## From disk to screen

`loadFile()` in `main.js` runs the candidate through `validatePath`, reads it with `fs.readFileSync`
and strips a leading BOM. It sends `{ path, content, baseDir }` on `file:loaded`, holding it if the
renderer is not ready. `render()` in `renderer.js` splits off front matter, then assigns
`DOMPurify.sanitize(marked.parse(body))` to `#content`. In the same synchronous block it rewrites
resource URLs against `baseDir`, adds heading ids, copy buttons and the outline. Highlighting runs
after the first paint, and `fs.watch` re-runs all of it on change, debounced.

## Rules a change must not break

- The CSP meta tag in `index.html` stays as it is: `default-src 'none'`, `script-src 'self'`,
  `style-src 'self'`, `img-src file: data:`. No inline script, and nothing from the network.
- Nothing reaches `innerHTML` without passing through `DOMPurify.sanitize` first.
- Every path and every URL from the renderer is validated in main, whatever the preload did with it.
  A new channel means a new validator.
- Resource URLs are rewritten in the same synchronous block as the `innerHTML` assignment, so
  Chromium never fetches the value that arrived. Values starting with `//` or `\\` are removed:
  DOMPurify passes them, and `file://host/x.png` is an SMB fetch and an NTLM handshake with a host
  the document chose.
- No network requests at runtime. Navigation and window opening are denied in `main.js`.

## Startup

Warm launch to document on screen is 0.24 s on one Windows 11 machine. An empty Electron window
costs about 0.25 s there, so nearly all of it is Chromium starting. The portable build is 2.4 s.

highlight.js and its themes are ~130 KB that most documents never need, and auto-detecting the
language of an unlabelled fence costs about 65 ms, so `index.html` does not load them.
`loadHighlighter()` in `renderer.js` appends them once, after the first paint, the first time a
document has a code block. Code shows unhighlighted for about 80 ms, and nothing moves when the
colours land.
