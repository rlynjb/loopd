/**
 * Generate a BMP image with text rendered as simple block pixels.
 * No external dependencies — constructs raw BMP bytes.
 * Used for burning text overlays into exported video via FFmpeg overlay filter.
 */

// Simple 5x7 pixel font for ASCII printable characters (32-126)
// Each character is 5 columns wide, 7 rows tall, stored as 7 bytes (each byte = 1 row, 5 LSBs used)
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100, 0b00000],
  '"': [0b01010, 0b01010, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000],
  '#': [0b01010, 0b11111, 0b01010, 0b01010, 0b11111, 0b01010, 0b00000],
  '$': [0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100],
  '%': [0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b10011, 0b00000],
  '&': [0b01100, 0b10010, 0b01100, 0b10101, 0b10010, 0b01101, 0b00000],
  "'": [0b00100, 0b00100, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '*': [0b00000, 0b00100, 0b10101, 0b01110, 0b10101, 0b00100, 0b00000],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  ',': [0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100, 0b01000],
  '-': [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00000],
  '/': [0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b00000, 0b00000],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  '3': [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  ':': [0b00000, 0b00100, 0b00000, 0b00000, 0b00100, 0b00000, 0b00000],
  ';': [0b00000, 0b00100, 0b00000, 0b00000, 0b00100, 0b00100, 0b01000],
  '<': [0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010],
  '=': [0b00000, 0b00000, 0b11111, 0b00000, 0b11111, 0b00000, 0b00000],
  '>': [0b10000, 0b01000, 0b00100, 0b00010, 0b00100, 0b01000, 0b10000],
  '?': [0b01110, 0b10001, 0b00010, 0b00100, 0b00000, 0b00100, 0b00000],
  '@': [0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01110, 0b10001, 0b10000, 0b01110, 0b00001, 0b10001, 0b01110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  a: [0b00000, 0b00000, 0b01110, 0b00001, 0b01111, 0b10001, 0b01111],
  b: [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  c: [0b00000, 0b00000, 0b01110, 0b10000, 0b10000, 0b10001, 0b01110],
  d: [0b00001, 0b00001, 0b01111, 0b10001, 0b10001, 0b10001, 0b01111],
  e: [0b00000, 0b00000, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
  f: [0b00110, 0b01001, 0b01000, 0b11100, 0b01000, 0b01000, 0b01000],
  g: [0b00000, 0b01111, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  h: [0b10000, 0b10000, 0b10110, 0b11001, 0b10001, 0b10001, 0b10001],
  i: [0b00100, 0b00000, 0b01100, 0b00100, 0b00100, 0b00100, 0b01110],
  j: [0b00010, 0b00000, 0b00110, 0b00010, 0b00010, 0b10010, 0b01100],
  k: [0b10000, 0b10000, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010],
  l: [0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  m: [0b00000, 0b00000, 0b11010, 0b10101, 0b10101, 0b10001, 0b10001],
  n: [0b00000, 0b00000, 0b10110, 0b11001, 0b10001, 0b10001, 0b10001],
  o: [0b00000, 0b00000, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
  p: [0b00000, 0b00000, 0b11110, 0b10001, 0b11110, 0b10000, 0b10000],
  q: [0b00000, 0b00000, 0b01111, 0b10001, 0b01111, 0b00001, 0b00001],
  r: [0b00000, 0b00000, 0b10110, 0b11001, 0b10000, 0b10000, 0b10000],
  s: [0b00000, 0b00000, 0b01110, 0b10000, 0b01110, 0b00001, 0b11110],
  t: [0b01000, 0b01000, 0b11100, 0b01000, 0b01000, 0b01001, 0b00110],
  u: [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b10011, 0b01101],
  v: [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  w: [0b00000, 0b00000, 0b10001, 0b10001, 0b10101, 0b10101, 0b01010],
  x: [0b00000, 0b00000, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
  y: [0b00000, 0b00000, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  z: [0b00000, 0b00000, 0b11111, 0b00010, 0b00100, 0b01000, 0b11111],
};

function parseHexColor(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) || 255;
  const g = parseInt(hex.slice(3, 5), 16) || 255;
  const b = parseInt(hex.slice(5, 7), 16) || 255;
  return [r, g, b];
}

/**
 * Render text into a 32-bit BGRA BMP buffer (with alpha channel).
 * Returns base64 encoded BMP data.
 */
export function renderTextBmp(
  text: string,
  width: number,
  height: number,
  fontSize: number,
  color: string,
  textAlign: 'left' | 'center' | 'right',
  position: 'top' | 'center' | 'bottom',
): string {
  const [r, g, b] = parseHexColor(color);

  // Scale factor: each font pixel becomes scale×scale pixels
  const CHAR_W = 5;
  const CHAR_H = 7;
  const SPACING = 1;
  const scale = Math.max(1, Math.round(fontSize / CHAR_H));

  // Measure text width
  const textWidthPx = text.length * (CHAR_W + SPACING) * scale;
  const textHeightPx = CHAR_H * scale;

  // Position
  let startX: number;
  if (textAlign === 'left') startX = Math.round(width * 0.05);
  else if (textAlign === 'right') startX = width - textWidthPx - Math.round(width * 0.05);
  else startX = Math.round((width - textWidthPx) / 2);
  startX = Math.max(0, startX);

  let startY: number;
  if (position === 'top') startY = Math.round(height * 0.08);
  else if (position === 'center') startY = Math.round((height - textHeightPx) / 2);
  else startY = Math.round(height * 0.85 - textHeightPx);
  startY = Math.max(0, startY);

  // Create BGRA pixel buffer (all transparent)
  const rowBytes = width * 4;
  const paddedRowBytes = Math.ceil(rowBytes / 4) * 4;
  const pixelDataSize = paddedRowBytes * height;
  const pixels = new Uint8Array(pixelDataSize); // all zeros = transparent

  // Shadow offset
  const shadowDx = 0;
  const shadowDy = Math.max(1, Math.round(scale * 0.3));

  // Draw shadow first, then text
  const passes: { dr: number; dg: number; db: number; da: number; dx: number; dy: number }[] = [
    { dr: 0, dg: 0, db: 0, da: 160, dx: shadowDx, dy: shadowDy }, // shadow
    { dr: r, dg: g, db: b, da: 255, dx: 0, dy: 0 }, // text
  ];

  for (const pass of passes) {
    let cursorX = startX + pass.dx;
    const baseY = startY + pass.dy;

    for (const ch of text) {
      const glyph = FONT[ch] ?? FONT['?'] ?? [0, 0, 0, 0, 0, 0, 0];
      for (let row = 0; row < CHAR_H; row++) {
        const bits = glyph[row];
        for (let col = 0; col < CHAR_W; col++) {
          if (bits & (1 << (CHAR_W - 1 - col))) {
            // Fill scale×scale block
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                const px = cursorX + col * scale + sx;
                const py = baseY + row * scale + sy;
                if (px >= 0 && px < width && py >= 0 && py < height) {
                  // BMP is bottom-up
                  const bmpY = height - 1 - py;
                  const offset = bmpY * paddedRowBytes + px * 4;
                  pixels[offset] = pass.db;     // B
                  pixels[offset + 1] = pass.dg; // G
                  pixels[offset + 2] = pass.dr; // R
                  pixels[offset + 3] = pass.da; // A
                }
              }
            }
          }
        }
      }
      cursorX += (CHAR_W + SPACING) * scale;
    }
  }

  // Build BMP file
  const headerSize = 14;
  const dibSize = 108; // BITMAPV4HEADER for BGRA support
  const fileSize = headerSize + dibSize + pixelDataSize;

  const bmp = new Uint8Array(fileSize);
  const view = new DataView(bmp.buffer);

  // BMP file header
  bmp[0] = 0x42; bmp[1] = 0x4D; // 'BM'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, headerSize + dibSize, true);

  // DIB header (BITMAPV4HEADER)
  view.setUint32(14, dibSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-up
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 32, true); // bits per pixel
  view.setUint32(30, 3, true); // BI_BITFIELDS compression
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true); // X ppm
  view.setInt32(42, 2835, true); // Y ppm
  // Color masks (BGRA)
  view.setUint32(54, 0x00FF0000, true); // R mask
  view.setUint32(58, 0x0000FF00, true); // G mask
  view.setUint32(62, 0x000000FF, true); // B mask
  view.setUint32(66, 0xFF000000, true); // A mask

  // Copy pixel data
  bmp.set(pixels, headerSize + dibSize);

  // Convert to base64
  let binary = '';
  for (let i = 0; i < bmp.length; i++) {
    binary += String.fromCharCode(bmp[i]);
  }
  return btoa(binary);
}
