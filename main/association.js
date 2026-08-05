'use strict';

// Windows "Open with" registration.
//
// Everything is written under HKEY_CURRENT_USER\Software\Classes, so this never needs
// administrator rights and never changes the machine for other users. It does NOT make the app
// the default handler — Windows only lets the user do that — it just puts the app in the
// "Open with" list for .md and .markdown.
//
// The registry is edited through reg.exe with an ARGUMENT ARRAY, never a shell string: the
// executable path is attacker-irrelevant here but it routinely contains spaces, and a command
// string would also be a standing invitation for quoting bugs.
//
// Keys touched, and nothing else:
//   HKCU\Software\Classes\LightMDViewer.md                     (default) + FriendlyTypeName
//   HKCU\Software\Classes\LightMDViewer.md\DefaultIcon         "<exe>,0"
//   HKCU\Software\Classes\LightMDViewer.md\shell\open\command  "<exe>" "%1"
//   HKCU\Software\Classes\.md\OpenWithProgids                  value LightMDViewer.md
//   HKCU\Software\Classes\.markdown\OpenWithProgids            value LightMDViewer.md

const { execFile } = require('child_process');
const path = require('path');

// Named in full rather than as 'reg.exe', which would be looked up through PATH. This is the one
// place the app starts a child process, and on a machine where a user-writable directory comes
// before System32 in PATH — installers do prepend such directories — a planted reg.exe would run
// with the user's token the moment they clicked Register.
const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

const PROG_ID = 'LightMDViewer.md';
const TYPE_NAME = 'Markdown Document';
const CLASSES_KEY = 'HKCU\\Software\\Classes';
const PROG_KEY = `${CLASSES_KEY}\\${PROG_ID}`;
const FILE_EXTENSIONS = ['.md', '.markdown'];

/**
 * The exact reg.exe invocations for registering, in order.
 * @param {string} exePath Absolute path of the executable to register.
 * @returns {string[][]} One argument array per reg.exe call.
 */
function buildRegisterArgs(exePath) {
  if (typeof exePath !== 'string' || exePath.trim() === '') {
    throw new TypeError('buildRegisterArgs: exePath must be a non-empty string');
  }
  return [
    ['add', PROG_KEY, '/ve', '/d', TYPE_NAME, '/f'],
    ['add', PROG_KEY, '/v', 'FriendlyTypeName', '/d', TYPE_NAME, '/f'],
    ['add', `${PROG_KEY}\\DefaultIcon`, '/ve', '/d', `${exePath},0`, '/f'],
    ['add', `${PROG_KEY}\\shell\\open\\command`, '/ve', '/d', `"${exePath}" "%1"`, '/f'],
    ...FILE_EXTENSIONS.map((ext) => [
      'add',
      `${CLASSES_KEY}\\${ext}\\OpenWithProgids`,
      '/v',
      PROG_ID,
      '/t',
      'REG_NONE',
      '/f'
    ])
  ];
}

/** The exact reg.exe invocations for unregistering: the ProgID key and the two list entries. */
function buildUnregisterArgs() {
  return [
    ['delete', PROG_KEY, '/f'],
    ...FILE_EXTENSIONS.map((ext) => [
      'delete',
      `${CLASSES_KEY}\\${ext}\\OpenWithProgids`,
      '/v',
      PROG_ID,
      '/f'
    ])
  ];
}

/**
 * The query that answers "is there anything here for this delete to remove?" — the same key (and
 * value name, when there is one), asked instead of changed.
 */
function toQueryArgs(deleteArgs) {
  return ['query', ...deleteArgs.slice(1).filter((arg) => arg !== '/f')];
}

function runReg(args) {
  return new Promise((resolve, reject) => {
    execFile(REG_EXE, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(true);
      const detail = String(stderr || stdout || error.message).trim();
      reject(new Error(detail || `reg.exe ${args.join(' ')} failed`));
    });
  });
}

/** Whether reg.exe accepts the command — its exit status, which no display language changes. */
function regSucceeds(args) {
  return new Promise((resolve) => {
    execFile(REG_EXE, args, { windowsHide: true }, (error) => resolve(!error));
  });
}

async function runRegCommands(argLists, { skipMissing = false } = {}) {
  for (const args of argLists) {
    // Deleting something that is already gone is success, but reg.exe reports it in the OS display
    // language, so its message cannot be matched without breaking every non-English Windows. Ask
    // first instead, and delete only what is there.
    if (skipMissing && !(await regSucceeds(toQueryArgs(args)))) continue;
    await runReg(args);
  }
  return true;
}

/** Adds the ProgID and the two "Open with" list entries. Rejects with reg.exe's own message. */
function register(exePath) {
  return runRegCommands(buildRegisterArgs(exePath));
}

/** Removes exactly what register() added. Keys that are already gone are not an error. */
function unregister() {
  return runRegCommands(buildUnregisterArgs(), { skipMissing: true });
}

module.exports = {
  CLASSES_KEY,
  FILE_EXTENSIONS,
  PROG_ID,
  PROG_KEY,
  REG_EXE,
  TYPE_NAME,
  buildRegisterArgs,
  buildUnregisterArgs,
  register,
  toQueryArgs,
  unregister
};
