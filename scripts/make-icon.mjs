/**
 * Generates the source app icon (1024x1024 PNG) with no image libraries —
 * just a pixel buffer and Node's built-in zlib.
 *
 * Run: node scripts/make-icon.mjs
 * Then: npx tauri icon src-tauri/icons/source.png
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri/icons/source.png");

const buf = new Float32Array(SIZE * SIZE * 4);

const idx = (x, y) => (y * SIZE + x) * 4;

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = idx(x, y);
  const dst = buf[i + 3];
  const out = a + dst * (1 - a);
  if (out <= 0) return;
  buf[i] = (r * a + buf[i] * dst * (1 - a)) / out;
  buf[i + 1] = (g * a + buf[i + 1] * dst * (1 - a)) / out;
  buf[i + 2] = (b * a + buf[i + 2] * dst * (1 - a)) / out;
  buf[i + 3] = out;
}

/** Signed distance to a rounded rectangle — gives us free antialiasing. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function fillRoundRect(cx, cy, hw, hh, r, colorAt, alpha = 1) {
  const x0 = Math.max(0, Math.floor(cx - hw - 2));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + hw + 2));
  const y0 = Math.max(0, Math.floor(cy - hh - 2));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + hh + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      const cov = Math.max(0, Math.min(1, 0.5 - d));
      if (cov <= 0) continue;
      const [r0, g0, b0] = colorAt(x, y);
      blend(x, y, r0, g0, b0, cov * alpha);
    }
  }
}

function strokeRoundRect(cx, cy, hw, hh, r, width, color, alpha = 1) {
  const x0 = Math.max(0, Math.floor(cx - hw - width));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + hw + width));
  const y0 = Math.max(0, Math.floor(cy - hh - width));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + hh + width));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, r));
      const cov = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (cov <= 0) continue;
      blend(x, y, color[0], color[1], color[2], cov * alpha);
    }
  }
}

// ---------------------------------------------------------------- background
// Dark rounded tile with a subtle vertical gradient.
fillRoundRect(SIZE / 2, SIZE / 2, SIZE / 2 - 24, SIZE / 2 - 24, 210, (_x, y) => {
  const t = y / SIZE;
  return [16 + 8 * (1 - t), 20 + 10 * (1 - t), 30 + 12 * (1 - t)];
});

// ------------------------------------------------------- redacted core patch
// The centre is the product in one image: a region whose content has been
// replaced by synthetic blur. Blobs first, blurred afterwards.
const PATCH = { cx: SIZE / 2, cy: SIZE / 2, hw: 232, hh: 150, r: 26 };
const patch = new Float32Array(SIZE * SIZE * 4);

{
  const seedRand = (() => {
    let a = 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const blobs = [];
  for (let i = 0; i < 22; i++) {
    blobs.push({
      x: PATCH.cx + (seedRand() - 0.5) * PATCH.hw * 2.1,
      y: PATCH.cy + (seedRand() - 0.5) * PATCH.hh * 2.1,
      r: 40 + seedRand() * 110,
      c: [40 + seedRand() * 90, 90 + seedRand() * 110, 150 + seedRand() * 105],
    });
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let rr = 26,
        gg = 34,
        bb = 52,
        acc = 0.35;
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d > b.r) continue;
        const w = (1 - d / b.r) ** 2;
        rr += b.c[0] * w;
        gg += b.c[1] * w;
        bb += b.c[2] * w;
        acc += w;
      }
      const i = idx(x, y);
      patch[i] = rr / acc;
      patch[i + 1] = gg / acc;
      patch[i + 2] = bb / acc;
      patch[i + 3] = 1;
    }
  }

  // Cheap separable box blur, run a few times to approximate a Gaussian.
  const tmp = new Float32Array(patch.length);
  const radius = 18;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(SIZE - 1, Math.max(0, x + k));
          const i = idx(sx, y);
          r += patch[i]; g += patch[i + 1]; b += patch[i + 2]; n++;
        }
        const o = idx(x, y);
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n; tmp[o + 3] = 1;
      }
    }
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.min(SIZE - 1, Math.max(0, y + k));
          const i = idx(x, sy);
          r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; n++;
        }
        const o = idx(x, y);
        patch[o] = r / n; patch[o + 1] = g / n; patch[o + 2] = b / n; patch[o + 3] = 1;
      }
    }
  }
}

fillRoundRect(PATCH.cx, PATCH.cy, PATCH.hw, PATCH.hh, PATCH.r, (x, y) => {
  const i = idx(x, y);
  return [patch[i], patch[i + 1], patch[i + 2]];
});

// ------------------------------------------------------------ viewfinder marks
const ACCENT = [77, 163, 255];
const M = 232;          // distance from centre to the bracket corner
const LEN = 132;        // arm length
const W = 44;           // arm thickness

function bar(x, y, w, h) {
  fillRoundRect(x, y, w / 2, h / 2, Math.min(w, h) / 2, () => ACCENT, 1);
}

for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
  const cx = SIZE / 2 + sx * M;
  const cy = SIZE / 2 + sy * M;
  // horizontal arm
  bar(cx + sx * (LEN / 2 - W / 2), cy, LEN, W);
  // vertical arm
  bar(cx, cy + sy * (LEN / 2 - W / 2), W, LEN);
}

// Hairline inner edge so the tile reads as an object, not a flat square.
strokeRoundRect(SIZE / 2, SIZE / 2, SIZE / 2 - 26, SIZE / 2 - 26, 208, 3, [255, 255, 255], 0.1);

// ------------------------------------------------------------------ encode
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = idx(x, y);
    const a = Math.max(0, Math.min(1, buf[i + 3]));
    raw[p++] = Math.round(Math.max(0, Math.min(255, buf[i])));
    raw[p++] = Math.round(Math.max(0, Math.min(255, buf[i + 1])));
    raw[p++] = Math.round(Math.max(0, Math.min(255, buf[i + 2])));
    raw[p++] = Math.round(a * 255);
  }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(data) {
  let c = -1;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${(png.length / 1024).toFixed(1)} KB)`);
