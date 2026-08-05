'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, defaults, mergeSettings } = require('../main/settings');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-md-viewer-settings-'));
let counter = 0;

/** A fresh settings path per test, optionally seeded with raw file content. */
function storePath(contents) {
  const file = path.join(tmpDir, `settings-${counter++}.json`);
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ---------------------------------------------------------------- mergeSettings

test('mergeSettings returns the defaults for anything that is not an object', () => {
  for (const raw of [undefined, null, 0, 'settings', [], true]) {
    assert.deepEqual(mergeSettings(raw), defaults(), `input: ${JSON.stringify(raw)}`);
  }
});

test('mergeSettings keeps known values and drops unknown keys', () => {
  const merged = mergeSettings({
    theme: 'dark',
    recentFiles: ['C:\\a.md'],
    windowBounds: { x: 10, y: 20, width: 800, height: 600, maximized: true },
    telemetryEndpoint: 'https://example.com'
  });
  assert.deepEqual(merged, {
    theme: 'dark',
    recentFiles: ['C:\\a.md'],
    windowBounds: { width: 800, height: 600, x: 10, y: 20, maximized: true }
  });
  assert.equal('telemetryEndpoint' in merged, false);
});

test('mergeSettings falls back per key, so one bad value does not lose the others', () => {
  const merged = mergeSettings({ theme: 'neon', recentFiles: 'C:\\a.md', windowBounds: 42 });
  assert.deepEqual(merged, defaults());

  const partial = mergeSettings({ theme: 'light' });
  assert.equal(partial.theme, 'light');
  assert.deepEqual(partial.recentFiles, []);
  assert.equal(partial.windowBounds, null);
});

test('mergeSettings cleans the recent list: strings only, deduped, capped at ten', () => {
  const raw = ['a.md', '', 42, null, 'a.md', 'b.md', {}, '   '];
  assert.deepEqual(mergeSettings({ recentFiles: raw }).recentFiles, ['a.md', 'b.md']);

  const many = Array.from({ length: 25 }, (_, index) => `file-${index}.md`);
  assert.equal(mergeSettings({ recentFiles: many }).recentFiles.length, 10);
  assert.equal(mergeSettings({ recentFiles: many }).recentFiles[0], 'file-0.md');
});

test('mergeSettings requires a usable size on window bounds and rounds what it keeps', () => {
  assert.equal(mergeSettings({ windowBounds: { x: 1, y: 2 } }).windowBounds, null);
  assert.equal(mergeSettings({ windowBounds: { width: '800', height: 600 } }).windowBounds, null);
  assert.equal(mergeSettings({ windowBounds: { width: NaN, height: 600 } }).windowBounds, null);
  assert.deepEqual(mergeSettings({ windowBounds: { width: 800.4, height: 600.6 } }).windowBounds, {
    width: 800,
    height: 601,
    maximized: false
  });
  // A position is all-or-nothing: half a position is no position.
  assert.deepEqual(
    mergeSettings({ windowBounds: { width: 800, height: 600, x: 5 } }).windowBounds,
    {
      width: 800,
      height: 600,
      maximized: false
    }
  );
});

test('mergeSettings treats a non-boolean maximized as not maximized', () => {
  const bounds = { width: 800, height: 600, maximized: 'yes' };
  assert.equal(mergeSettings({ windowBounds: bounds }).windowBounds.maximized, false);
});

// ---------------------------------------------------------------- loading

test('createStore tolerates a missing file', () => {
  const store = createStore(storePath());
  assert.deepEqual(store.all(), defaults());
});

test('createStore tolerates a corrupt file', () => {
  for (const contents of ['', '{', 'null', '"nope"', '[1,2,3]', '\u0000\u0001']) {
    const store = createStore(storePath(contents));
    assert.deepEqual(store.all(), defaults(), `contents: ${JSON.stringify(contents)}`);
  }
});

test('createStore reads a file saved with a UTF-8 byte order mark', () => {
  // Windows editors still offer "UTF-8 with BOM"; JSON.parse refuses it outright.
  const file = storePath('\uFEFF' + JSON.stringify({ theme: 'light' }));
  assert.equal(createStore(file).get('theme'), 'light');
});

test('createStore tolerates a directory where the file should be', () => {
  const file = path.join(tmpDir, `dir-settings-${counter++}.json`);
  fs.mkdirSync(file);
  assert.deepEqual(createStore(file).all(), defaults());
});

test('createStore reads a valid file', () => {
  const file = storePath(JSON.stringify({ theme: 'dark', recentFiles: ['x.md'] }));
  const store = createStore(file);
  assert.equal(store.get('theme'), 'dark');
  assert.deepEqual(store.get('recentFiles'), ['x.md']);
});

// ---------------------------------------------------------------- get / set / flush

test('get returns the fallback only for keys the store does not know', () => {
  const store = createStore(storePath());
  assert.equal(store.get('theme', 'dark'), 'system', 'a known key wins over the fallback');
  assert.equal(store.get('outlineWidth', 240), 240);
  assert.equal(store.get('outlineWidth'), undefined);
});

test('set reports whether the value actually changed', () => {
  const store = createStore(storePath());
  assert.equal(store.set('theme', 'dark'), true);
  assert.equal(store.set('theme', 'dark'), false, 'same value again');
  assert.equal(store.set('recentFiles', []), false, 'deep-equal array');
  assert.equal(store.set('recentFiles', ['a.md']), true);
});

test('flush writes the file atomically and leaves no temp file behind', () => {
  const file = storePath();
  const store = createStore(file, { debounceMs: 5000 });
  store.set('theme', 'light');
  assert.equal(fs.existsSync(file), false, 'the write is debounced, not immediate');
  assert.equal(store.flush(), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    theme: 'light',
    recentFiles: [],
    windowBounds: null
  });
});

test('a store reloads what the previous store wrote', () => {
  const file = storePath();
  const first = createStore(file, { debounceMs: 5000 });
  first.set('recentFiles', ['C:\\notes\\a.md', 'C:\\notes\\b.md']);
  first.set('windowBounds', { x: 1, y: 2, width: 640, height: 480, maximized: false });
  first.flush();

  const second = createStore(file);
  assert.deepEqual(second.get('recentFiles'), ['C:\\notes\\a.md', 'C:\\notes\\b.md']);
  assert.deepEqual(second.get('windowBounds'), {
    width: 640,
    height: 480,
    x: 1,
    y: 2,
    maximized: false
  });
});

test('flush creates the settings directory when it does not exist yet', () => {
  const file = path.join(tmpDir, `nested-${counter++}`, 'deeper', 'settings.json');
  const store = createStore(file, { debounceMs: 5000 });
  store.set('theme', 'dark');
  assert.equal(store.flush(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark');
});

test('flush is a no-op when nothing changed', () => {
  const file = storePath();
  const store = createStore(file, { debounceMs: 5000 });
  assert.equal(store.flush(), true);
  assert.equal(fs.existsSync(file), false, 'an unchanged store writes nothing');
});

test('all() hands out a copy, so callers cannot mutate the store behind its back', () => {
  const store = createStore(storePath());
  const snapshot = store.all();
  snapshot.recentFiles.push('sneaky.md');
  snapshot.theme = 'dark';
  assert.deepEqual(store.get('recentFiles'), []);
  assert.equal(store.get('theme'), 'system');
});

test('a debounced write lands without an explicit flush', async () => {
  const file = storePath();
  const store = createStore(file, { debounceMs: 1 });
  store.set('theme', 'dark');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'dark');
});
