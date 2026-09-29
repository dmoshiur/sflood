/**
 * Generate the PWA icons (192, 512 and a maskable 512) as real PNG files.
 *
 * Pure Node: a minimal PNG encoder (zlib + CRC32) so the repository does not
 * need an image dependency. Run with: npm run icons
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(projectRoot, 'public');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw the FloodGrid mark: navy field, gold water line, white city block. */
function render(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = maskable ? size * 0.22 : 0;
  const drawable = size - inset * 2;
  const centre = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      // background
      let r = 10, g = 22, b = 40;
      const localX = (x - inset) / drawable;
      const localY = (y - inset) / drawable;

      if (localX >= 0 && localX <= 1 && localY >= 0 && localY <= 1) {
        // water band across the lower half
        if (localY > 0.62) {
          const wave = Math.sin((localX * Math.PI * 3)) * 0.012;
          if (localY > 0.66 + wave) { r = 47; g = 130; b = 196; }
          else if (localY > 0.63 + wave) { r = 212; g = 175; b = 55; }
        }
        // raised city island
        const inIsland = localY > 0.30 && localY < 0.60 && localX > 0.22 && localX < 0.78;
        if (inIsland) {
          const buildingRow = Math.floor((localY - 0.30) / 0.075);
          const buildingWidth = 0.10 + (buildingRow % 3) * 0.03;
          const buildingOffset = 0.26 + (buildingRow % 4) * 0.13;
          const inBuilding = localX > buildingOffset && localX < buildingOffset + buildingWidth && localY < 0.55 - (buildingRow % 2) * 0.03;
          if (inBuilding) { r = 232; g = 238; b = 246; }
          else if (localY > 0.55) { r = 38; g = 92; b = 66; }
          else { r = 24; g = 74; b = 54; }
        }
        // shield outline
        const edge = localX < 0.03 || localX > 0.97 || localY < 0.03 || localY > 0.97;
        if (edge) { r = 212; g = 175; b = 55; }
      } else if (!maskable) {
        r = 6; g = 13; b = 24;
      } else {
        r = 0; g = 0; b = 0; rgba[index + 3] = 0;
      }

      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = rgba[index + 3] === 0 && !maskable ? 255 : 255;
      if (maskable && (localX < 0 || localX > 1 || localY < 0 || localY > 1)) rgba[index + 3] = 0;
      void centre;
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(publicDir, { recursive: true });
const outputs = [
  ['icon-192.png', render(192, false)],
  ['icon-512.png', render(512, false)],
  ['icon-maskable-512.png', render(512, true)],
];
for (const [name, buffer] of outputs) {
  writeFileSync(resolve(publicDir, name), buffer);
  console.log(`[floodgrid] wrote public/${name} (${buffer.length} bytes)`);
}
