import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const img = document.getElementById("pin-image") as HTMLImageElement;
const appWindow = getCurrentWindow();

async function boot(): Promise<void> {
  try {
    const raw = await invoke<ArrayBuffer | Uint8Array | number[]>("pin_bytes");
    // Tauri may hand back an ArrayBuffer, a typed array, or a plain number[]
    // depending on the IPC path; normalise so the Blob is always valid PNG.
    const bytes =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw as number[]);
    if (bytes.byteLength === 0) {
      img.alt = "Pin data was empty";
      return;
    }
    const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
    img.onerror = () => {
      img.alt = "Pin image failed to decode";
    };
    img.src = URL.createObjectURL(blob);
  } catch (e) {
    img.alt = `Pin failed: ${e}`;
  }
}

// Dragging anywhere moves the window — the pin has no title bar.
document.body.addEventListener("pointerdown", (e) => {
  if (e.button === 0) void appWindow.startDragging();
});

document.body.addEventListener("dblclick", () => {
  void invoke("copy_pin");
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    void invoke("close_pin");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    e.preventDefault();
    void invoke("copy_pin");
  }
});

// Wheel resizes the pin around its current position.
window.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    void (async () => {
      const size = await appWindow.innerSize();
      const scale = await appWindow.scaleFactor();
      const logical = size.toLogical(scale);
      await appWindow.setSize({
        type: "Logical",
        width: Math.max(60, logical.width * factor),
        height: Math.max(40, logical.height * factor),
      } as never);
    })();
  },
  { passive: false },
);

void boot();
