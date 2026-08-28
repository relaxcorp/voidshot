/**
 * Offline preview of the overlay editor — no Tauri backend involved.
 *
 * Renders a synthetic "screen" full of things you would actually want to hide,
 * then drives the real Editor/toolbar so the UI can be reviewed and
 * screenshotted without a desktop session.
 */
import { Editor } from "../src/editor";
import { buildToolbar } from "../src/toolbar";
import { newSeed } from "../src/redact";
import type { DesktopGeometry, Settings } from "../src/types";

const COLORS = ["#ff3b30", "#ff9f0a", "#ffe14d", "#32d74b", "#4da3ff", "#bf5af2", "#ffffff", "#101418"];

const W = 1440;
const H = 900;

function paintFakeScreen(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // desktop backdrop
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1d2b45");
  bg.addColorStop(1, "#0e1524");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // app window
  const win = { x: 150, y: 110, w: 1140, h: 660 };
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.filter = "blur(24px)";
  ctx.fillRect(win.x + 8, win.y + 20, win.w, win.h);
  ctx.filter = "none";

  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(win.x, win.y, win.w, win.h);
  ctx.fillStyle = "#e9ecf1";
  ctx.fillRect(win.x, win.y, win.w, 46);
  ctx.fillStyle = "#c9ced8";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(win.x + 24 + i * 20, win.y + 23, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#5b6472";
  ctx.font = '600 14px "DejaVu Sans", sans-serif';
  ctx.fillText("Billing — account settings", win.x + 100, win.y + 28);

  const rows: Array<[string, string]> = [
    ["Account owner", "Jordan Avery"],
    ["Email", "jordan.avery@acme.example"],
    ["API key", "sk_live_9F31c8Ae21Bd77Ee0042KqZ"],
    ["Card on file", "4539  8821  0037  1194"],
    ["Billing address", "2100 Market St, Apt 4"],
    ["Phone", "+1 (555) 017-4423"],
    ["Recovery code", "8842-QQ31-7X09-LLM2"],
  ];

  let y = win.y + 100;
  for (const [label, value] of rows) {
    ctx.fillStyle = "#8b94a3";
    ctx.font = '500 15px "DejaVu Sans", sans-serif';
    ctx.fillText(label, win.x + 48, y);

    ctx.fillStyle = "#171b22";
    ctx.font = '600 19px "DejaVu Sans Mono", monospace';
    ctx.fillText(value, win.x + 320, y);

    ctx.strokeStyle = "#e4e8ee";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(win.x + 48, y + 22);
    ctx.lineTo(win.x + win.w - 48, y + 22);
    ctx.stroke();

    y += 62;
  }

  ctx.fillStyle = "#4da3ff";
  ctx.fillRect(win.x + 48, y + 14, 160, 42);
  ctx.fillStyle = "#fff";
  ctx.font = '600 15px "DejaVu Sans", sans-serif';
  ctx.fillText("Save changes", win.x + 76, y + 40);

  return c;
}

async function boot(): Promise<void> {
  const fake = paintFakeScreen();
  const bitmap = await createImageBitmap(fake);

  const geometry: DesktopGeometry = {
    x: 0,
    y: 0,
    width: W,
    height: H,
    pixel_width: W,
    pixel_height: H,
    scale: 1,
    monitors: [{ x: 0, y: 0, w: W, h: H }],
  };

  const settings: Settings = {
    hotkey: "PrintScreen",
    save_dir: "",
    format: "png",
    jpeg_quality: 92,
    copy_on_save: true,
    quick_save: false,
    redact_style: "blur",
    redact_padding: 2,
    show_magnifier: true,
    autostart: true,
  };

  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const editor = new Editor(canvas, bitmap, geometry, settings, {
    onAction: (action) => console.log("action:", action),
    onStatus: (m) => {
      const el = document.getElementById("status")!;
      el.textContent = m;
      el.classList.add("visible");
    },
  });

  // Scripted state so the screenshot shows a realistic in-progress edit.
  // Rows are laid out at y = 210 + 62*i with a 19px baseline, so a value's ink
  // spans roughly [y-20, y+6].
  const rowY = (i: number) => 210 + i * 62;
  const VAL_X = 468;

  const e = editor as unknown as {
    phase: string;
    selection: { x: number; y: number; w: number; h: number };
    shapes: unknown[];
    tool: string;
    requestRender(): void;
  };
  e.phase = "edit";
  e.selection = { x: 150, y: 110, w: 1140, h: 660 };
  e.tool = "redact";
  e.shapes = [
    // API key (row 2) — blur style
    { kind: "redact", rect: { x: VAL_X, y: rowY(2) - 24, w: 372, h: 32 }, style: "blur", seed: newSeed(), strength: 14 },
    // card number (row 3) — mosaic style
    { kind: "redact", rect: { x: VAL_X, y: rowY(3) - 24, w: 268, h: 32 }, style: "mosaic", seed: newSeed(), strength: 12 },
    // recovery code (row 6) — solid style
    { kind: "redact", rect: { x: VAL_X, y: rowY(6) - 24, w: 238, h: 32 }, style: "solid", seed: newSeed(), strength: 10 },
    // annotations
    { kind: "rect", rect: { x: 458, y: rowY(2) - 32, w: 392, h: 48 }, color: "#ff3b30", width: 3, filled: false },
    { kind: "arrow", from: { x: 960, y: 250 }, to: { x: 856, y: rowY(2) - 12 }, color: "#ff3b30", width: 4 },
    { kind: "text", at: { x: 966, y: 232 }, text: "never ships", color: "#ff3b30", size: 22 },
    { kind: "counter", at: { x: 428, y: rowY(2) - 8 }, n: 1, color: "#4da3ff", size: 18 },
    { kind: "counter", at: { x: 428, y: rowY(3) - 8 }, n: 2, color: "#4da3ff", size: 18 },
    { kind: "counter", at: { x: 428, y: rowY(6) - 8 }, n: 3, color: "#4da3ff", size: 18 },
    { kind: "highlight", points: [{ x: 478, y: rowY(1) - 8 }, { x: 720, y: rowY(1) - 8 }], color: "#ffe14d", width: 26 },
  ];

  // Build the toolbar last: it syncs its active states from the editor.
  buildToolbar(document.getElementById("toolbar") as HTMLDivElement, editor, COLORS, () =>
    editor.requestRender(),
  );

  e.requestRender();

  (window as unknown as { __ready: boolean }).__ready = true;
}

void boot();
