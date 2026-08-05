'use strict';

// Turning remembered window bounds back into bounds it is safe to open a window with.
// The list of displays is passed in (screen.getAllDisplays()), so this module needs no Electron
// import and can be unit tested with plain objects.

const DEFAULT_BOUNDS = { width: 900, height: 800 };
const MIN_WIDTH = 420;
const MIN_HEIGHT = 320;
// Nothing sane is this big; a corrupt file must not produce a window the user cannot reach.
const MAX_SIZE = 10000;
// How much of the window has to overlap a display before the saved position is trusted. Enough
// that the title bar is grabbable — a window 2px onto the screen is as lost as one fully off it.
const MIN_VISIBLE = 48;

function size(value, fallback, min) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), MAX_SIZE);
}

/** True when the rectangle overlaps the work area of at least one of the given displays. */
function isVisibleOn(bounds, displays) {
  if (!Array.isArray(displays)) return false;
  return displays.some((display) => {
    const area = display && (display.workArea || display.bounds);
    if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y)) return false;
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/**
 * @param {object|null} saved       What was in settings (already shape-checked by settings.js).
 * @param {Array<object>} displays  screen.getAllDisplays(), or anything with workArea/bounds.
 * @param {{width: number, height: number}} [base]  Size to fall back to.
 * @returns {{x?: number, y?: number, width: number, height: number, maximized: boolean}}
 *          Omits x/y when the saved position cannot be used, which makes Electron centre it.
 */
function restoreBounds(saved, displays, base = DEFAULT_BOUNDS) {
  if (!saved || typeof saved !== 'object') {
    return { width: base.width, height: base.height, maximized: false };
  }
  const width = size(saved.width, base.width, MIN_WIDTH);
  const height = size(saved.height, base.height, MIN_HEIGHT);
  const maximized = saved.maximized === true;
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { width, height, maximized };

  // A monitor that has been unplugged, or a resolution change, can leave the old position
  // outside every screen. Drop the position and keep the size.
  const placed = { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
  if (!isVisibleOn(placed, displays)) return { width, height, maximized };
  return { ...placed, maximized };
}

module.exports = {
  DEFAULT_BOUNDS,
  MIN_HEIGHT,
  MIN_VISIBLE,
  MIN_WIDTH,
  isVisibleOn,
  restoreBounds
};
