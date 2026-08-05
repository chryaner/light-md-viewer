'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hasAllowedExtension, validatePath, fileArgFrom } = require('../main/paths');

// Real files on disk: validatePath's whole job is answering questions about the filesystem,
// so stubbing fs would test nothing.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-md-viewer-test-'));
const noteFile = path.join(tmpDir, 'note.md');
const textFile = path.join(tmpDir, 'notes.rst');
const dirNamedLikeFile = path.join(tmpDir, 'folder.md');

fs.writeFileSync(noteFile, '# note\n', 'utf8');
fs.writeFileSync(textFile, 'not markdown\n', 'utf8');
fs.mkdirSync(dirNamedLikeFile);

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ---------------------------------------------------------------- hasAllowedExtension

test('hasAllowedExtension accepts the three viewable extensions, case-insensitively', () => {
  assert.equal(hasAllowedExtension('notes.md'), true);
  assert.equal(hasAllowedExtension('notes.markdown'), true);
  assert.equal(hasAllowedExtension('notes.txt'), true);
  assert.equal(hasAllowedExtension('C:\\docs\\README.MD'), true);
  assert.equal(hasAllowedExtension('/tmp/A.Markdown'), true);
});

test('hasAllowedExtension rejects everything else', () => {
  assert.equal(hasAllowedExtension('notes.mdx'), false);
  assert.equal(hasAllowedExtension('setup.exe'), false);
  assert.equal(hasAllowedExtension('notes.md.exe'), false, 'only the last extension counts');
  assert.equal(hasAllowedExtension('Makefile'), false);
  assert.equal(hasAllowedExtension('.md'), false, 'a dotfile has no extension');
  assert.equal(hasAllowedExtension(''), false);
});

// ---------------------------------------------------------------- fileArgFrom

test('fileArgFrom skips argv[0] and the dev app-directory argument', () => {
  // `electron . file.md` in development: argv[1] is the app directory, which has no extension.
  assert.equal(fileArgFrom(['electron.exe', '.', 'C:\\docs\\a.md']), 'C:\\docs\\a.md');
  assert.equal(
    fileArgFrom(['electron.exe', 'C:\\projects\\mdviewer', 'C:\\docs\\a.md']),
    'C:\\docs\\a.md'
  );
  // argv[0] is the executable and is never a candidate, even if it looks like one.
  assert.equal(fileArgFrom(['C:\\tools\\weird.md']), null);
});

test('fileArgFrom skips flags', () => {
  assert.equal(fileArgFrom(['electron.exe', '--smoke']), null);
  assert.equal(fileArgFrom(['electron.exe', '--smoke', 'C:\\docs\\a.md']), 'C:\\docs\\a.md');
  assert.equal(fileArgFrom(['electron.exe', '.', '--enable-logging', 'a.markdown']), 'a.markdown');
  assert.equal(fileArgFrom(['electron.exe', '--inspect=a.md']), null, 'flag values are not files');
});

test('fileArgFrom returns the first viewable argument, or null', () => {
  assert.equal(fileArgFrom(['electron.exe', 'first.md', 'second.md']), 'first.md');
  assert.equal(fileArgFrom(['electron.exe', 'image.png', 'notes.txt']), 'notes.txt');
  assert.equal(fileArgFrom(['electron.exe']), null);
  assert.equal(fileArgFrom([]), null);
});

// ---------------------------------------------------------------- validatePath

test('validatePath accepts an existing file with an allowed extension', () => {
  assert.equal(validatePath(noteFile), noteFile);
});

test('validatePath normalises the path it returns', () => {
  // Built as a raw string so path.join does not normalise it before validatePath sees it.
  assert.equal(validatePath(`${tmpDir}/./folder.md/../note.md`), noteFile);
});

test('validatePath rejects paths that do not resolve to a readable markdown file', () => {
  assert.equal(validatePath(path.join(tmpDir, 'ghost.md')), null, 'missing file');
  assert.equal(validatePath(textFile), null, 'disallowed extension');
  assert.equal(validatePath(dirNamedLikeFile), null, 'directory named like a file');
  assert.equal(validatePath(tmpDir), null, 'directory');
});

test('validatePath rejects non-string and empty input', () => {
  assert.equal(validatePath(undefined), null);
  assert.equal(validatePath(null), null);
  assert.equal(validatePath(42), null);
  assert.equal(validatePath({ path: noteFile }), null);
  assert.equal(validatePath(''), null);
  assert.equal(validatePath('   '), null);
});
