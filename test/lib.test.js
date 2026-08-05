'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePath,
  toFileUrl,
  slugify,
  createSlugger,
  splitFrontmatter,
  findMatches
} = require('../renderer/lib.js');

// ---------------------------------------------------------------- resolvePath

test('resolvePath joins a base directory and a relative path', () => {
  assert.equal(resolvePath('C:/docs', 'img/dot.png'), 'C:/docs/img/dot.png');
  assert.equal(resolvePath('C:/docs/', '/img/dot.png'), 'C:/docs/img/dot.png');
  assert.equal(resolvePath('C:/docs', './img/./dot.png'), 'C:/docs/img/dot.png');
});

test('resolvePath normalises backslashes to forward slashes', () => {
  assert.equal(resolvePath('C:\\docs\\sub', 'img\\dot.png'), 'C:/docs/sub/img/dot.png');
  assert.equal(resolvePath('C:\\docs\\sub', '..\\img\\dot.png'), 'C:/docs/img/dot.png');
});

test('resolvePath collapses ".." segments', () => {
  assert.equal(resolvePath('C:/docs/sub', '../dot.png'), 'C:/docs/dot.png');
  assert.equal(resolvePath('C:/docs/a/b/c', '../../x/y.md'), 'C:/docs/a/x/y.md');
  // Escaping past the root simply runs out of segments; it cannot produce a '../' prefix.
  assert.equal(resolvePath('C:/docs', '../../../x.md'), 'x.md');
});

test('resolvePath keeps UNC paths UNC', () => {
  assert.equal(resolvePath('//server/share/docs', 'dot.png'), '//server/share/docs/dot.png');
  assert.equal(resolvePath('//server/share/docs', '../img/dot.png'), '//server/share/img/dot.png');
  assert.equal(resolvePath('\\\\server\\share', 'a.md'), '//server/share/a.md');
  // A drive-letter base must not gain a UNC prefix.
  assert.ok(!resolvePath('C:/docs', 'a.md').startsWith('//'));
});

// ---------------------------------------------------------------- toFileUrl

test('toFileUrl builds a file: URL for a drive-letter path', () => {
  assert.equal(toFileUrl('C:/docs/dot.png'), 'file:///C:/docs/dot.png');
  assert.equal(toFileUrl('C:\\docs\\dot.png'), 'file:///C:/docs/dot.png');
});

test('toFileUrl percent-encodes spaces and other unsafe characters', () => {
  assert.equal(toFileUrl('C:/my docs/a b.png'), 'file:///C:/my%20docs/a%20b.png');
  assert.equal(toFileUrl('C:/docs/a#1.png'), 'file:///C:/docs/a%231.png');
  assert.equal(toFileUrl('C:/docs/a?1.png'), 'file:///C:/docs/a%3F1.png');
  assert.equal(toFileUrl('C:/docs/café.png'), 'file:///C:/docs/caf%C3%A9.png');
  // The drive colon and the separators must survive encoding.
  assert.ok(toFileUrl('C:/docs/a b.png').startsWith('file:///C:/'));
});

test('toFileUrl keeps a UNC server as the URL host', () => {
  assert.equal(toFileUrl('//server/share/dot.png'), 'file://server/share/dot.png');
  assert.equal(toFileUrl('\\\\server\\share\\a b.png'), 'file://server/share/a%20b.png');
});

// ---------------------------------------------------------------- slugify

test('slugify lowercases, trims and hyphenates', () => {
  assert.equal(slugify('Test Document'), 'test-document');
  assert.equal(slugify('  Trim   Me  '), 'trim-me');
  assert.equal(slugify('Already-Hyphenated'), 'already-hyphenated');
  assert.equal(slugify('Section 2.1'), 'section-21');
});

test('slugify drops punctuation and other non-word characters', () => {
  assert.equal(slugify('C++ & Rust!'), 'c-rust');
  assert.equal(slugify('Hello 👋 World'), 'hello-world');
});

