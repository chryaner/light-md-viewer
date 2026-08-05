'use strict';

// The one place that decides what a zoom request means. Both the View menu and the 'view:zoom'
// IPC channel go through nextZoomLevel, so they cannot drift apart.
//
// Chromium's zoom level is exponential: factor = 1.2 ^ level. Level 0 is 100%, the range below
// keeps the page between roughly 58% and 250%.

const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.5;
// Bound on a single request, so one bad number from the renderer cannot slam zoom to a limit.
const MAX_DELTA = 5;

function clampZoomLevel(level) {
  if (!Number.isFinite(level)) return 0;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
}

/**
 * @param {number} current  Current webContents.zoomLevel.
 * @param {number|'reset'} request  A delta, or the string 'reset' for 100%.
 * @returns {number|null}   The new level, or null when the request is not one we accept.
 */
function nextZoomLevel(current, request) {
  if (request === 'reset') return 0;
  if (typeof request !== 'number' || !Number.isFinite(request)) return null;
  if (Math.abs(request) > MAX_DELTA) return null;
  return clampZoomLevel(clampZoomLevel(current) + request);
}

/** The level as a percentage, for display: level 0 → 100. */
function zoomPercent(level) {
  return Math.round(Math.pow(1.2, clampZoomLevel(level)) * 100);
}

module.exports = {
  MAX_DELTA,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoomLevel,
  nextZoomLevel,
  zoomPercent
};
