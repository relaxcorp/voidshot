import type { Rect, RedactStyle } from "./redact";

export type { Rect, RedactStyle };

export interface Point {
  x: number;
  y: number;
}

export type ToolId =
  | "select"
  | "redact"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "pen"
  | "highlight"
  | "text"
  | "counter";

export type Shape =
  | { kind: "rect"; rect: Rect; color: string; width: number; filled: boolean }
  | { kind: "ellipse"; rect: Rect; color: string; width: number; filled: boolean }
  | { kind: "arrow"; from: Point; to: Point; color: string; width: number }
  | { kind: "line"; from: Point; to: Point; color: string; width: number }
  | { kind: "pen"; points: Point[]; color: string; width: number }
  | { kind: "highlight"; points: Point[]; color: string; width: number }
  | { kind: "text"; at: Point; text: string; color: string; size: number }
  | { kind: "counter"; at: Point; n: number; color: string; size: number }
  | {
      kind: "redact";
      rect: Rect;
      style: RedactStyle;
      seed: number;
      strength: number;
    };

export interface Settings {
  hotkey: string;
  save_dir: string;
  format: string;
  jpeg_quality: number;
  copy_on_save: boolean;
  quick_save: boolean;
  redact_style: RedactStyle;
  redact_padding: number;
  show_magnifier: boolean;
}

export interface MonitorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DesktopGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  pixel_width: number;
  pixel_height: number;
  scale: number;
  /** Per-monitor rects in canvas pixels; empty if the backend could not list them. */
  monitors: MonitorRect[];
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function clampRect(r: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, Math.min(r.x, bounds.x + bounds.w));
  const y = Math.max(bounds.y, Math.min(r.y, bounds.y + bounds.h));
  const right = Math.max(bounds.x, Math.min(r.x + r.w, bounds.x + bounds.w));
  const bottom = Math.max(bounds.y, Math.min(r.y + r.h, bounds.y + bounds.h));
  return { x, y, w: right - x, h: bottom - y };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
