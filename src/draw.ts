import { applyRedaction } from "./redact";
import type { Point, Shape } from "./types";

/**
 * Paint one annotation. Shapes are drawn in insertion order, so anything added
 * after a redaction sits on top of it — which is what you want when you box or
 * label a region you just hid.
 */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (shape.kind) {
    case "redact":
      // Destructive: replaces the pixels rather than covering them.
      applyRedaction(ctx, shape.rect, {
        style: shape.style,
        seed: shape.seed,
        strength: shape.strength,
      });
      break;

    case "rect": {
      ctx.strokeStyle = shape.color;
      ctx.fillStyle = shape.color;
      ctx.lineWidth = shape.width;
      const { x, y, w, h } = shape.rect;
      if (shape.filled) {
        ctx.globalAlpha = 0.28;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      }
      ctx.strokeRect(x, y, w, h);
      break;
    }

    case "ellipse": {
      ctx.strokeStyle = shape.color;
      ctx.fillStyle = shape.color;
      ctx.lineWidth = shape.width;
      const { x, y, w, h } = shape.rect;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      if (shape.filled) {
        ctx.globalAlpha = 0.28;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      break;
    }

    case "line":
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(shape.from.x, shape.from.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.stroke();
      break;

    case "arrow":
      drawArrow(ctx, shape.from, shape.to, shape.color, shape.width);
      break;

    case "pen":
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      strokePath(ctx, shape.points);
      break;

    case "highlight":
      // `multiply` keeps the text underneath readable, like a real marker.
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.lineCap = "butt";
      strokePath(ctx, shape.points);
      break;

    case "text":
      drawText(ctx, shape.at, shape.text, shape.color, shape.size);
      break;

    case "counter":
      drawCounter(ctx, shape.at, shape.n, shape.color, shape.size);
      break;
  }

  ctx.restore();
}

function strokePath(ctx: CanvasRenderingContext2D, points: Point[]): void {
  if (points.length === 0) return;
  if (points.length === 1) {
    // A single tap should still leave a dot.
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  // Quadratic midpoint smoothing: cheap, and stops freehand strokes from
  // looking like polylines.
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  width: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const angle = Math.atan2(dy, dx);
  // Head scales with stroke width but is capped to the arrow's own length, so
  // short arrows do not turn into a lone triangle.
  const head = Math.min(len * 0.4, width * 4.5 + 6);
  const spread = Math.PI / 7;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;

  // Stop the shaft just short of the tip so the head's point stays crisp.
  const shaftEnd = {
    x: to.x - Math.cos(angle) * head * 0.55,
    y: to.y - Math.sin(angle) * head * 0.55,
  };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - spread) * head, to.y - Math.sin(angle - spread) * head);
  ctx.lineTo(to.x - Math.cos(angle + spread) * head, to.y - Math.sin(angle + spread) * head);
  ctx.closePath();
  ctx.fill();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  at: Point,
  text: string,
  color: string,
  size: number,
): void {
  ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const y = at.y + i * size * 1.25;
    // Dark halo so light text stays legible over light screenshots.
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.lineWidth = Math.max(2, size / 7);
    ctx.strokeText(line, at.x, y);
    ctx.fillStyle = color;
    ctx.fillText(line, at.x, y);
  });
}

function drawCounter(
  ctx: CanvasRenderingContext2D,
  at: Point,
  n: number,
  color: string,
  size: number,
): void {
  const r = size * 0.9;
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = Math.max(2, r / 7);
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.font = `700 ${Math.round(r * 1.15)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), at.x, at.y + r * 0.05);
}

/**
 * Flatten the screenshot plus every annotation into a standalone canvas,
 * cropped to `crop`.
 *
 * This is the only thing that ever gets exported. It is a plain bitmap: no
 * layers, no shape list, no undo history — so a redaction cannot be "turned
 * off" by whoever opens the file, because there is nothing to turn off.
 */
export function flatten(
  source: CanvasImageSource,
  shapes: Shape[],
  crop: { x: number; y: number; w: number; h: number },
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(crop.w));
  out.height = Math.max(1, Math.round(crop.h));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  ctx.drawImage(
    source,
    Math.round(crop.x),
    Math.round(crop.y),
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height,
  );

  // Shift into crop-local coordinates so shapes land where the user drew them.
  ctx.translate(-Math.round(crop.x), -Math.round(crop.y));
  for (const shape of shapes) drawShape(ctx, shape);

  return out;
}
