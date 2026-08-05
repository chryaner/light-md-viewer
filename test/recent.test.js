'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_RECENT,
  addRecent,
  menuLabel,
  normalizeRecent,
  pruneRecent
} = require('../main/recent');

const onWindows = process.platform === 'win32';

// ---------------------------------------------------------------- addRecent

test('addRecent puts the newest file first', () => {
  assert.deepEqual(addRecent([], 'a.md'), ['a.md']);
  assert.deepEqual(addRecent(['a.md'], 'b.md'), ['b.md', 'a.md']);
});

test('addRecent moves an existing entry to the front instead of duplicating it', () => {
  assert.deepEqual(addRecent(['a.md', 'b.md', 'c.md'], 'c.md'), ['c.md', 'a.md', 'b.md']);
  assert.deepEqual(addRecent(['a.md'], 'a.md'), ['a.md']);
});

test('addRecent caps the list', () => {
  let list = [];
  for (let index = 0; index < 15; index += 1) list = addRecent(list, `file-${index}.md`);
  assert.equal(list.length, MAX_RECENT);
  assert.equal(list[0], 'file-14.md');
  assert.equal(list.at(-1), 'file-5.md');
  assert.deepEqual(addRecent(['a.md', 'b.md', 'c.md'], 'd.md', 2), ['d.md', 'a.md']);
});

test('addRecent ignores input that is not a usable path', () => {
  assert.deepEqual(addRecent(['a.md'], ''), ['a.md']);
  assert.deepEqual(addRecent(['a.md'], '   '), ['a.md']);
  assert.deepEqual(addRecent(['a.md'], null), ['a.md']);
  assert.deepEqual(addRecent(['a.md'], 42), ['a.md']);
});

test('addRecent survives a list that is not a list of paths', () => {
  assert.deepEqual(addRecent(null, 'a.md'), ['a.md']);
  assert.deepEqual(addRecent('a.md', 'b.md'), ['b.md']);
  assert.deepEqual(addRecent([1, null, '', 'a.md'], 'b.md'), ['b.md', 'a.md']);
});

test('addRecent dedupes case-insensitively on Windows', { skip: !onWindows }, () => {
  assert.deepEqual(addRecent(['C:\\Notes\\A.md'], 'c:\\notes\\a.md'), ['c:\\notes\\a.md']);
});

test('addRecent dedupes exactly on case-sensitive filesystems', { skip: onWindows }, () => {
  assert.deepEqual(addRecent(['/notes/A.md'], '/notes/a.md'), ['/notes/a.md', '/notes/A.md']);
});

// ---------------------------------------------------------------- normalizeRecent

test('normalizeRecent drops entries that are not usable paths', () => {
  assert.deepEqual(normalizeRecent(['a.md', '', 42, null, {}, '   ', 'b.md']), ['a.md', 'b.md']);
  assert.deepEqual(normalizeRecent(null), []);
  assert.deepEqual(normalizeRecent('a.md'), []);
});

test('normalizeRecent keeps the first of each duplicate and the original order', () => {
  assert.deepEqual(normalizeRecent(['a.md', 'b.md', 'a.md', 'c.md']), ['a.md', 'b.md', 'c.md']);
});

test('normalizeRecent caps the list at max', () => {
  const many = Array.from({ length: 25 }, (_, index) => `file-${index}.md`);
  assert.equal(normalizeRecent(many).length, MAX_RECENT);
  assert.equal(normalizeRecent(many)[0], 'file-0.md');
  assert.deepEqual(normalizeRecent(['a.md', 'b.md', 'c.md'], 2), ['a.md', 'b.md']);
});

test('normalizeRecent uses the same equality as addRecent', { skip: !onWindows }, () => {
  // A hand-edited settings.json must not be able to show the same file twice in the menu.
  assert.deepEqual(normalizeRecent(['C:\\Notes\\A.md', 'c:\\notes\\a.md']), ['C:\\Notes\\A.md']);
});

// ---------------------------------------------------------------- pruneRecent

test('pruneRecent keeps only the entries the predicate accepts', () => {
  const alive = new Set(['a.md', 'c.md']);
  assert.deepEqual(
    pruneRecent(['a.md', 'b.md', 'c.md'], (entry) => alive.has(entry)),
    ['a.md', 'c.md']
  );
  assert.deepEqual(
    pruneRecent(null, () => true),
    []
  );
});

// ---------------------------------------------------------------- menuLabel

test('menuLabel doubles ampersands so a path is not read as a mnemonic', () => {
  assert.equal(menuLabel('C:\\R&D\\notes.md'), 'C:\\R&&D\\notes.md');
  assert.equal(menuLabel('C:\\a&b&c.md'), 'C:\\a&&b&&c.md');
  assert.equal(menuLabel('C:\\plain\\notes.md'), 'C:\\plain\\notes.md');
});
