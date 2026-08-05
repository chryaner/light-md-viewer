'use strict';

// Copies the browser builds of the runtime libraries into renderer/vendor/ so the packaged
// app can ship without node_modules. Zero dependencies; run via `npm run vendor` after install.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'renderer', 'vendor');
const HLJS_DIR = path.join(ROOT, 'node_modules', '@highlightjs', 'cdn-assets');

const FILES = [
  // marked dropped its minified UMD bundle in v16; lib/marked.umd.js is the browser build.
  { from: path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), to: 'marked.umd.js' },
  {
    from: path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.min.js'),
    to: 'purify.min.js'
  },
  { from: path.join(HLJS_DIR, 'highlight.min.js'), to: 'highlight.min.js' },
  { from: path.join(HLJS_DIR, 'styles', 'github.min.css'), to: 'github.min.css' },
  { from: path.join(HLJS_DIR, 'styles', 'github-dark.min.css'), to: 'github-dark.min.css' }
];

const missing = FILES.filter((f) => !fs.existsSync(f.from));
if (missing.length > 0) {
  for (const f of missing) console.error(`vendor: missing source ${f.from}`);
  console.error('vendor: run `npm install` first.');
  process.exit(1);
}

fs.mkdirSync(VENDOR_DIR, { recursive: true });

for (const file of FILES) {
  const dest = path.join(VENDOR_DIR, file.to);
  fs.copyFileSync(file.from, dest);
  console.log(`vendor: ${path.relative(ROOT, file.from)} -> ${path.relative(ROOT, dest)}`);
}
