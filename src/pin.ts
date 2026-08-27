import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const img = document.getElementById("pin-image") as HTMLImageElement;
const appWindow = getCurrentWindow();

async function boot(): Promise<void> {
  const raw = await invoke<ArrayBuffer>("pin_bytes");
  const blob = new Blob([raw], { type: "image/png" });
  img.src = URL.createObjectURL(blob);
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
