# Contributing

Plain JavaScript. No bundler, no framework, no TypeScript, no runtime dependencies in the app that
ships. Please keep it that way.

## Setup

```
git clone https://github.com/chryaner/light-md-viewer.git
cd light-md-viewer
npm install
npm start
```

Node.js 22 and npm, on Windows. That is what CI runs. Open a file while developing with
`npx electron . path\to\file.md`.

## Scripts

| Script           | What it does                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`      | Runs the app from source.                                                                                                              |
| `npm run vendor` | Copies marked, DOMPurify and highlight.js into `renderer/vendor/`, which is committed. Only needed after changing the pinned versions. |
| `npm run lint`   | ESLint, then `prettier --check`. `lint:fix` runs both and rewrites what it can. `renderer/vendor/` is third-party and is never linted. |
| `npm test`       | Node's test runner over `test/`.                                                                                                       |
| `npm run build`  | Builds the installer and the portable `.exe` into `dist/`.                                                                             |
| `npm run scan`   | Hashes and virus-scans whatever is in `dist/`.                                                                                         |

## Pull requests

- Run `npm run lint` and `npm test` before opening one. CI runs both, plus a smoke boot.
- One change per PR. Say how you checked it by hand, since most of this app is visual.
- Add or update tests when you touch a unit-tested module in `main/` or `renderer/lib.js`.
- Add a `CHANGELOG.md` entry under `Unreleased` for anything a user would notice.

## Scope

This is a read-only viewer for one file. Editing, tabs, a file tree, plugins and anything that uses
the network are out. Open an issue before building something large.
