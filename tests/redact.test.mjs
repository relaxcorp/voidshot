/**
 * Proves the redaction is irreversible rather than merely obscuring.
 *
 * The decisive test is CONTENT INDEPENDENCE: redact two completely different
 * images with the same seed, and the output pixels must be byte-identical. If
 * the output does not vary with the input, it carries zero information about
 * the input — so there is nothing for Depix, Unredacter, deconvolution or any
 * future tool to recover. Everything else here guards the supporting details
 * (full opacity, hard edges, no bleed outside the box).
 *
 * Run: node tests/redact.test.mjs
 */
import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "voidshot-test-"));

// IIFE with a global name: file:// pages refuse dynamic module imports.
const entry = join(work, "entry.ts");
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(root, "src/redact.ts"))};
   export { flatten } from ${JSON.stringify(join(root, "src/draw.ts"))};`,
);
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  globalName: "R",
  write: false,
});
writeFileSync(join(work, "redact.js"), bundle.outputFiles[0].text);
writeFileSync(
  join(work, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>t</title><body></body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${join(work, "index.html")}`);
await page.addScriptTag({ path: join(work, "redact.js") });

const results = await page.evaluate(() => {
  const { applyRedaction } = window.R;
  const W = 400;
  const H = 200;
  const BOX = { x: 50, y: 40, w: 260, h: 90 };

  const make = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return [c, c.getContext("2d")];
  };

  /** A canvas full of high-contrast secret-looking text. */
  const paintSecret = (ctx, text, bg) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#000";
    ctx.font = '700 34px "DejaVu Sans Mono", monospace';
    ctx.fillText(text, 56, 100);
    ctx.font = '700 22px "DejaVu Sans Mono", monospace';
    ctx.fillText(text.split("").reverse().join(""), 56, 125);
  };

  const pixels = (ctx, r) => ctx.getImageData(r.x, r.y, r.w, r.h).data;

  const out = [];
  const styles = ["blur", "mosaic", "solid"];

  // --- 1. content independence ------------------------------------------
  for (const style of styles) {
    const [, a] = make();
    const [, b] = make();
    paintSecret(a, "SECRET-9F31-KEY", "#ffffff");
    paintSecret(b, "totally-other!!", "#22ff88");

    const seed = 123456789;
    applyRedaction(a, BOX, { style, seed, strength: 14 });
    applyRedaction(b, BOX, { style, seed, strength: 14 });

    const pa = pixels(a, BOX);
    const pb = pixels(b, BOX);
    let diff = 0;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff++;

    out.push({
      name: `content independence [${style}]`,
      pass: diff === 0,
      detail: `${diff} of ${pa.length} bytes differ between two different source images`,
    });
  }

  // --- 2. full opacity ---------------------------------------------------
  for (const style of styles) {
    const [, ctx] = make();
    paintSecret(ctx, "SECRET-9F31-KEY", "#ffffff");
    applyRedaction(ctx, BOX, { style, seed: 42, strength: 14 });
    const p = pixels(ctx, BOX);
    let translucent = 0;
    for (let i = 3; i < p.length; i += 4) if (p[i] !== 255) translucent++;
    out.push({
      name: `full opacity [${style}]`,
      pass: translucent === 0,
      detail: `${translucent} translucent pixels inside the box`,
    });
  }

  // --- 3. nothing outside the box is touched -----------------------------
  for (const style of styles) {
    const [, ctx] = make();
    paintSecret(ctx, "SECRET-9F31-KEY", "#ffffff");
    const before = ctx.getImageData(0, 0, W, H).data.slice();
    applyRedaction(ctx, BOX, { style, seed: 42, strength: 20 });
    const after = ctx.getImageData(0, 0, W, H).data;

    let bled = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside =
          x >= BOX.x && x < BOX.x + BOX.w && y >= BOX.y && y < BOX.y + BOX.h;
        if (inside) continue;
        const i = (y * W + x) * 4;
        if (
          before[i] !== after[i] ||
          before[i + 1] !== after[i + 1] ||
          before[i + 2] !== after[i + 2] ||
          before[i + 3] !== after[i + 3]
        ) {
          bled++;
        }
      }
    }
    out.push({
      name: `no bleed outside box [${style}]`,
      pass: bled === 0,
      detail: `${bled} pixels changed outside the box`,
    });
  }

  // --- 4. hard edges: boundary pixels fully replaced ----------------------
  // An antialiased edge would blend the original into the boundary row, leaking
  // a sliver of what was hidden. Compare the boundary row of two different
  // sources: identical means fully synthetic, no blending.
  for (const style of styles) {
    const [, a] = make();
    const [, b] = make();
    paintSecret(a, "SECRET-9F31-KEY", "#ffffff");
    paintSecret(b, "XXXXXXXXXXXXXXX", "#000000");
    applyRedaction(a, BOX, { style, seed: 777, strength: 14 });
    applyRedaction(b, BOX, { style, seed: 777, strength: 14 });

    const edges = [
      { x: BOX.x, y: BOX.y, w: BOX.w, h: 1 },
      { x: BOX.x, y: BOX.y + BOX.h - 1, w: BOX.w, h: 1 },
      { x: BOX.x, y: BOX.y, w: 1, h: BOX.h },
      { x: BOX.x + BOX.w - 1, y: BOX.y, w: 1, h: BOX.h },
    ];
    let diff = 0;
    for (const e of edges) {
      const ea = pixels(a, e);
      const eb = pixels(b, e);
      for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) diff++;
    }
    out.push({
      name: `hard edges [${style}]`,
      pass: diff === 0,
      detail: `${diff} differing bytes across the 4 boundary lines`,
    });
  }

  // --- 5. different seeds produce different output -----------------------
  for (const style of ["blur", "mosaic"]) {
    const [, a] = make();
    const [, b] = make();
    paintSecret(a, "SECRET-9F31-KEY", "#ffffff");
    paintSecret(b, "SECRET-9F31-KEY", "#ffffff");
    applyRedaction(a, BOX, { style, seed: 1, strength: 14 });
    applyRedaction(b, BOX, { style, seed: 2, strength: 14 });
    const pa = pixels(a, BOX);
    const pb = pixels(b, BOX);
    let diff = 0;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff++;
    out.push({
      name: `seed variation [${style}]`,
      pass: diff > pa.length * 0.2,
      detail: `${((diff / pa.length) * 100).toFixed(1)}% of bytes differ across seeds`,
    });
  }

  // --- 6. correlation carries no signal ----------------------------------
  //
  // A single Pearson r between the original and the redaction is NOT a valid
  // leak test. Both are spatially smooth fields, so the effective sample count
  // is the number of blobs (a few dozen), not the pixel count — and two
  // independent smooth fields routinely correlate at |r| ~ 1/sqrt(n_eff) ~ 0.2
  // purely by chance.
  //
  // The meaningful question is whether r says anything about the content. So we
  // measure r over many seeds against the real secret, and against an unrelated
  // control image. If redaction leaked, correlation with the true original
  // would be systematically stronger than with the control. Identical
  // distributions mean the correlation is noise.
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  const corr = (a, b) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < a.length; i += 4) {
      const x = lum(a, i);
      const y = lum(b, i);
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const vx = n * sxx - sx * sx;
    const vy = n * syy - sy * sy;
    // Zero variance on either side means a constant field: no information at
    // all, which is the strongest possible result, not an error.
    if (vx <= 1e-9 || vy <= 1e-9) return { r: 0, constant: true };
    return { r: (n * sxy - sx * sy) / Math.sqrt(vx * vy), constant: false };
  };

  const TRIALS = 60;
  for (const style of styles) {
    const [, secretCtx] = make();
    paintSecret(secretCtx, "SECRET-9F31-KEY", "#ffffff");
    const secret = pixels(secretCtx, BOX);

    const [, ctrlCtx] = make();
    paintSecret(ctrlCtx, "unrelated-text", "#3355aa");
    const control = pixels(ctrlCtx, BOX);

    const realRs = [];
    const ctrlRs = [];
    let constant = false;

    for (let t = 0; t < TRIALS; t++) {
      const [, ctx] = make();
      paintSecret(ctx, "SECRET-9F31-KEY", "#ffffff");
      applyRedaction(ctx, BOX, { style, seed: 1000 + t * 7919, strength: 14 });
      const red = pixels(ctx, BOX);

      const a = corr(secret, red);
      const b = corr(control, red);
      constant = a.constant;
      realRs.push(Math.abs(a.r));
      ctrlRs.push(Math.abs(b.r));
    }

    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = (xs, m) =>
      Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));

    const mReal = mean(realRs);
    const mCtrl = mean(ctrlRs);
    // Welch's t statistic between the two |r| distributions.
    const se = Math.sqrt(
      sd(realRs, mReal) ** 2 / TRIALS + sd(ctrlRs, mCtrl) ** 2 / TRIALS,
    );
    const t = se < 1e-12 ? 0 : (mReal - mCtrl) / se;

    out.push({
      name: `no signal in correlation [${style}]`,
      // |t| < 3 means the real image is not correlated any more strongly than
      // an unrelated control — i.e. the correlation is pure chance.
      pass: constant || Math.abs(t) < 3,
      detail: constant
        ? "constant fill: zero variance, zero information"
        : `mean|r| secret=${mReal.toFixed(4)} vs control=${mCtrl.toFixed(4)}, Welch t=${t.toFixed(2)}`,
    });
  }

  // --- 7. the exported image is what carries the redaction ---------------
  //
  // Everything above tests the primitive. This tests the thing that actually
  // leaves the app: flatten() composites the screenshot and the shape list into
  // one bitmap. Same content-independence check, applied to the export path —
  // if this passes, no file, clipboard entry or pin can carry the original.
  {
    const { flatten } = window.R;
    const crop = { x: 20, y: 20, w: 360, h: 160 };

    const render = (text, bg) => {
      const [c, ctx] = make();
      paintSecret(ctx, text, bg);
      const shapes = [
        { kind: "redact", rect: BOX, style: "blur", seed: 987654321, strength: 14 },
      ];
      return flatten(c, shapes, crop);
    };

    const a = render("SECRET-9F31-KEY", "#ffffff");
    const b = render("nothing-alike!!", "#ff0066");
    const pa = a.getContext("2d").getImageData(
      BOX.x - crop.x, BOX.y - crop.y, BOX.w, BOX.h,
    ).data;
    const pb = b.getContext("2d").getImageData(
      BOX.x - crop.x, BOX.y - crop.y, BOX.w, BOX.h,
    ).data;

    let diff = 0;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff++;

    out.push({
      name: "exported image is redacted",
      pass: diff === 0,
      detail: `${diff} of ${pa.length} exported bytes differ between two different sources`,
    });

    // Sanity check the other direction: outside the redaction the export must
    // still differ, or we would be proving nothing (e.g. a blank canvas).
    const oa = a.getContext("2d").getImageData(0, 0, 40, 40).data;
    const ob = b.getContext("2d").getImageData(0, 0, 40, 40).data;
    let outDiff = 0;
    for (let i = 0; i < oa.length; i++) if (oa[i] !== ob[i]) outDiff++;
    out.push({
      name: "export control (outside box)",
      pass: outDiff > 0,
      detail: `${outDiff} bytes differ outside the box — proves the test is live`,
    });
  }

  // --- 8. edge cases that real mouse input produces ----------------------
  // A twitchy drag, a box pulled past the screen edge, fractional device-pixel
  // coordinates. None of these may throw, and none may silently skip the
  // redaction while still looking like it worked.
  {
    const cases = [
      { name: "zero size", rect: { x: 40, y: 40, w: 0, h: 0 } },
      { name: "sub-pixel", rect: { x: 40.4, y: 40.6, w: 0.3, h: 0.2 } },
      { name: "one pixel", rect: { x: 40, y: 40, w: 1, h: 1 } },
      { name: "fractional coords", rect: { x: 50.7, y: 30.2, w: 120.6, h: 40.9 } },
      { name: "past right edge", rect: { x: 350, y: 30, w: 400, h: 60 } },
      { name: "negative origin", rect: { x: -80, y: -40, w: 200, h: 120 } },
      { name: "larger than canvas", rect: { x: -50, y: -50, w: 900, h: 500 } },
      { name: "huge strength", rect: { x: 60, y: 60, w: 120, h: 60 }, strength: 400 },
    ];

    let threw = 0;
    const problems = [];

    for (const c of cases) {
      for (const style of styles) {
        const [, ctx] = make();
        paintSecret(ctx, "SECRET-9F31-KEY", "#ffffff");
        try {
          applyRedaction(ctx, c.rect, {
            style,
            seed: 555,
            strength: c.strength ?? 14,
          });
        } catch (err) {
          threw++;
          problems.push(`${c.name}/${style}: ${err.message}`);
        }
      }
    }
    out.push({
      name: "edge cases do not throw",
      pass: threw === 0,
      detail:
        threw === 0
          ? `${cases.length} shapes x ${styles.length} styles handled`
          : problems.join("; "),
    });

    // A degenerate box must still cover whatever it claims to cover: check the
    // 1x1 case actually replaced that pixel rather than quietly no-op'ing.
    const [, a] = make();
    const [, b] = make();
    paintSecret(a, "SECRET-9F31-KEY", "#ffffff");
    paintSecret(b, "different!!!!!!", "#ff0000");
    const tiny = { x: 60, y: 60, w: 1, h: 1 };
    applyRedaction(a, tiny, { style: "blur", seed: 9, strength: 14 });
    applyRedaction(b, tiny, { style: "blur", seed: 9, strength: 14 });
    const pa = a.getImageData(60, 60, 1, 1).data;
    const pb = b.getImageData(60, 60, 1, 1).data;
    out.push({
      name: "1x1 redaction still replaces",
      pass: [...pa].every((v, i) => v === pb[i]) && pa[3] === 255,
      detail: `a=[${[...pa]}] b=[${[...pb]}]`,
    });

    // Clipping past the edge must not wrap around to the opposite side.
    const [, c1] = make();
    paintSecret(c1, "SECRET-9F31-KEY", "#ffffff");
    const leftBefore = c1.getImageData(0, 30, 20, 60).data.slice();
    applyRedaction(c1, { x: 350, y: 30, w: 400, h: 60 }, { style: "mosaic", seed: 3, strength: 12 });
    const leftAfter = c1.getImageData(0, 30, 20, 60).data;
    let wrapped = 0;
    for (let i = 0; i < leftBefore.length; i++) {
      if (leftBefore[i] !== leftAfter[i]) wrapped++;
    }
    out.push({
      name: "overflow does not wrap around",
      pass: wrapped === 0,
      detail: `${wrapped} bytes changed on the opposite edge`,
    });
  }

  return out;
});

let failed = 0;
console.log("\n  Voidshot redaction — irreversibility proof\n");
for (const r of results) {
  const mark = r.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  if (!r.pass) failed++;
  console.log(`  ${mark}  ${r.name.padEnd(34)} ${r.detail}`);
}
console.log(
  `\n  ${results.length - failed}/${results.length} passed\n`,
);

await browser.close();
process.exit(failed === 0 ? 0 : 1);
