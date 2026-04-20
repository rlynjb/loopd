#!/usr/bin/env node
// Regenerate loopd app icons. Run from the repo root:
//   node .dev/scripts/gen-app-icon.mjs
//
// Produces:
//   assets/icon.png                       (1024x1024, black bg + cream L)
//   assets/android-icon-background.png    (1024x1024, solid black)
//   assets/android-icon-foreground.png    (1024x1024, transparent bg + cream L, safe zone)
//   assets/android-icon-monochrome.png    (1024x1024, transparent bg + white L, safe zone)
//   assets/favicon.png                    (96x96, black bg + cream L)
//
// Scale everything here — change SIZE or the letter geometry, re-run.

import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SIZE = 1024;
const FAVICON_SIZE = 96;

const BLACK = { r: 0, g: 0, b: 0, a: 255 };
const ACCENT = { r: 0xe8, g: 0xd5, b: 0xb0, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

function fill(png, color) {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = color.r;
      png.data[i + 1] = color.g;
      png.data[i + 2] = color.b;
      png.data[i + 3] = color.a;
    }
  }
}

function rect(png, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= png.height) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= png.width) continue;
      const i = (y * png.width + x) * 4;
      png.data[i] = color.r;
      png.data[i + 1] = color.g;
      png.data[i + 2] = color.b;
      png.data[i + 3] = color.a;
    }
  }
}

// Draw a lowercase "l" — a single tall centered vertical stroke. `inset` pulls
// the glyph into the adaptive-icon safe zone (~66% diameter). Stroke width
// and height are tuned for legibility at launcher sizes.
function drawL(png, color, inset = 0) {
  const s = png.width;
  const box = s - inset * 2;
  const strokeW = Math.round(box * 0.0832);
  const glyphH = Math.round(box * 0.448);
  const x0 = Math.round((s - strokeW) / 2);
  const y0 = Math.round((s - glyphH) / 2);
  rect(png, x0, y0, strokeW, glyphH, color);
}

function writePng(path, width, height, draw) {
  const png = new PNG({ width, height });
  draw(png);
  writeFileSync(resolve(process.cwd(), path), PNG.sync.write(png));
  console.log('wrote', path);
}

// 1) Legacy icon.png — filled black bg + cream L.
writePng('assets/icon.png', SIZE, SIZE, png => {
  fill(png, BLACK);
  drawL(png, ACCENT, Math.round(SIZE * 0.08));
});

// 2) Adaptive background — solid black.
writePng('assets/android-icon-background.png', SIZE, SIZE, png => {
  fill(png, BLACK);
});

// 3) Adaptive foreground — transparent with cream L in the safe zone.
//    Android clips the outer ~17% of this layer with the launcher mask.
writePng('assets/android-icon-foreground.png', SIZE, SIZE, png => {
  fill(png, TRANSPARENT);
  drawL(png, ACCENT, Math.round(SIZE * 0.18));
});

// 4) Monochrome — same geometry, white-on-transparent, for themed icons.
writePng('assets/android-icon-monochrome.png', SIZE, SIZE, png => {
  fill(png, TRANSPARENT);
  drawL(png, WHITE, Math.round(SIZE * 0.18));
});

// 5) Favicon — the tiny version for web/tooling.
writePng('assets/favicon.png', FAVICON_SIZE, FAVICON_SIZE, png => {
  fill(png, BLACK);
  drawL(png, ACCENT, Math.round(FAVICON_SIZE * 0.08));
});
