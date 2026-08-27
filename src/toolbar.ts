import type { Editor } from "./editor";
import type { RedactStyle, ToolId } from "./types";

export interface ToolbarHandle {
  sync(): void;
  destroy(): void;
}

const ICONS: Record<string, string> = {
  select: `<path d="M4 3l14 6.5-5.8 1.7-1.7 5.8z"/>`,
  redact: `<rect x="3" y="6" width="16" height="10" rx="2"/><path d="M6 11h2m2 0h2m2 0h2" stroke="var(--bg)" stroke-width="1.6" fill="none"/>`,
  rect: `<rect x="3.5" y="5.5" width="15" height="11" rx="1.5" fill="none" stroke-width="2"/>`,
  ellipse: `<ellipse cx="11" cy="11" rx="7.5" ry="5.5" fill="none" stroke-width="2"/>`,
  arrow: `<path d="M4 18L16 6M16 6h-6M16 6v6" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  line: `<path d="M4 17L18 5" fill="none" stroke-width="2" stroke-linecap="round"/>`,
  pen: `<path d="M4 18c3-1 4-2 6-6s4-6 6-7c1.5-.8 2.5.6 1.6 2-1 1.6-3 3-5 4.6-2.6 2-4.6 4-5.6 6.4z" />`,
  highlight: `<path d="M5 15l7-9 4 3-7 9H5z"/><rect x="4" y="17" width="12" height="2" rx="1"/>`,
  text: `<path d="M4 5h14v3M11 5v13M8 18h6" fill="none" stroke-width="2" stroke-linecap="round"/>`,
  counter: `<circle cx="11" cy="11" r="7.5" fill="none" stroke-width="2"/><path d="M9.5 8.5L11 7.5V15" fill="none" stroke-width="2" stroke-linecap="round"/>`,
  undo: `<path d="M7 8H14a4.5 4.5 0 010 9h-4M7 8l3-3M7 8l3 3" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  redo: `<path d="M15 8H8a4.5 4.5 0 000 9h4M15 8l-3-3M15 8l-3 3" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  ocr: `<path d="M4 7V4h3M18 7V4h-3M4 15v3h3M18 15v3h-3" fill="none" stroke-width="2" stroke-linecap="round"/><path d="M7.5 14l3-7 3 7M8.6 12h3.8" fill="none" stroke-width="1.8" stroke-linecap="round"/>`,
  pin: `<path d="M9 3h4l-.6 5.2 3.1 2.4-.5 1.4h-3.6L11 19l-1.4-7H6l-.5-1.4 3.1-2.4z"/>`,
  save: `<path d="M4.5 4.5h10L17.5 7.5v10h-13z" fill="none" stroke-width="2" stroke-linejoin="round"/><path d="M7.5 4.5v4h6v-4M7.5 17.5v-5h7v5" fill="none" stroke-width="1.6"/>`,
  copy: `<rect x="7" y="7" width="10" height="11" rx="2" fill="none" stroke-width="2"/><path d="M13 4H5v11" fill="none" stroke-width="2" stroke-linecap="round"/>`,
  close: `<path d="M6 6l10 10M16 6L6 16" fill="none" stroke-width="2.2" stroke-linecap="round"/>`,
  chevron: `<path d="M6 9l5 5 5-5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
};

