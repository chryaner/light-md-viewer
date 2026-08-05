'use strict';

// A tiny JSON settings store: one file in the user data directory, read once at startup and
// written back atomically (temp file + rename) on a debounce. No npm dependencies and no schema
// library — every value is validated by hand in mergeSettings, which is also the whole story for
// a missing or corrupt file: unknown, malformed and missing values all fall back to the defaults.
//
// The file path is injected rather than read from Electron, so this module has no Electron import
// and the tests can point it at a temporary directory (see test/settings.test.js).

const fs = require('fs');
const path = require('path');

// The cap and the "same file" rule belong to the recent list, not to the file it is stored in.
const { normalizeRecent } = require('./recent');

const WRITE_DEBOUNCE_MS = 300;
const THEMES = ['system', 'light', 'dark'];

/** A fresh copy every time: callers mutate what they get back. */
function defaults() {
  return { theme: 'system', recentFiles: [], windowBounds: null };
}

/** Shape check only. Whether the position is actually on a screen is main/window-state.js's job. */
function cleanWindowBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { x, y, width, height } = value;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const bounds = { width: Math.round(width), height: Math.round(height) };
  if (Number.isFinite(x) && Number.isFinite(y)) {
    bounds.x = Math.round(x);
    bounds.y = Math.round(y);
  }
  bounds.maximized = value.maximized === true;
  return bounds;
}

/** Turns whatever was in the file into a complete, valid settings object. Never throws. */
function mergeSettings(raw) {
  const settings = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return settings;
  if (THEMES.includes(raw.theme)) settings.theme = raw.theme;
  settings.recentFiles = normalizeRecent(raw.recentFiles);
  settings.windowBounds = cleanWindowBounds(raw.windowBounds);
  return settings;
}

/** A hand-edited file can arrive with a UTF-8 byte order mark, which JSON.parse refuses. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readSettings(filePath) {
  try {
    const text = stripBom(fs.readFileSync(filePath, 'utf8'));
    return mergeSettings(JSON.parse(text));
  } catch {
    // Missing, unreadable or not JSON — all equally uninteresting, all mean "use the defaults".
    return defaults();
  }
}

/**
 * @param {string} filePath          Where settings.json lives.
 * @param {{debounceMs?: number}} [options]
 * @returns {{get: Function, set: Function, all: Function, flush: Function, filePath: string}}
 */
function createStore(filePath, options = {}) {
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : WRITE_DEBOUNCE_MS;
  const data = readSettings(filePath);
  let timer = null;
  let dirty = false;

  function writeNow() {
    const tempPath = `${filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, filePath);
      dirty = false;
      return true;
    } catch {
      // Settings are a convenience. A full disk or a locked file must never break the viewer.
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* nothing half-written to clean up */
      }
      return false;
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, debounceMs);
    // A pending write must not hold the process open; flush() covers shutdown.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    filePath,

    /** All current values, as a copy. */
    all: () => JSON.parse(JSON.stringify(data)),

    get(key, fallback) {
      return data[key] === undefined ? fallback : data[key];
    },

    /** Returns true when the value actually changed (and a write was scheduled). */
    set(key, value) {
      if (JSON.stringify(data[key]) === JSON.stringify(value)) return false;
      data[key] = value;
      dirty = true;
      schedule();
      return true;
    },

    /** Writes a pending change immediately; a no-op when nothing changed since the last write. */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return dirty ? writeNow() : true;
    }
  };
}

module.exports = { THEMES, createStore, defaults, mergeSettings };
