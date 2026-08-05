'use strict';

// Builds build/icon.ico from the two SVGs beside it, and docs/icon.png for the README.
//
// Two sources, not one: at 16 px a Windows icon is a silhouette, and the down arrow beside the M
// collapses into a smudge. Sizes up to 32 px use icon-small.svg, which drops the arrow and lets
// the M fill the badge; larger sizes use icon.svg, which says "markdown" rather than "M".
//
// Rasterising runs in Electron because Chromium is the only SVG renderer this project already
// depends on. Drawing to a canvas rather than capturing the window keeps it headless: a window
// that is never shown never paints, so capturePage() would hang.
//
//   npm run icon

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SMALL = path.join(ROOT, 'build', 'icon-small.svg');
const LARGE = path.join(ROOT, 'build', 'icon.svg');
const ICO = path.join(ROOT, 'build', 'icon.ico');
const PNG = path.join(ROOT, 'docs', 'icon.png');

// Every size Windows asks for, from the taskbar to the extra-large Explorer view.
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const SIMPLIFY_UP_TO = 32;

function rasterise(svg, size) {
  return `
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${size};
        canvas.height = ${size};
        canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('could not load the SVG'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    })`;
}

/**
 * An ICO is a 6-byte header, one 16-byte directory entry per image, then the images. Each image
 * here is a PNG, which Windows has accepted since Vista and which keeps the alpha channel
 * without the AND-mask a BMP entry would need.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size, 0 for truecolour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  const small = fs.readFileSync(SMALL, 'utf8');
  const large = fs.readFileSync(LARGE, 'utf8');
  const win = new BrowserWindow({ show: false, width: 320, height: 320 });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const images = [];
  for (const size of SIZES) {
    const svg = size <= SIMPLIFY_UP_TO ? small : large;
    const url = await win.webContents.executeJavaScript(rasterise(svg, size));
    images.push({ size, data: Buffer.from(url.split(',')[1], 'base64') });
  }

  fs.mkdirSync(path.dirname(ICO), { recursive: true });
  fs.writeFileSync(ICO, buildIco(images));
  fs.mkdirSync(path.dirname(PNG), { recursive: true });
  fs.writeFileSync(PNG, images.find((i) => i.size === 256).data);

  console.log(`icon: wrote ${path.relative(ROOT, ICO)} (${SIZES.join(', ')} px)`);
  console.log(`icon: wrote ${path.relative(ROOT, PNG)}`);
  app.quit();
});
