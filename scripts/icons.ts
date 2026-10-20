// Renders the provisional app icons (PNG) with no image dependencies. Replace with the verified brand icon when supplied.
// Usage: tsx scripts/icons.ts → web/public/icon-192.png, icon-512.png, apple-touch-icon.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const NAVY = [0x17, 0x32, 0x4d], TEAL = [0x0a, 0x6b, 0x61], WHITE = [0xff, 0xff, 0xff];

// Shapes in a 0..1 unit square. Full-bleed navy keeps the icon valid as "maskable".
function colourAt(x: number, y: number): number[] {
  const inRound = (x0: number, y0: number, x1: number, y1: number, r: number) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  if (!inRound(0.2, 0.2, 0.8, 0.8, 0.12)) return NAVY;
  // White house: roof triangle plus body, with a teal door.
  const roof = y >= 0.3 && y <= 0.5 && Math.abs(x - 0.5) <= (y - 0.3) * 1.1;
  const body = x >= 0.36 && x <= 0.64 && y >= 0.48 && y <= 0.7;
  const door = x >= 0.46 && x <= 0.54 && y >= 0.57 && y <= 0.7;
  if (door) return TEAL;
  if (roof || body) return WHITE;
  return TEAL;
}

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number) {
  const S = 4; // 4×4 supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = colourAt((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (S * S));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../web/public/', import.meta.url);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
  writeFileSync(new URL(name, out), png(size));
  console.log('wrote', name);
}
