import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Editor, type EditorAction } from "./editor";
import type { DesktopGeometry, RedactStyle, Settings, ToolId } from "./types";
import { buildToolbar, type ToolbarHandle } from "./toolbar";

const COLORS = ["#ff3b30", "#ff9f0a", "#ffe14d", "#32d74b", "#4da3ff", "#bf5af2", "#ffffff", "#101418"];

let editor: Editor | null = null;
let toolbar: ToolbarHandle | null = null;

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
      return;
    }
    if (e.key.toLowerCase() === "o") {
      e.preventDefault();
      editor.run("ocr");
    }
  });
}

async function boot(): Promise<void> {
  const settings = await invoke<Settings>("get_settings").catch(
    () =>
      ({
        hotkey: "",
        save_dir: "",
        format: "png",
        jpeg_quality: 92,
        copy_on_save: true,
        quick_save: false,
        redact_style: "blur" as RedactStyle,
        redact_padding: 2,
        show_magnifier: true,
      }) satisfies Settings,
  );

  const geometry = await invoke<DesktopGeometry>("frame_info");
  const raw = await invoke<ArrayBuffer>("frame_pixels");

  const pixels = new Uint8ClampedArray(raw);
  const expected = geometry.pixel_width * geometry.pixel_height * 4;
  if (pixels.byteLength < expected) {
    setStatus("Capture failed — frame is incomplete", "error");
    await invoke("cancel_capture");
    return;
  }

  const imageData = new ImageData(pixels, geometry.pixel_width, geometry.pixel_height);
  const bitmap = await createImageBitmap(imageData);

  editor = new Editor(canvas, bitmap, geometry, settings, {
    onAction: (action, result) => void handleAction(action, result),
    onStatus: setStatus,
  });

  toolbar = buildToolbar(document.getElementById("toolbar") as HTMLDivElement, editor, COLORS, () =>
    editor?.requestRender(),
  );

  bindHotkeys();
  setStatus("Drag to select a region · Esc to cancel");

  // If something steals the foreground the frozen screenshot underneath is
  // stale, so close rather than show a lie.
  //
  // The grace period matters: focus often flickers in the first moments after
  // the overlay appears, and a false auto-close is far more annoying than an
  // overlay that lingers (Esc always works).
  const openedAt = performance.now();
  const appWindow = getCurrentWindow();
  await appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused || !editor) return;
    if (performance.now() - openedAt < 1500) return;
    if (editor.hasSelection) return;
    void invoke("cancel_capture");
  });
}

void boot().catch((e) => {
  setStatus(`Startup failed: ${e}`, "error");
  window.setTimeout(() => void invoke("cancel_capture"), 2500);
});
