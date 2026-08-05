'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_BOUNDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  isVisibleOn,
  restoreBounds
} = require('../main/window-state');

// Shaped like Electron's Display objects, with only the parts restoreBounds looks at.
const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondLeft = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
const displays = [primary, secondLeft];

const saved = { x: 100, y: 100, width: 1000, height: 700, maximized: false };

// ---------------------------------------------------------------- isVisibleOn

test('isVisibleOn accepts a window that overlaps a display generously', () => {
  assert.equal(isVisibleOn({ x: 0, y: 0, width: 800, height: 600 }, displays), true);
  assert.equal(isVisibleOn({ x: -1900, y: 10, width: 800, height: 600 }, displays), true);
});

test('isVisibleOn rejects a window that is off every display or barely touching', () => {
  assert.equal(isVisibleOn({ x: 5000, y: 0, width: 800, height: 600 }, displays), false);
  assert.equal(isVisibleOn({ x: 0, y: -4000, width: 800, height: 600 }, displays), false);
  // Ten pixels of overlap is not a window anyone can grab.
  assert.equal(isVisibleOn({ x: 1910, y: 0, width: 800, height: 600 }, displays), false);
  assert.equal(isVisibleOn({ x: 0, y: 0, width: 800, height: 600 }, []), false);
  assert.equal(isVisibleOn({ x: 0, y: 0, width: 800, height: 600 }, null), false);
});

test('isVisibleOn ignores displays it cannot make sense of', () => {
  assert.equal(isVisibleOn({ x: 0, y: 0, width: 800, height: 600 }, [null, {}, 7]), false);
  // A Display without workArea still has bounds.
  const boundsOnly = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.equal(isVisibleOn({ x: 0, y: 0, width: 800, height: 600 }, boundsOnly), true);
});

// ---------------------------------------------------------------- restoreBounds

test('restoreBounds returns the defaults when nothing was saved', () => {
  const expected = { width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height, maximized: false };
  assert.deepEqual(restoreBounds(null, displays), expected);
  assert.deepEqual(restoreBounds(undefined, displays), expected);
  assert.deepEqual(restoreBounds('900x800', displays), expected);
});

test('restoreBounds keeps a saved rectangle that is still on a display', () => {
  assert.deepEqual(restoreBounds(saved, displays), {
    x: 100,
    y: 100,
    width: 1000,
    height: 700,
    maximized: false
  });
  // Negative coordinates are normal on a monitor arranged to the left of the primary one.
  assert.deepEqual(restoreBounds({ ...saved, x: -1800 }, displays), {
    x: -1800,
    y: 100,
    width: 1000,
    height: 700,
    maximized: false
  });
});

test('restoreBounds drops a position that no current display can show, keeping the size', () => {
  assert.deepEqual(restoreBounds({ ...saved, x: 4000, y: 2000 }, [primary]), {
    width: 1000,
    height: 700,
    maximized: false
  });
  // The same rectangle is fine again once that second monitor is plugged back in.
  assert.deepEqual(restoreBounds({ ...saved, x: -1800 }, [primary]), {
    width: 1000,
    height: 700,
    maximized: false
  });
});

test('restoreBounds keeps the size when the position is incomplete or unusable', () => {
  for (const partial of [{}, { x: 10 }, { y: 10 }, { x: NaN, y: 10 }, { x: '10', y: '10' }]) {
    assert.deepEqual(restoreBounds({ ...partial, width: 1000, height: 700 }, displays), {
      width: 1000,
      height: 700,
      maximized: false
    });
  }
});

test('restoreBounds clamps absurd or tiny sizes and rounds fractions', () => {
  assert.deepEqual(restoreBounds({ width: 10, height: 10 }, displays), {
    width: MIN_WIDTH,
    height: MIN_HEIGHT,
    maximized: false
  });
  assert.equal(restoreBounds({ width: 1e9, height: 1e9 }, displays).width, 10000);
  assert.equal(restoreBounds({ width: 900.6, height: 700.2 }, displays).height, 700);
  assert.equal(restoreBounds({ width: 'wide', height: 700 }, displays).width, DEFAULT_BOUNDS.width);
});

test('restoreBounds carries the maximized flag through every path', () => {
  assert.equal(restoreBounds({ ...saved, maximized: true }, displays).maximized, true);
  assert.equal(restoreBounds({ ...saved, x: 9000, maximized: true }, displays).maximized, true);
  assert.equal(restoreBounds({ width: 800, height: 600, maximized: 1 }, displays).maximized, false);
});

test('restoreBounds accepts a caller-supplied default size', () => {
  assert.deepEqual(restoreBounds(null, displays, { width: 640, height: 480 }), {
    width: 640,
    height: 480,
    maximized: false
  });
});
