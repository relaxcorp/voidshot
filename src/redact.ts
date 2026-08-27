/**
 * Irreversible redaction.
 *
 * THE WHOLE POINT OF THIS FILE, so read before changing anything in it:
 *
 * A normal blur or pixelation is a *reversible transform of the original
 * pixels*. Depix reconstructs pixelated text (especially monospaced UI/console
 * text), Bishop Fox's Unredacter brute-forces what Depix cannot, and a
 * small-radius Gaussian blur can be undone by deconvolution. "I blurred it"
 * is not the same as "it is gone".
 *
 * So we never transform the original pixels. We *discard* them and paint
 * synthetic content in their place:
 *
 *   1. Generate noise from a PRNG seeded with a random number.
 *   2. Optionally blur that noise, so it reads as a familiar blur.
 *   3. Composite it opaquely over the region, replacing every pixel.
 *
 * The synthetic content is derived from a random seed and NOTHING ELSE. It has
 * zero mutual information with what was underneath, so there is no signal left
 * to recover -- not by deconvolution, not by brute force, not ever.
 *
 * Two supporting rules that are easy to break by accident:
 *
 *   - Composite fully opaque (`globalAlpha = 1`, `source-over`). Any
 *     transparency would blend the original through.
 *   - Snap to whole pixels and disable smoothing. Antialiased edges mix
 *     original pixels into the boundary row, which leaks a thin sliver of the
 *     very thing being hidden.
 */

export type RedactStyle = "blur" | "mosaic" | "solid";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Deterministic PRNG so repaints are stable instead of flickering. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Round a rect outward to whole pixels — never leave a fractional edge. */
export function snap(rect: Rect): Rect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    w: Math.max(1, Math.ceil(rect.x + rect.w) - x),
    h: Math.max(1, Math.ceil(rect.y + rect.h) - y),
  };
}

/** Expand a rect so its outline does not betray the size of what it hid. */
export function pad(rect: Rect, amount: number, bounds?: Rect): Rect {
  let r = {
    x: rect.x - amount,
    y: rect.y - amount,
    w: rect.w + amount * 2,
    h: rect.h + amount * 2,
  };
  if (bounds) {
    const x = Math.max(bounds.x, r.x);
    const y = Math.max(bounds.y, r.y);
    const right = Math.min(bounds.x + bounds.w, r.x + r.w);
    const bottom = Math.min(bounds.y + bounds.h, r.y + r.h);
    r = { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
  }
  return snap(r);
}

function scratch(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  // Plain canvas rather than OffscreenCanvas: WebKitGTK support for the latter
  // is patchy, and this has to behave identically on every platform.
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const ctx = c.getContext("2d", { willReadFrequently: false });
  if (!ctx) throw new Error("2D canvas unavailable");
  return [c, ctx];
}

/**
 * Low-frequency synthetic noise: overlapping soft blobs in muted greys.
 *
 * Deliberately not white noise. White noise blurs down to flat grey mush that
 * looks like a bug; large blobs blur into something that reads as "blurred
 * content" while carrying no content at all.
 */
function paintNoise(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: () => number,
): void {
  // Neutral base tone. Fixed values, not sampled from the image — sampling the
  // average colour of the region would leak a few bits about it.
  const base = 96 + Math.floor(rand() * 40);
  ctx.fillStyle = `rgb(${base}, ${base + 2}, ${base + 5})`;
  ctx.fillRect(0, 0, w, h);

  const blobs = Math.max(14, Math.round((w * h) / 1400));
  const maxR = Math.max(10, Math.min(w, h) * 0.45);

  for (let i = 0; i < blobs; i++) {
    const cx = rand() * w;
    const cy = rand() * h;
    const r = maxR * (0.25 + rand() * 0.75);
    const tone = 40 + Math.floor(rand() * 170);
    const tint = rand();
    const rr = Math.min(255, tone + Math.floor(tint * 26));
    const gg = tone;
    const bb = Math.min(255, tone + Math.floor((1 - tint) * 30));

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${rr}, ${gg}, ${bb}, 0.85)`);
    grad.addColorStop(1, `rgba(${rr}, ${gg}, ${bb}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Blocky synthetic mosaic — looks like pixelation, contains nothing. */
function paintMosaic(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rand: () => number,
  block: number,
): void {
  const b = Math.max(4, Math.round(block));
  for (let y = 0; y < h; y += b) {
    for (let x = 0; x < w; x += b) {
      const tone = 48 + Math.floor(rand() * 150);
      const tint = Math.floor(rand() * 22);
      ctx.fillStyle = `rgb(${tone + tint}, ${tone}, ${tone + 22 - tint})`;
      ctx.fillRect(x, y, b, b);
    }
  }
}

export interface RedactOptions {
  style: RedactStyle;
  seed: number;
  /** Blur radius for "blur", block size for "mosaic". */
  strength: number;
}

/**
 * Replace `rect` on `ctx` with synthetic content. Destructive by design: after
 * this call the original pixels in that rect are gone from this canvas.
 */
export function applyRedaction(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  opts: RedactOptions,
): void {
  const r = snap(rect);
  if (r.w < 1 || r.h < 1) return;

  const rand = mulberry32(opts.seed);

  ctx.save();
  // Opaque, unsmoothed, whole-pixel. See the header note.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = false;
  ctx.filter = "none";

  if (opts.style === "solid") {
    ctx.fillStyle = "#111318";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
    return;
  }

  if (opts.style === "mosaic") {
    const [tile] = (() => {
      const [c, cctx] = scratch(r.w, r.h);
      paintMosaic(cctx, r.w, r.h, rand, opts.strength);
      return [c];
    })();
    ctx.drawImage(tile, r.x, r.y);
    ctx.restore();
    return;
  }

  // style === "blur"
  //
  // Generate on an oversized canvas and crop the middle out. Blurring a canvas
  // pulls in its transparent surroundings, which would leave soft translucent
  // edges — and a translucent edge over the original is exactly the leak we are
  // here to prevent.
  const radius = Math.max(2, Math.round(opts.strength));
  const margin = Math.ceil(radius * 3);
  const [noise, nctx] = scratch(r.w + margin * 2, r.h + margin * 2);
  paintNoise(nctx, noise.width, noise.height, rand);

  const [blurred, bctx] = scratch(noise.width, noise.height);
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(noise, 0, 0);
  bctx.filter = "none";

  ctx.drawImage(blurred, margin, margin, r.w, r.h, r.x, r.y, r.w, r.h);
  ctx.restore();
}