function icon(name: string): string {
  return `<svg viewBox="0 0 22 22" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

const TOOLS: Array<{ id: ToolId; label: string; key: string }> = [
  { id: "select", label: "Move / resize", key: "V" },
  { id: "redact", label: "Redact — irreversible", key: "B" },
  { id: "rect", label: "Rectangle", key: "R" },
  { id: "ellipse", label: "Ellipse", key: "E" },
  { id: "arrow", label: "Arrow", key: "A" },
  { id: "line", label: "Line", key: "L" },
  { id: "pen", label: "Pen", key: "P" },
  { id: "highlight", label: "Highlighter", key: "H" },
  { id: "text", label: "Text", key: "T" },
  { id: "counter", label: "Numbered step", key: "N" },
];

const REDACT_STYLES: Array<{ id: RedactStyle; label: string }> = [
  { id: "blur", label: "Blur" },
  { id: "mosaic", label: "Mosaic" },
  { id: "solid", label: "Solid" },
];

/** Keep a value within [lo, hi]; if the range is empty, sit in its middle. */
function clamp(v: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.max(lo, Math.min(v, hi));
}

export function buildToolbar(
  root: HTMLDivElement,
  editor: Editor,
  colors: string[],
  onChange: () => void,
): ToolbarHandle {
  root.innerHTML = `
    <div class="vs-grip" id="vs-grip" title="Drag to move the toolbar" aria-hidden="true">
      <svg viewBox="0 0 8 20"><circle cx="2" cy="4" r="1.3"/><circle cx="6" cy="4" r="1.3"/><circle cx="2" cy="10" r="1.3"/><circle cx="6" cy="10" r="1.3"/><circle cx="2" cy="16" r="1.3"/><circle cx="6" cy="16" r="1.3"/></svg>
    </div>
    <div class="vs-group" id="vs-tools">
      ${TOOLS.map(
        (t) => `<button class="vs-btn" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">${icon(t.id)}</button>`,
      ).join("")}
    </div>
    <div class="vs-sep"></div>
    <!-- Colour is collapsed into a single swatch that opens a popover, so the
         bar stays short instead of showing the whole palette inline. -->
    <div class="vs-group" id="vs-color">
      <button class="vs-swatch vs-color-toggle" id="vs-color-toggle" title="Colour"></button>
      <div class="vs-pop" id="vs-color-pop" hidden>
        ${colors
          .map((c) => `<button class="vs-swatch" data-color="${c}" style="--swatch:${c}" title="${c}"></button>`)
          .join("")}
      </div>
    </div>
    <div class="vs-group vs-stack" id="vs-width">
      <input type="range" min="1" max="24" step="1" value="4" aria-label="Stroke width" />
    </div>
    <!-- Redaction style is also collapsed behind one button + popover. -->
    <div class="vs-group vs-redact" id="vs-redact" hidden>
      <button class="vs-btn vs-redact-toggle" id="vs-redact-toggle" title="Redaction style">
        <span id="vs-redact-label">Blur</span>${icon("chevron")}
      </button>
      <div class="vs-pop" id="vs-redact-pop" hidden>
        ${REDACT_STYLES.map(
          (s) => `<button class="vs-chip" data-style="${s.id}">${s.label}</button>`,
        ).join("")}
      </div>
      <input type="range" min="4" max="40" step="1" value="14" aria-label="Redaction strength" />
    </div>
    <div class="vs-sep"></div>
    <div class="vs-group">
      <button class="vs-btn" data-cmd="undo" title="Undo (Ctrl+Z)">${icon("undo")}</button>
      <button class="vs-btn" data-cmd="redo" title="Redo (Ctrl+Shift+Z)">${icon("redo")}</button>
    </div>
    <div class="vs-sep"></div>
    <div class="vs-group">
      <button class="vs-btn" data-cmd="pin" title="Pin on top">${icon("pin")}</button>
      <button class="vs-btn" data-cmd="save" title="Save (Ctrl+S)">${icon("save")}</button>
      <button class="vs-btn vs-primary" data-cmd="copy" title="Copy (Enter)">${icon("copy")}</button>
      <button class="vs-btn vs-danger" data-cmd="cancel" title="Cancel (Esc)">${icon("close")}</button>
    </div>
  `;

  const widthInput = root.querySelector<HTMLInputElement>("#vs-width input")!;
  const redactPanel = root.querySelector<HTMLDivElement>("#vs-redact")!;
  const strengthInput = redactPanel.querySelector<HTMLInputElement>("input")!;
  const colorToggle = root.querySelector<HTMLButtonElement>("#vs-color-toggle")!;
  const colorPop = root.querySelector<HTMLDivElement>("#vs-color-pop")!;
  const redactPop = root.querySelector<HTMLDivElement>("#vs-redact-pop")!;
  const redactLabel = root.querySelector<HTMLSpanElement>("#vs-redact-label")!;

  // Manual position while the user is dragging the bar. Not persisted — it lives
  // only for this capture and resets when the next screenshot rebuilds the bar.
  let userPos: { x: number; y: number } | null = null;

  root.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    // Buttons, inputs and popovers do their own thing; drag only from empty
    // toolbar space or the grip.
    if (t.closest("button, input, .vs-pop") && !t.closest("#vs-grip")) return;

    const rect = root.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;

    const onMove = (ev: PointerEvent) => {
      let x = ev.clientX - offX;
      let y = ev.clientY - offY;
      x = clamp(x, 6, window.innerWidth - rect.width - 6);
      y = clamp(y, 6, window.innerHeight - rect.height - 6);
      userPos = { x, y };
      root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  function closePops(): void {
    colorPop.hidden = true;
    redactPop.hidden = true;
  }

  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    if (target.closest("#vs-color-toggle")) {
      const show = colorPop.hidden;
      closePops();
      colorPop.hidden = !show;
      return;
    }
    if (target.closest("#vs-redact-toggle")) {
      const show = redactPop.hidden;
      closePops();
      redactPop.hidden = !show;
      return;
    }

    const toolBtn = target.closest<HTMLButtonElement>("[data-tool]");
    if (toolBtn) {
      editor.tool = toolBtn.dataset.tool as ToolId;
      closePops();
      sync();
      return;
    }

    const swatch = target.closest<HTMLButtonElement>("[data-color]");
    if (swatch) {
      editor.color = swatch.dataset.color!;
      colorPop.hidden = true;
      sync();
      return;
    }

    const chip = target.closest<HTMLButtonElement>("[data-style]");
    if (chip) {
      editor.redactStyle = chip.dataset.style as RedactStyle;
      redactPop.hidden = true;
      sync();
      return;
    }

    const cmd = target.closest<HTMLButtonElement>("[data-cmd]")?.dataset.cmd;
    if (!cmd) return;
    closePops();
    switch (cmd) {
      case "undo":
        editor.undo();
        break;
      case "redo":
        editor.redo();
        break;
      default:
        editor.run(cmd as never);
        return;
    }
    sync();
  });

  widthInput.addEventListener("input", () => {
    editor.strokeWidth = Number(widthInput.value);
    editor.textSize = Math.max(14, Number(widthInput.value) * 5);
    onChange();
  });

  strengthInput.addEventListener("input", () => {
    editor.redactStrength = Number(strengthInput.value);
    onChange();
  });

  function sync(): void {
    root.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === editor.tool);
    });
    root.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === editor.color);
    });
    root.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((b) => {
      b.classList.toggle("active", b.dataset.style === editor.redactStyle);
    });
    colorToggle.style.setProperty("--swatch", editor.color);
    const activeStyle = REDACT_STYLES.find((s) => s.id === editor.redactStyle);
    if (activeStyle) redactLabel.textContent = activeStyle.label;

    // Redaction has its own controls and no colour, so swap the panels.
    const isRedact = editor.tool === "redact";
    redactPanel.hidden = !isRedact;
    root.querySelector<HTMLDivElement>("#vs-color")!.hidden = isRedact;
    root.querySelector<HTMLDivElement>("#vs-width")!.hidden = isRedact;
    if (isRedact) colorPop.hidden = true;
    else redactPop.hidden = true;

    root.querySelector<HTMLButtonElement>('[data-cmd="undo"]')!.disabled = !editor.canUndo;
    root.querySelector<HTMLButtonElement>('[data-cmd="redo"]')!.disabled = !editor.canRedo;

    position();
  }

  /**
   * Park the toolbar INSIDE the selection, near its bottom edge. Anchoring to
   * the selection (not the desktop) keeps it on the same monitor and always
   * visible — even for a full-screen selection, and even across a 3-monitor
   * setup where clamping to the whole virtual desktop used to fling it onto a
   * neighbouring screen.
   */
  function position(): void {
    const sel = editor.selectionRect;
    if (!editor.hasSelection || !sel) {
      root.classList.remove("visible");
      closePops();
      return;
    }
    root.classList.add("visible");

    // Once the user has dragged the bar, respect that and stop auto-placing it.
    if (userPos) {
      root.style.transform = `translate(${Math.round(userPos.x)}px, ${Math.round(userPos.y)}px)`;
      return;
    }

    // Selection is in canvas pixels; the toolbar lives in CSS pixels.
    const stage = document.getElementById("stage") as HTMLCanvasElement;
    const box = stage.getBoundingClientRect();
    const sx = box.width / stage.width;
    const sy = box.height / stage.height;

    const selL = box.left + sel.x * sx;
    const selT = box.top + sel.y * sy;
    const selW = sel.w * sx;
    const selH = sel.h * sy;

    const tb = root.getBoundingClientRect();
    const gap = 12;
    const vpGap = 6;

    // Horizontal: centre within the selection, clamped inside it.
    let x = selL + selW / 2 - tb.width / 2;
    x = clamp(x, selL + gap, selL + selW - tb.width - gap);
    x = clamp(x, vpGap, window.innerWidth - tb.width - vpGap);

    // Vertical: sit inside near the bottom when the selection is tall enough;
    // otherwise tuck it just below/above, still clamped to the viewport.
    let y: number;
    if (selH >= tb.height + gap * 2) {
      y = selT + selH - tb.height - gap;
    } else {
      y = selT + selH + gap;
      if (y + tb.height > window.innerHeight - vpGap) y = selT - tb.height - gap;
    }
    y = clamp(y, vpGap, window.innerHeight - tb.height - vpGap);

    root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // The editor repaints on its own schedule; poll for geometry changes rather
  // than threading a change event through every interaction path.
  let raf = 0;
  const loop = () => {
    position();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  const destroy = () => {
    cancelAnimationFrame(raf);
    root.innerHTML = "";
    root.classList.remove("visible");
  };
  window.addEventListener("beforeunload", () => cancelAnimationFrame(raf));

  sync();
  return { sync, destroy };
}
