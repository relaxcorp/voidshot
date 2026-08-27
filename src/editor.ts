import { drawShape, flatten } from "./draw";
import { newSeed, pad as padRect, snap } from "./redact";
import {
  clampRect,
  normalizeRect,
  pointInRect,
  type DesktopGeometry,
  type Point,
  type Rect,
  type RedactStyle,
  type Settings,
  type Shape,
  type ToolId,
} from "./types";

const HANDLE_HIT = 12;
const MIN_SELECTION = 8;

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move" | null;

export type EditorAction = "copy" | "save" | "save_as" | "pin" | "ocr" | "cancel";

export interface EditorHost {
  onAction(action: EditorAction, canvas: HTMLCanvasElement | null): void;
  onStatus(message: string, kind?: "info" | "error"): void;
}

interface Drag {
  tool: ToolId;
  start: Point;
  current: Point;
  points: Point[];
  handle: Handle;
  originRect: Rect;
}

export class Editor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private source: ImageBitmap;
  private geometry: DesktopGeometry;
  private settings: Settings;
  private host: EditorHost;

  private phase: "select" | "edit" = "select";
  private selection: Rect | null = null;
  private shapes: Shape[] = [];
  private undoStack: Shape[][] = [];
  private redoStack: Shape[][] = [];
  private drag: Drag | null = null;
  private cursor: Point = { x: 0, y: 0 };
  private counter = 1;
  private frameQueued = false;

  tool: ToolId = "select";
  color = "#ff3b30";
  strokeWidth = 4;
  textSize = 24;
  redactStyle: RedactStyle;
  redactStrength = 14;

  constructor(
    canvas: HTMLCanvasElement,
    source: ImageBitmap,
    geometry: DesktopGeometry,
    settings: Settings,
    host: EditorHost,
  ) {
    this.canvas = canvas;
    this.source = source;
    this.geometry = geometry;
    this.settings = settings;
    this.host = host;
    this.redactStyle = settings.redact_style ?? "blur";

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;

    canvas.width = geometry.pixel_width;
    canvas.height = geometry.pixel_height;

    this.bindInput();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // coordinates
  // -------------------------------------------------------------------------

  /** Map a pointer event to canvas pixels (CSS px != device px on HiDPI). */
  private toCanvas(e: PointerEvent | MouseEvent): Point {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * this.canvas.width,
      y: ((e.clientY - box.top) / box.height) * this.canvas.height,
    };
  }

  private get bounds(): Rect {
    return { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
  }

  // -------------------------------------------------------------------------
  // input
  // -------------------------------------------------------------------------

  private bindInput(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toCanvas(e);
    this.cursor = p;

    if (this.phase === "select") {
      this.selection = { x: p.x, y: p.y, w: 0, h: 0 };
      this.drag = {
        tool: "select",
        start: p,
        current: p,
        points: [p],
        handle: "se",
        originRect: { ...this.selection },
      };
      this.requestRender();
      return;
    }

    if (this.tool === "select") {
      const handle = this.hitHandle(p);
      if (handle) {
        this.drag = {
          tool: "select",
          start: p,
          current: p,
          points: [p],
          handle,
          originRect: { ...(this.selection as Rect) },
        };
      }
      this.requestRender();
      return;
    }

    // Drawing tools only act inside the selection.
    if (!this.selection || !pointInRect(p, this.selection)) return;

    if (this.tool === "text") {
      // Hand focus to the textarea: keep the canvas from holding the pointer
      // capture (which was swallowing the click that should focus the input).
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this.host.onStatus("Type your note, then press Esc or click away");
      this.beginTextEntry(p);
      return;
    }

    if (this.tool === "counter") {
      this.pushHistory();
      this.shapes.push({
        kind: "counter",
        at: p,
        n: this.counter++,
        color: this.color,
        size: Math.max(12, this.strokeWidth * 4),
      });
      this.requestRender();
      return;
    }

    this.drag = {
      tool: this.tool,
      start: p,
      current: p,
      points: [p],
      handle: null,
      originRect: { ...(this.selection as Rect) },
    };
    this.requestRender();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.toCanvas(e);
    this.cursor = p;

    if (!this.drag) {
      this.requestRender();
      return;
    }

    // Shift constrains: square/circle for rects, 45-degree steps for lines.
    this.drag.current = e.shiftKey ? this.constrain(this.drag.start, p) : p;
    this.drag.points.push(this.drag.current);

    if (this.drag.handle && this.selection) {
      this.selection = clampRect(
        this.resizeSelection(this.drag.originRect, this.drag.handle, this.drag.start, p),
        this.bounds,
      );
    }

    this.requestRender();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    const drag = this.drag;
    this.drag = null;

    if (this.phase === "select") {
      const r = normalizeRect(drag.start, drag.current);
      if (r.w < MIN_SELECTION || r.h < MIN_SELECTION) {
        // Treat a click-without-drag as "select this whole monitor".
        this.selection = this.monitorAt(drag.start);
      } else {
        this.selection = clampRect(r, this.bounds);
      }
      this.phase = "edit";
      this.tool = "select";
      this.host.onStatus("Drag to adjust · pick a tool · Enter to copy");
      this.requestRender();
      return;
    }

    if (drag.handle) {
      this.requestRender();
      return;
    }

    const shape = this.buildShape(drag);
    if (shape) {
      this.pushHistory();
      this.shapes.push(shape);
    }
    this.requestRender();
  };

  private onDoubleClick = (): void => {
    // Double click inside the selection = copy and be done.
    if (this.phase === "edit") this.run("copy");
  };

  private constrain(from: Point, to: Point): Point {
    if (this.tool === "line" || this.tool === "arrow") {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const step = Math.PI / 4;
      const snapped = Math.round(angle / step) * step;
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      return { x: from.x + Math.cos(snapped) * len, y: from.y + Math.sin(snapped) * len };
    }
    const size = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    return {
      x: from.x + Math.sign(to.x - from.x) * size,
      y: from.y + Math.sign(to.y - from.y) * size,
    };
  }

  private buildShape(drag: Drag): Shape | null {
    const { start, current, points } = drag;
    const rect = normalizeRect(start, current);
    const moved = Math.hypot(current.x - start.x, current.y - start.y);

    switch (drag.tool) {
      case "redact": {
        if (rect.w < 3 || rect.h < 3) return null;
        // Pad the box so its outline does not reveal the extent of what it hid,
        // but never spill outside the selection.
        const padded = this.selection
          ? padRect(rect, this.settings.redact_padding ?? 0, this.selection)
          : snap(rect);
        return {
          kind: "redact",
          rect: padded,
          style: this.redactStyle,
          seed: newSeed(),
          strength: this.redactStrength,
        };
      }
      case "rect":
        if (rect.w < 3 || rect.h < 3) return null;
        return { kind: "rect", rect, color: this.color, width: this.strokeWidth, filled: false };
      case "ellipse":
        if (rect.w < 3 || rect.h < 3) return null;
        return { kind: "ellipse", rect, color: this.color, width: this.strokeWidth, filled: false };
      case "arrow":
        if (moved < 6) return null;
        return { kind: "arrow", from: start, to: current, color: this.color, width: this.strokeWidth };
      case "line":
        if (moved < 4) return null;
        return { kind: "line", from: start, to: current, color: this.color, width: this.strokeWidth };
      case "pen":
        return { kind: "pen", points: [...points], color: this.color, width: this.strokeWidth };
      case "highlight":
        return {
          kind: "highlight",
          points: [...points],
          color: this.color,
          width: this.strokeWidth * 4,
        };
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // selection handles
  // -------------------------------------------------------------------------

  private handlePoints(r: Rect): Record<Exclude<Handle, "move" | null>, Point> {
    return {
      nw: { x: r.x, y: r.y },
      n: { x: r.x + r.w / 2, y: r.y },
      ne: { x: r.x + r.w, y: r.y },
      e: { x: r.x + r.w, y: r.y + r.h / 2 },
      se: { x: r.x + r.w, y: r.y + r.h },
      s: { x: r.x + r.w / 2, y: r.y + r.h },
      sw: { x: r.x, y: r.y + r.h },
      w: { x: r.x, y: r.y + r.h / 2 },
    };
  }

  private hitHandle(p: Point): Handle {
    if (!this.selection) return null;
    const hit = HANDLE_HIT * (this.geometry.scale || 1);
    for (const [name, pt] of Object.entries(this.handlePoints(this.selection))) {
      if (Math.abs(p.x - pt.x) <= hit && Math.abs(p.y - pt.y) <= hit) {
        return name as Handle;
      }
    }
    return pointInRect(p, this.selection) ? "move" : null;
  }

  private resizeSelection(origin: Rect, handle: Handle, start: Point, now: Point): Rect {
    const dx = now.x - start.x;
    const dy = now.y - start.y;
    if (handle === "move") {
      return { ...origin, x: origin.x + dx, y: origin.y + dy };
    }
    let { x, y, w, h } = origin;
    if (handle?.includes("n")) {
      y += dy;
      h -= dy;
    }
    if (handle?.includes("s")) h += dy;
    if (handle?.includes("w")) {
      x += dx;
      w -= dx;
    }
    if (handle?.includes("e")) w += dx;
    // Normalize so dragging a handle past the opposite edge flips cleanly.
    return normalizeRect({ x, y }, { x: x + w, y: y + h });
  }

  /**
   * Rect of the monitor containing `p`, in canvas pixels — so a click without a
   * drag grabs just that screen rather than the whole multi-monitor desktop.
   */
  private monitorAt(p: Point): Rect {
    for (const m of this.geometry.monitors ?? []) {
      const r = { x: m.x, y: m.y, w: m.w, h: m.h };
      if (pointInRect(p, r)) return clampRect(r, this.bounds);
    }
    return this.bounds;
  }

  // -------------------------------------------------------------------------
  // text entry
  // -------------------------------------------------------------------------

  private beginTextEntry(at: Point): void {
    const box = this.canvas.getBoundingClientRect();
    const scaleX = box.width / this.canvas.width;
    const scaleY = box.height / this.canvas.height;

    const input = document.createElement("textarea");
    input.className = "vs-text-input";
    input.style.left = `${box.left + at.x * scaleX}px`;
    input.style.top = `${box.top + at.y * scaleY}px`;
    input.style.color = this.color;
    input.style.fontSize = `${this.textSize * scaleY}px`;
    document.body.appendChild(input);
    // Focus on the next frame: focusing during the pointerdown that created it
    // can be undone by the browser's own focus handling for the click.
    requestAnimationFrame(() => input.focus());

    const commit = () => {
      const value = input.value.trim();
      input.remove();
      if (value) {
        this.pushHistory();
        this.shapes.push({
          kind: "text",
          at,
          text: value,
          color: this.color,
          size: this.textSize,
        });
        this.requestRender();
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        input.blur();
      }
    });
  }

  // -------------------------------------------------------------------------
  // history
  // -------------------------------------------------------------------------

  private pushHistory(): void {
    this.undoStack.push(this.shapes.map((s) => ({ ...s })));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.shapes.map((s) => ({ ...s })));
    this.shapes = prev;
    this.requestRender();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.shapes.map((s) => ({ ...s })));
    this.shapes = next;
    this.requestRender();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get hasSelection(): boolean {
    return this.phase === "edit" && !!this.selection;
  }
  get selectionRect(): Rect | null {
    return this.selection;
  }

  // -------------------------------------------------------------------------
  // export
  // -------------------------------------------------------------------------

  /**
   * Produce the flattened result. Everything downstream (clipboard, disk, pin,
   * OCR) goes through this, so nothing can ever ship the un-redacted original
   * by accident.
   */
  render(): HTMLCanvasElement | null {
    if (!this.selection) return null;
    const r = snap(clampRect(this.selection, this.bounds));
    if (r.w < 1 || r.h < 1) return null;
    return flatten(this.source, this.shapes, r);
  }

  run(action: EditorAction): void {
    if (action === "cancel") {
      this.host.onAction("cancel", null);
      return;
    }
    const canvas = this.render();
    if (!canvas) {
      this.host.onStatus("Select a region first", "error");
      return;
    }
    this.host.onAction(action, canvas);
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  requestRender(): void {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      this.paint();
    });
  }

  /**
   * Paint synchronously, right now. Used before the overlay window is shown:
   * a hidden window may not run requestAnimationFrame, so we draw the frozen
   * frame + dim into the canvas backing store directly, then reveal the window
   * already rendered instead of flashing an empty transparent overlay.
   */
  renderNow(): void {
    this.frameQueued = false;
    this.paint();
  }

  private paint(): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.source, 0, 0, width, height);

    const sel = this.selection;

    // Dim everything outside the selection.
    ctx.fillStyle = "rgba(10, 12, 16, 0.55)";
    if (!sel || this.phase === "select" && !this.drag) {
      ctx.fillRect(0, 0, width, height);
    } else if (sel) {
      const r = clampRect(sel, this.bounds);
      ctx.fillRect(0, 0, width, r.y);
      ctx.fillRect(0, r.y + r.h, width, height - (r.y + r.h));
      ctx.fillRect(0, r.y, r.x, r.h);
      ctx.fillRect(r.x + r.w, r.y, width - (r.x + r.w), r.h);
    }

    // Annotations, clipped to the selection.
    if (sel) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(sel.x, sel.y, sel.w, sel.h);
      ctx.clip();
      for (const shape of this.shapes) drawShape(ctx, shape);
      if (this.drag && !this.drag.handle) {
        const preview = this.buildShape(this.drag);
        if (preview) drawShape(ctx, preview);
      }
      ctx.restore();
    }

    if (sel) this.paintSelectionChrome(ctx, sel);
    if (this.phase === "select" && this.settings.show_magnifier && !this.drag) {
      this.paintMagnifier(ctx);
    }
  }

  private paintSelectionChrome(ctx: CanvasRenderingContext2D, sel: Rect): void {
    const s = this.geometry.scale || 1;
    ctx.save();
    ctx.strokeStyle = "#4da3ff";
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w, sel.h);

    // Size readout, flipped inside the selection when it would run off-screen.
    const label = `${Math.round(sel.w)} × ${Math.round(sel.h)}`;
    ctx.font = `600 ${13 * s}px "Segoe UI", system-ui, sans-serif`;
    const tw = ctx.measureText(label).width;
    const lh = 22 * s;
    const lx = Math.min(sel.x, this.canvas.width - tw - 16 * s);
    const ly = sel.y > lh + 6 * s ? sel.y - lh - 6 * s : sel.y + 6 * s;
    ctx.fillStyle = "rgba(12, 14, 18, 0.88)";
    ctx.fillRect(lx, ly, tw + 16 * s, lh);
    ctx.fillStyle = "#e8edf5";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 8 * s, ly + lh / 2);

    if (this.phase === "edit") {
      const hs = 4 * s;
      ctx.fillStyle = "#4da3ff";
      ctx.strokeStyle = "#0b0e14";
      ctx.lineWidth = Math.max(1, s);
      for (const pt of Object.values(this.handlePoints(sel))) {
        ctx.fillRect(pt.x - hs, pt.y - hs, hs * 2, hs * 2);
        ctx.strokeRect(pt.x - hs, pt.y - hs, hs * 2, hs * 2);
      }
    }
    ctx.restore();
  }

  /** Loupe with the pixel colour under the cursor — for pixel-exact starts. */
  private paintMagnifier(ctx: CanvasRenderingContext2D): void {
    const s = this.geometry.scale || 1;
    const size = 108 * s;
    const zoom = 7;
    const src = size / zoom;
    const { x, y } = this.cursor;

    let mx = x + 18 * s;
    let my = y + 18 * s;
    if (mx + size > this.canvas.width) mx = x - size - 18 * s;
    if (my + size + 26 * s > this.canvas.height) my = y - size - 18 * s;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.beginPath();
    ctx.rect(mx, my, size, size);
    ctx.clip();
    ctx.drawImage(this.source, x - src / 2, y - src / 2, src, src, mx, my, size, size);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(mx + 0.5, my + 0.5, size, size);
    // Crosshair on the exact target pixel.
    ctx.strokeStyle = "rgba(77, 163, 255, 0.95)";
    ctx.beginPath();
    ctx.moveTo(mx + size / 2, my);
    ctx.lineTo(mx + size / 2, my + size);
    ctx.moveTo(mx, my + size / 2);
    ctx.lineTo(mx + size, my + size / 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(12, 14, 18, 0.9)";
    ctx.fillRect(mx, my + size, size, 24 * s);
    ctx.fillStyle = "#e8edf5";
    ctx.font = `500 ${12 * s}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(x)}, ${Math.round(y)}`, mx + 8 * s, my + size + 12 * s);
    ctx.restore();
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.source.close();
  }
}
