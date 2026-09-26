// png.mjs — dependency-free RGBA → PNG encoder (node:zlib deflate + own CRC32) and nearest-neighbour scaling.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** rgba: Uint8Array/Uint8ClampedArray of w*h*4 → PNG Buffer (8-bit RGBA, filter 0). */
export function encodePNG(rgba, w, h) {
  if (rgba.length !== w * h * 4) throw new Error(`encodePNG: expected ${w * h * 4} bytes, got ${rgba.length}`);
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let k = 0; k < w * 4; k++) raw[y * stride + 1 + k] = rgba[y * w * 4 + k];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Integer nearest-neighbour upscale. */
export function scaleRGBA(rgba, w, h, n) {
  if (n === 1) return { data: rgba, w, h };
  const W = w * n, H = h * n, out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = (y / n) | 0;
    for (let x = 0; x < W; x++) {
      const s = (sy * w + ((x / n) | 0)) * 4, d = (y * W + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  }
  return { data: out, w: W, h: H };
}

/** Blit src (sw×sh) into dst (dw wide) at (dx,dy) — raw copy, no blending. */
export function blit(dst, dw, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const s = (y * sw + x) * 4, d = ((dy + y) * dw + dx + x) * 4;
    dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
  }
}

/** Alpha-composite src (sw×sh) scaled n× over dst (dw wide, opaque) at (dx,dy). */
export function blitOver(dst, dw, src, sw, sh, dx, dy, n = 1) {
  for (let y = 0; y < sh * n; y++) for (let x = 0; x < sw * n; x++) {
    const s = (((y / n) | 0) * sw + ((x / n) | 0)) * 4, d = ((dy + y) * dw + dx + x) * 4, a = src[s + 3] / 255;
    if (!a) continue;
    for (let k = 0; k < 3; k++) dst[d + k] = Math.round(src[s + k] * a + dst[d + k] * (1 - a));
    dst[d + 3] = 255;
  }
}
/** Fill a rect of an RGBA buffer with [r,g,b]. */
export function fillRect(dst, dw, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const d = (y * dw + x) * 4;
    dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = 255;
  }
}

export function writePNG(file, rgba, w, h, scale = 1) {
  const s = scaleRGBA(rgba, w, h, scale);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePNG(s.data, s.w, s.h));
  return file;
}
