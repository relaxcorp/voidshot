import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Editor, type EditorAction } from "./editor";
import type { DesktopGeometry, RedactStyle, Settings, ToolId } from "./types";
import { buildToolbar, type ToolbarHandle } from "./toolbar";

const COLORS = ["#ff3b30", "#ff9f0a", "#ffe14d", "#32d74b", "#4da3ff", "#bf5af2", "#ffffff", "#101418"];

let editor: Editor | null = null;
let toolbar: ToolbarHandle | null = null;
let openedAt = 0;

const statusEl = document.getElementById("status") as HTMLDivElement;
const canvas = document.getElementById("stage") as HTMLCanvasElement;

function setStatus(message: string, kind: "info" | "error" = "info"): void {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
  statusEl.classList.add("visible");
  window.clearTimeout((setStatus as any)._t);
  (setStatus as any)._t = window.setTimeout(() => {
    statusEl.classList.remove("visible");
  }, kind === "error" ? 4000 : 2200);
}

/** Canvas -> bare base64 PNG (the data-URL prefix is stripped in Rust anyway). */
function canvasToBase64(c: HTMLCanvasElement): string {
  return c.toDataURL("image/png").split(",")[1] ?? "";
}

async function handleAction(action: EditorAction, result: HTMLCanvasElement | null): Promise<void> {
  if (action === "cancel") {
    await invoke("cancel_capture");
    return;
  }
  if (!result) return;

  const image = canvasToBase64(result);

  if (action === "ocr") {
    setStatus("Reading text…");
    try {
      const text = await invoke<string>("ocr_region", { image });
      await invoke("copy_text", { text });
      setStatus(`Text copied (${text.length} chars)`);
      window.setTimeout(() => void invoke("cancel_capture"), 900);
    } catch (e) {
      setStatus(`OCR failed: ${e}`, "error");
    }
    return;
  }

  try {
    const res = await invoke<{ saved_path: string | null; copied: boolean; message: string }>(
      "finish_capture",
      { args: { image, action } },
    );
    setStatus(res.message);
  } catch (e) {
    setStatus(`Failed: ${e}`, "error");
  }
}

function bindHotkeys(): void {
  window.addEventListener("keydown", (e) => {
    if (!editor) return;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === "Escape") {
      e.preventDefault();
      editor.run("cancel");
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) editor.redo();
      else editor.undo();
      toolbar?.sync();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      editor.redo();
      toolbar?.sync();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      editor.run(e.shiftKey ? "save_as" : "save");
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      editor.run("copy");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      editor.run("copy");
      return;
    }

    // Single-key tool switches, only when no modifier is held.
    if (mod || e.altKey) return;
    const byKey: Record<string, ToolId> = {
      v: "select",
      b: "redact",
      r: "rect",
      e: "ellipse",
      a: "arrow",
      l: "line",
      p: "pen",
      h: "highlight",
      t: "text",
      n: "counter",
    };
    const tool = byKey[e.key.toLowerCase()];
    if (tool) {
      e.preventDefault();
      editor.tool = tool;
      toolbar?.sync();
    }
  });
}

const FALLBACK_SETTINGS: Settings = {
  hotkey: "",
  save_dir: "",
  format: "png",
  jpeg_quality: 92,
  copy_on_save: true,
  quick_save: false,
  redact_style: "blur" as RedactStyle,
  redact_padding: 2,
  show_magnifier: true,
};

/**
 * Run one capture: pull the staged frame, (re)build the editor and toolbar,
 * paint, then reveal the window. The overlay window itself is created once at
 * startup and reused — so this path never pays the WebView2 cold-start cost,
 * which was the bulk of the press-to-overlay delay.
 */
interface CaptureTiming {
  capture_ms: number;
  resize_ms: number;
}

/**
 * Load the frozen frame. Prefer the custom protocol (native, fast); if it does
 * not answer within a short budget, fall back to the invoke IPC command so a
 * capture never silently fails — it just loads slower.
 */
