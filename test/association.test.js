'use strict';

// These tests never run reg.exe and never touch the registry. They pin down the exact argument
// arrays, because that is the whole security-relevant part: an argument array cannot be
// reinterpreted by a shell, and the delete list has to match the add list key for key.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');

const {
  PROG_ID,
  REG_EXE,
  buildRegisterArgs,
  buildUnregisterArgs,
  toQueryArgs
} = require('../main/association');

const EXE = 'C:\\Program Files\\Light MD Viewer\\Light MD Viewer.exe';

test('buildRegisterArgs produces exactly the six reg.exe calls, in order', () => {
  assert.deepEqual(buildRegisterArgs(EXE), [
    ['add', 'HKCU\\Software\\Classes\\LightMDViewer.md', '/ve', '/d', 'Markdown Document', '/f'],
    [
      'add',
      'HKCU\\Software\\Classes\\LightMDViewer.md',
      '/v',
      'FriendlyTypeName',
      '/d',
      'Markdown Document',
      '/f'
    ],
    [
      'add',
      'HKCU\\Software\\Classes\\LightMDViewer.md\\DefaultIcon',
      '/ve',
      '/d',
      'C:\\Program Files\\Light MD Viewer\\Light MD Viewer.exe,0',
      '/f'
    ],
    [
      'add',
      'HKCU\\Software\\Classes\\LightMDViewer.md\\shell\\open\\command',
      '/ve',
      '/d',
      '"C:\\Program Files\\Light MD Viewer\\Light MD Viewer.exe" "%1"',
      '/f'
    ],
    [
      'add',
      'HKCU\\Software\\Classes\\.md\\OpenWithProgids',
      '/v',
      'LightMDViewer.md',
      '/t',
      'REG_NONE',
      '/f'
    ],
    [
      'add',
      'HKCU\\Software\\Classes\\.markdown\\OpenWithProgids',
      '/v',
      'LightMDViewer.md',
      '/t',
      'REG_NONE',
      '/f'
    ]
  ]);
});

test('the open command quotes the executable and passes %1 as its own quoted argument', () => {
  const command = buildRegisterArgs(EXE).find((args) => args[1].endsWith('shell\\open\\command'));
  assert.equal(command[4], `"${EXE}" "%1"`);

  // A path without spaces is quoted just the same: the value is a command line, not a path.
  const plain = 'C:\\tools\\lmv.exe';
  const plainCommand = buildRegisterArgs(plain).find((args) =>
    args[1].endsWith('shell\\open\\command')
  );
  assert.equal(plainCommand[4], '"C:\\tools\\lmv.exe" "%1"');
});

test('every argument is a separate array element, never a joined command string', () => {
  for (const args of buildRegisterArgs(EXE).concat(buildUnregisterArgs())) {
    assert.ok(Array.isArray(args));
    for (const arg of args) assert.equal(typeof arg, 'string');
    // Nothing may smuggle a second reg.exe invocation into one argument.
    assert.equal(
      args.some((arg) => arg.includes('&&') || arg.includes('|') || arg.includes('\n')),
      false
    );
  }
});

test('registration only ever writes under HKEY_CURRENT_USER', () => {
  for (const args of buildRegisterArgs(EXE).concat(buildUnregisterArgs())) {
    assert.ok(args[1].startsWith('HKCU\\Software\\Classes\\'), args[1]);
  }
});

test('buildRegisterArgs refuses an empty executable path', () => {
  assert.throws(() => buildRegisterArgs(''), TypeError);
  assert.throws(() => buildRegisterArgs('   '), TypeError);
  assert.throws(() => buildRegisterArgs(undefined), TypeError);
  assert.throws(() => buildRegisterArgs(null), TypeError);
});

test('buildUnregisterArgs deletes exactly the keys and values registration created', () => {
  assert.deepEqual(buildUnregisterArgs(), [
    ['delete', 'HKCU\\Software\\Classes\\LightMDViewer.md', '/f'],
    ['delete', 'HKCU\\Software\\Classes\\.md\\OpenWithProgids', '/v', PROG_ID, '/f'],
    ['delete', 'HKCU\\Software\\Classes\\.markdown\\OpenWithProgids', '/v', PROG_ID, '/f']
  ]);
});

test('unregistering deletes the extension values by name, never the whole OpenWithProgids key', () => {
  for (const args of buildUnregisterArgs().filter((args) => args[1].includes('OpenWithProgids'))) {
    assert.deepEqual(args.slice(2), ['/v', PROG_ID, '/f']);
  }
});

test('reg.exe is named in full, so PATH cannot decide which one runs', () => {
  assert.equal(path.isAbsolute(REG_EXE), true, REG_EXE);
  assert.equal(REG_EXE.toLowerCase().endsWith('\\system32\\reg.exe'), true, REG_EXE);
});

test('toQueryArgs asks about exactly the key each delete would remove', () => {
  // Unregistering skips whatever the query says is not there, so the query has to name the same
  // key and value — anything wider would answer for a key the delete does not touch.
  assert.deepEqual(toQueryArgs(['delete', 'HKCU\\Software\\Classes\\LightMDViewer.md', '/f']), [
    'query',
    'HKCU\\Software\\Classes\\LightMDViewer.md'
  ]);
  assert.deepEqual(
    toQueryArgs(['delete', 'HKCU\\Software\\Classes\\.md\\OpenWithProgids', '/v', PROG_ID, '/f']),
    ['query', 'HKCU\\Software\\Classes\\.md\\OpenWithProgids', '/v', PROG_ID]
  );

  // It reads, never writes.
  for (const args of buildUnregisterArgs().map(toQueryArgs)) {
    assert.equal(args[0], 'query');
    assert.equal(args.includes('/f'), false);
  }
});