test('slugify keeps only ASCII word characters, so non-Latin headings shrink', () => {
  // Documented consequence of the /[^\w\s-]/ filter: accents are stripped, not transliterated.
  assert.equal(slugify('Café'), 'caf');
  // Nothing usable is left; the caller must skip headings whose slug is empty.
  assert.equal(slugify('Привет'), '');
  assert.equal(slugify('日本語'), '');
});

// ---------------------------------------------------------------- createSlugger

test('createSlugger returns ids unchanged until they repeat', () => {
  const unique = createSlugger();
  assert.equal(unique('intro'), 'intro');
  assert.equal(unique('usage'), 'usage');
  assert.equal(unique('intro'), 'intro-1');
  assert.equal(unique('intro'), 'intro-2');
  assert.equal(unique('usage'), 'usage-1');
});

test('createSlugger does not hand out an id an explicit heading id already took', () => {
  const unique = createSlugger();
  assert.equal(unique('intro'), 'intro');
  assert.equal(unique('intro-1'), 'intro-1');
  assert.equal(unique('intro'), 'intro-2', 'skips the taken intro-1');
});

test('createSlugger instances are independent', () => {
  const first = createSlugger();
  const second = createSlugger();
  assert.equal(first('intro'), 'intro');
  assert.equal(second('intro'), 'intro');
});

// ---------------------------------------------------------------- splitFrontmatter

test('splitFrontmatter separates a leading block from the body', () => {
  assert.deepEqual(splitFrontmatter('---\ntitle: Notes\n---\n# Heading\n'), {
    frontmatter: 'title: Notes',
    body: '# Heading\n'
  });
  assert.deepEqual(splitFrontmatter('---\ntitle: Notes\ntags: [a, b]\n---\nBody'), {
    frontmatter: 'title: Notes\ntags: [a, b]',
    body: 'Body'
  });
});

test('splitFrontmatter reports no block when a document has none', () => {
  assert.deepEqual(splitFrontmatter('# Heading\n\nBody\n'), {
    frontmatter: null,
    body: '# Heading\n\nBody\n'
  });
  assert.deepEqual(splitFrontmatter(''), { frontmatter: null, body: '' });
  // A block has to start on the very first line.
  const late = '\n---\ntitle: Notes\n---\n';
  assert.deepEqual(splitFrontmatter(late), { frontmatter: null, body: late });
});

test('splitFrontmatter tolerates CRLF line endings', () => {
  assert.deepEqual(splitFrontmatter('---\r\ntitle: Notes\r\n---\r\nBody\r\n'), {
    frontmatter: 'title: Notes',
    body: 'Body\r\n'
  });
});

test('splitFrontmatter treats an unterminated block as body', () => {
  // A document may legitimately open with a thematic break, so an unclosed fence is Markdown.
  const hr = '---\n\nJust a rule above.\n';
  assert.deepEqual(splitFrontmatter(hr), { frontmatter: null, body: hr });
  const unclosed = '---\ntitle: Notes\n';
  assert.deepEqual(splitFrontmatter(unclosed), { frontmatter: null, body: unclosed });
  // The closing fence has to be a line of its own.
  const inline = '---\ntitle: Notes---\nBody\n';
  assert.deepEqual(splitFrontmatter(inline), { frontmatter: null, body: inline });
});

test('splitFrontmatter returns an empty string for an empty block', () => {
  assert.deepEqual(splitFrontmatter('---\n---\nBody\n'), { frontmatter: '', body: 'Body\n' });
  // A file that is nothing but an empty block still parses.
  assert.deepEqual(splitFrontmatter('---\n---'), { frontmatter: '', body: '' });
});