async function loadFrame(): Promise<{ raw: ArrayBuffer; via: string }> {
  const url =
    (navigator.userAgent.includes("Windows") ? "http://frame.localhost" : "frame://localhost") +
    "/f?t=" +
    Date.now();
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 600);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      const buf = await resp.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("empty frame from protocol");
      return { raw: buf, via: "proto" };
    } finally {
      window.clearTimeout(timer);
    }
  } catch {
    const buf = await invoke<ArrayBuffer>("frame_pixels");
    return { raw: buf, via: "ipc" };
  }
}

async function startCapture(timing?: CaptureTiming): Promise<void> {
  // Tear down the previous capture's editor/toolbar so we never stack rAF loops
  // or leak the old frame bitmap.
  toolbar?.destroy();
  toolbar = null;
  editor?.destroy();
  editor = null;

  const t0 = performance.now();
  // Fire all three in parallel — settings, geometry and the frame bytes are
  // independent, so there is no reason to wait for them one after another.
  const [settings, geometry, frame] = await Promise.all([
    invoke<Settings>("get_settings").catch(() => FALLBACK_SETTINGS),
    invoke<DesktopGeometry>("frame_info"),
    loadFrame(),
  ]);
  const { raw, via } = frame;
  const tIpc = performance.now();

  const pixels = new Uint8ClampedArray(raw);
  const expected = geometry.pixel_width * geometry.pixel_height * 4;
  if (pixels.byteLength < expected) {
    setStatus("Capture failed — frame is incomplete", "error");
    await invoke("cancel_capture");
    return;
  }

  const imageData = new ImageData(pixels, geometry.pixel_width, geometry.pixel_height);
  const bitmap = await createImageBitmap(imageData);
  const tBmp = performance.now();

  editor = new Editor(canvas, bitmap, geometry, settings, {
    onAction: (action, result) => void handleAction(action, result),
    onStatus: setStatus,
  });

  toolbar = buildToolbar(document.getElementById("toolbar") as HTMLDivElement, editor, COLORS, () =>
    editor?.requestRender(),
  );

  // Paint the frozen frame + dim into the canvas now, then reveal the window so
  // it appears fully rendered instead of flashing an empty overlay.
  editor.renderNow();
  const tPaint = performance.now();
  void invoke("overlay_ready");
  openedAt = performance.now();

  // Diagnostic: show where the press-to-overlay time went, in the status bar.
  const cap = timing?.capture_ms ?? 0;
  const rez = timing?.resize_ms ?? 0;
  setStatus(
    `⏱ grab ${cap} · resize ${rez} · load ${Math.round(tIpc - t0)}(${via}) · decode ${Math.round(
      tBmp - tIpc,
    )} · paint ${Math.round(tPaint - tBmp)} ms — drag to select`,
  );
}

// ---- one-time page setup (the overlay window is long-lived and reused) -------

bindHotkeys();

// A screenshot overlay has no business showing the OS "save image / print"
// context menu, so suppress right-click everywhere on it.
window.addEventListener("contextmenu", (e) => e.preventDefault());

const appWindow = getCurrentWindow();
// If something steals the foreground the frozen screenshot underneath is stale,
// so close rather than show a lie. The grace period avoids a false close from
// the focus flicker right after the overlay appears.
void appWindow.onFocusChanged(({ payload: focused }) => {
  if (focused || !editor) return;
  if (performance.now() - openedAt < 1500) return;
  if (editor.hasSelection) return;
  void invoke("cancel_capture");
});

// Each PrintScreen stages a new frame in the backend and fires this event.
void listen<CaptureTiming>("voidshot:capture", (event) => {
  void startCapture(event.payload).catch((e) => {
    setStatus(`Startup failed: ${e}`, "error");
    window.setTimeout(() => void invoke("cancel_capture"), 2500);
  });
});

// Fallback: if a frame is already staged when this page loads (e.g. the window
// was created on-demand rather than preheated), start immediately.
void invoke<DesktopGeometry>("frame_info")
  .then(() => startCapture())
  .catch(() => {
    /* no frame yet — wait for the voidshot:capture event */
  });
