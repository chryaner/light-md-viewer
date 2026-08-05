'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ZOOM_MAX, ZOOM_MIN, clampZoomLevel, nextZoomLevel, zoomPercent } = require('../main/zoom');

test('clampZoomLevel keeps the level inside the supported range', () => {
  assert.equal(clampZoomLevel(0), 0);
  assert.equal(clampZoomLevel(2.5), 2.5);
  assert.equal(clampZoomLevel(99), ZOOM_MAX);
  assert.equal(clampZoomLevel(-99), ZOOM_MIN);
});

test('clampZoomLevel treats an unusable level as 100%', () => {
  assert.equal(clampZoomLevel(NaN), 0);
  assert.equal(clampZoomLevel(Infinity), 0);
  assert.equal(clampZoomLevel('2'), 0);
  assert.equal(clampZoomLevel(undefined), 0);
});

test("nextZoomLevel applies a delta and answers 'reset' with 100%", () => {
  assert.equal(nextZoomLevel(0, 0.5), 0.5);
  assert.equal(nextZoomLevel(1, -0.5), 0.5);
  assert.equal(nextZoomLevel(3, 'reset'), 0);
  assert.equal(nextZoomLevel(0, 0), 0);
});

test('nextZoomLevel clamps the result at both ends', () => {
  assert.equal(nextZoomLevel(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(nextZoomLevel(ZOOM_MIN, -1), ZOOM_MIN);
  assert.equal(nextZoomLevel(4.75, 0.5), ZOOM_MAX);
  // A level that somehow escaped the range is pulled back in before the delta is applied.
  assert.equal(nextZoomLevel(100, -0.5), ZOOM_MAX - 0.5);
});

test('nextZoomLevel rejects anything that is not a small finite delta', () => {
  assert.equal(nextZoomLevel(0, 'in'), null);
  assert.equal(nextZoomLevel(0, NaN), null);
  assert.equal(nextZoomLevel(0, Infinity), null);
  assert.equal(nextZoomLevel(0, 6), null, 'delta larger than the accepted 5');
  assert.equal(nextZoomLevel(0, -6), null);
  assert.equal(nextZoomLevel(0, null), null);
  assert.equal(nextZoomLevel(0, { delta: 1 }), null);
  assert.equal(nextZoomLevel(0, '0.5'), null);
  assert.equal(nextZoomLevel(0, 5), ZOOM_MAX, 'the boundary itself is accepted');
});

test('zoomPercent reports the Chromium 1.2^level scale', () => {
  assert.equal(zoomPercent(0), 100);
  assert.equal(zoomPercent(1), 120);
  assert.equal(zoomPercent(-1), 83);
  assert.equal(zoomPercent(ZOOM_MAX), 249);
  assert.equal(zoomPercent(ZOOM_MIN), 58);
  assert.equal(zoomPercent(NaN), 100);
});
