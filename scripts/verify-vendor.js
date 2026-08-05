'use strict';

// Verifies that the committed files in renderer/vendor/ are byte-for-byte identical to the
// files the pinned npm packages ship.
//
// renderer/vendor/ is committed to this repository and two of its files are minified, so no
// reviewer can tell by eye whether they are really what marked, DOMPurify and highlight.js
// publish. This compares every vendored file with the copy npm installed, prints the SHA-256
// of both, and exits 1 if any of them differ.
//
// Zero dependencies. Run `npm install` (or `npm ci`) first, then:
//   node scripts/verify-vendor.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'renderer', 'vendor');
const NODE_MODULES = path.join(ROOT, 'node_modules');

// The files scripts/vendor.js copies, as a package name plus the path inside that package.
// Keep this list in step with that one: a file vendored there but missing here is reported
// as unexpected rather than silently trusted.
const FILES = [
  { pkg: 'marked', source: 'lib/marked.umd.js', name: 'marked.umd.js' },
  { pkg: 'dompurify', source: 'dist/purify.min.js', name: 'purify.min.js' },
  { pkg: '@highlightjs/cdn-assets', source: 'highlight.min.js', name: 'highlight.min.js' },
  { pkg: '@highlightjs/cdn-assets', source: 'styles/github.min.css', name: 'github.min.css' },
  {
    pkg: '@highlightjs/cdn-assets',
    source: 'styles/github-dark.min.css',
    name: 'github-dark.min.css'
  }
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formatSize(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

function packageVersion(pkg) {
  try {
    const manifest = path.join(NODE_MODULES, pkg, 'package.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
}

function check(entry) {
  const installedPath = path.join(NODE_MODULES, entry.pkg, ...entry.source.split('/'));
  const committedPath = path.join(VENDOR_DIR, entry.name);
  const version = packageVersion(entry.pkg);
  const result = {
    name: entry.name,
    package: `${entry.pkg}@${version || 'version unknown'}`,
    installedPath,
    committedPath
  };

  if (!fs.existsSync(installedPath)) return { ...result, status: 'missing-source' };
  if (!fs.existsSync(committedPath)) return { ...result, status: 'missing-vendored' };

  const installed = fs.readFileSync(installedPath);
  const committed = fs.readFileSync(committedPath);

  return {
    ...result,
    status: installed.equals(committed) ? 'ok' : 'mismatch',
    installed: { sha256: sha256(installed), size: installed.length },
    committed: { sha256: sha256(committed), size: committed.length }
  };
}

function print(result) {
  const name = result.name.padEnd(20);
  const pkg = result.package.padEnd(32);

  if (result.status === 'ok') {
    console.log(
      `  OK        ${name} ${pkg} sha256 ${result.committed.sha256} ` +
        `(${formatSize(result.committed.size)})`
    );
    return;
  }
  if (result.status === 'missing-source') {
    console.log(`  MISSING   ${name} ${pkg} not installed: ${result.installedPath}`);
    return;
  }
  if (result.status === 'missing-vendored') {
    console.log(`  MISSING   ${name} ${pkg} not committed: ${result.committedPath}`);
    return;
  }
  console.log(`  MISMATCH  ${name} ${pkg} contents differ`);
  console.log(
    `              committed     sha256 ${result.committed.sha256} ` +
      `(${formatSize(result.committed.size)})`
  );
  console.log(
    `              node_modules  sha256 ${result.installed.sha256} ` +
      `(${formatSize(result.installed.size)})`
  );
}

function main() {
  console.log(
    `verify-vendor: comparing renderer/vendor/ with node_modules/ (${FILES.length} files)`
  );
  console.log('');

  const results = FILES.map(check);
  for (const result of results) print(result);

  // A file in renderer/vendor/ that scripts/vendor.js does not produce came from somewhere
  // else, so this check cannot vouch for it.
  const expected = new Set(FILES.map((file) => file.name));
  const extras = fs.existsSync(VENDOR_DIR)
    ? fs.readdirSync(VENDOR_DIR).filter((name) => !expected.has(name))
    : [];
  for (const name of extras) {
    console.log(`  UNKNOWN   ${name.padEnd(20)} ${''.padEnd(32)} not copied by scripts/vendor.js`);
  }

  console.log('');

  const bad = results.filter((result) => result.status !== 'ok');
  if (bad.length === 0 && extras.length === 0) {
    console.log(
      `verify-vendor: OK — all ${results.length} vendored files match the packages they came from.`
    );
    process.exit(0);
  }

  console.error(
    `verify-vendor: FAILED — ${bad.length + extras.length} of ${results.length + extras.length} ` +
      'files could not be verified:'
  );
  for (const result of bad) {
    const reason = {
      mismatch: `differs from ${result.package}`,
      'missing-source': `${result.package} is not installed — run \`npm ci\``,
      'missing-vendored': 'is missing from renderer/vendor/'
    }[result.status];
    console.error(`  ${result.name} ${reason}`);
  }
  for (const name of extras) {
    console.error(`  ${name} is in renderer/vendor/ but nothing vendors it`);
  }
  console.error('');
  console.error(
    'If the change was intended, run `npm ci && npm run vendor` and commit the result.'
  );
  process.exit(1);
}

main();
