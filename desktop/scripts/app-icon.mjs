import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';

// Deterministic brand geometry, not a downloaded asset or a Swift runtime dependency.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function iconPNG(size) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const samples = size < 256 ? 4 : 2;
  const pixel = (x, y) => {
    const dx = Math.max(Math.abs(x - 0.5) - 0.25, 0), dy = Math.max(Math.abs(y - 0.5) - 0.25, 0);
    if (dx * dx + dy * dy > 0.21 * 0.21 || x < 0.04 || x > 0.96 || y < 0.04 || y > 0.96) return [0, 0, 0, 0];
    const left = x >= 0.28 && (x - 0.28) ** 2 + (y - 0.5) ** 2 <= 0.205 ** 2;
    const right = x <= 0.72 && (x - 0.72) ** 2 + (y - 0.5) ** 2 <= 0.205 ** 2;
    const gray = left || right ? 24 : 246;
    return [gray, gray, gray, 255];
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const value = pixel((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
      for (let channel = 0; channel < 4; channel++) sum[channel] += value[channel];
    }
    for (let channel = 0; channel < 4; channel++) rows[y * (size * 4 + 1) + 1 + x * 4 + channel] = Math.round(sum[channel] / samples ** 2);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export async function writeAppIcon(destination) {
  const parts = [];
  for (const [size, type] of [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]) {
    const png = iconPNG(size); const header = Buffer.alloc(8); header.write(type, 0); header.writeUInt32BE(png.length + 8, 4); parts.push(header, png);
  }
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + parts.reduce((total, part) => total + part.length, 0), 4);
  await writeFile(destination, Buffer.concat([header, ...parts]));
}
