// One-off deterministic sample-image generator (no external deps).
// Writes a valid RGB PNG to samples/assets/logo.png.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const W = 600;
const H = 260;

// CRC32 (PNG polynomial) with a cached table.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Build the raw image: white bg, an amber disc, and a navy wordmark bar.
const NAVY = [15, 47, 87];
const AMBER = [224, 138, 30];
const raw = Buffer.alloc(H * (1 + W * 3));
let p = 0;
for (let y = 0; y < H; y += 1) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < W; x += 1) {
    let [r, g, b] = [255, 255, 255];
    const cx = 80;
    const cy = 130;
    const disc = (x - cx) ** 2 + (y - cy) ** 2 <= 52 ** 2;
    const bar = x >= 170 && x <= 560 && y >= 108 && y <= 152;
    const tick = x >= 170 && x <= 560 && (y >= 176 && y <= 186);
    if (disc) [r, g, b] = AMBER;
    else if (bar || tick) [r, g, b] = NAVY;
    raw[p++] = r;
    raw[p++] = g;
    raw[p++] = b;
  }
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(new URL('../samples/assets/', import.meta.url), { recursive: true });
writeFileSync(new URL('../samples/assets/logo.png', import.meta.url), png);
console.log(`wrote samples/assets/logo.png (${W}x${H}, ${png.length} bytes)`);