test('splitFrontmatter keeps the raw block, blank lines and all', () => {
  assert.deepEqual(splitFrontmatter('---\na: 1\n\nb: 2\n---\nBody'), {
    frontmatter: 'a: 1\n\nb: 2',
    body: 'Body'
  });
  // Trailing spaces after a fence are common from editors.
  assert.deepEqual(splitFrontmatter('--- \na: 1\n--- \nBody'), {
    frontmatter: 'a: 1',
    body: 'Body'
  });
});

// ---------------------------------------------------------------- findMatches

// The find bar's counter and its Enter/Shift+Enter stepping are this list: one entry per match, in
// order. An offset that is out by one highlights the wrong characters, so the offsets are asserted
// rather than just the number of matches.

const starts = (text, query) => findMatches(text, query).map((match) => match.start);

test('findMatches reports every occurrence in order', () => {
  assert.deepEqual(findMatches('a zebra and a zebra', 'zebra'), [
    { start: 2, end: 7 },
    { start: 14, end: 19 }
  ]);
});

test('findMatches is case-insensitive', () => {
  assert.deepEqual(starts('Zebra zebra ZEBRA', 'zebra'), [0, 6, 12]);
  assert.deepEqual(starts('zebra', 'ZeBrA'), [0]);
});

test('findMatches keeps case-insensitivity when a character lower-cases to a longer one', () => {
  // 'İ'.toLowerCase() is two units, which would shift every offset after it. Folding per character
  // keeps the offsets aligned.
  assert.deepEqual(starts('İstanbul and a Zebra', 'zebra'), [15]);
  assert.deepEqual(starts('İİİ then ZEBRA', 'zebra'), [9]);
  // The odd character itself stays case-sensitive; matching it literally still works.
  assert.deepEqual(starts('İstanbul', 'İ'), [0]);
});

test('findMatches offsets stay aligned around astral characters', () => {
  // An emoji is two UTF-16 units; the offsets are units, so a match after one must account for it.
  assert.deepEqual(starts('🦓 zebra', 'zebra'), [3]);
});

test('findMatches treats the query as text, never as a pattern', () => {
  // The query goes straight into a search box, so these are ordinary things to type.
  assert.deepEqual(starts('a.b and axb', 'a.b'), [0], '"." is a dot, not any character');
  assert.deepEqual(starts('c++ and c', 'c++'), [0], '"+" is a plus, not a repeat');
  assert.deepEqual(starts('(x) and x', '(x)'), [0], 'brackets are brackets');
  assert.deepEqual(starts('a|b', 'a|b'), [0]);
  assert.deepEqual(starts('50% off', '%'), [2]);
  assert.deepEqual(starts('back\\slash', '\\'), [4]);
});

test('findMatches does not overlap matches', () => {
  // 'aaaa' contains 'aa' three times if matches may overlap. Stepping through overlapping matches
  // would take the reader over the same characters twice, so the scan resumes after each match.
  assert.deepEqual(starts('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(starts('aaa', 'aa'), [0]);
});

test('findMatches finds adjacent matches', () => {
  assert.deepEqual(starts('abab', 'ab'), [0, 2]);
  assert.deepEqual(starts('xx', 'x'), [0, 1]);
});

test('findMatches finds nothing for an empty query', () => {
  assert.deepEqual(findMatches('zebra', ''), []);
  assert.deepEqual(findMatches('', ''), []);
});

test('findMatches finds nothing when the text does not contain the query', () => {
  assert.deepEqual(findMatches('zebra', 'zebu'), []);
  assert.deepEqual(findMatches('', 'zebra'), []);
  assert.deepEqual(findMatches('short', 'much longer than the text'), []);
});

test('findMatches keeps its offsets over characters that change length when lower-cased', () => {
  // 'İ'.toLowerCase() is two characters, which would push every later offset one place along.
  assert.deepEqual(findMatches('İstanbul zebra', 'zebra'), [{ start: 9, end: 14 }]);
  assert.deepEqual(findMatches('İstanbul', 'İstanbul'), [{ start: 0, end: 8 }]);
});
