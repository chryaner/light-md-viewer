'use strict';

// Everything the main process knows about turning untrusted strings into a file it will read.
// Kept free of Electron imports so it can be unit tested with plain node (see test/paths.test.js).

const fs = require('fs');
const path = require('path');

const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt'];

function hasAllowedExtension(filePath) {
  return ALLOWED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/** Returns an absolute path only if it exists, is a regular file and has an allowed extension. */
function validatePath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  let resolved;
  try {
    resolved = path.resolve(candidate);
  } catch {
    return null;
  }
  if (!hasAllowedExtension(resolved)) return null;
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/** Picks the first argument that looks like a viewable file (file association / "open with"). */
function fileArgFrom(argv) {
  // argv[0] is the executable; in dev argv[1] is the app directory, which has no allowed extension.
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    if (hasAllowedExtension(arg)) return arg;
  }
  return null;
}

module.exports = { ALLOWED_EXTENSIONS, hasAllowedExtension, validatePath, fileArgFrom };
