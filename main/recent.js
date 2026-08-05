'use strict';

// The recent-files list: most recent first, no duplicates, capped. Pure list handling — the
// caller supplies the paths (already resolved by main/paths.js) and decides where to store them.

const MAX_RECENT = 10;

function toList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
}

/** Windows paths are case-insensitive, so C:\A.md and c:\a.md are the same recent entry. */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The list invariants in one place: strings only, no duplicates (see samePath), capped at max,
 * order preserved. Applied both when a file is opened and when a stored list is read back, so a
 * hand-edited settings.json cannot produce a list addRecent would never have built.
 */
function normalizeRecent(list, max = MAX_RECENT) {
  const out = [];
  for (const entry of toList(list)) {
    if (out.some((kept) => samePath(kept, entry))) continue;
    out.push(entry);
    if (out.length === max) break;
  }
  return out;
}

/** Returns a new list with filePath at the front, its previous entry removed, capped at max. */
function addRecent(list, filePath, max = MAX_RECENT) {
  const usable = typeof filePath === 'string' && filePath.trim() !== '';
  return normalizeRecent(usable ? [filePath, ...toList(list)] : list, max);
}

/** Drops entries the predicate rejects — used to hide files that have since been deleted. */
function pruneRecent(list, exists) {
  return toList(list).filter((entry) => exists(entry));
}

/** '&' starts a mnemonic in a Windows menu, so a path containing one has to double it. */
function menuLabel(filePath) {
  return String(filePath).replace(/&/g, '&&');
}

module.exports = { MAX_RECENT, addRecent, menuLabel, normalizeRecent, pruneRecent, samePath };
