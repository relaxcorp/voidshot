import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RedactStyle, Settings } from "./types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const hotkey = $<HTMLInputElement>("hotkey");
const saveDir = $<HTMLInputElement>("save_dir");
const format = $<HTMLSelectElement>("format");
const quality = $<HTMLInputElement>("jpeg_quality");
const qualityVal = $<HTMLOutputElement>("quality_val");
const qualityField = $<HTMLDivElement>("quality_field");
const redactStyle = $<HTMLSelectElement>("redact_style");
const redactPadding = $<HTMLInputElement>("redact_padding");
const copyOnSave = $<HTMLInputElement>("copy_on_save");
const quickSave = $<HTMLInputElement>("quick_save");
const showMagnifier = $<HTMLInputElement>("show_magnifier");
const autostart = $<HTMLInputElement>("autostart");
const savedFlag = $<HTMLSpanElement>("saved");

/** Translate a KeyboardEvent into Tauri's accelerator syntax. */
function toAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const code = e.code;
  let key: string | null = null;

  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === "PrintScreen") key = "PrintScreen";
  else if (code === "Insert") key = "Insert";
  else if (code === "Home") key = "Home";
  else if (code === "End") key = "End";
  else if (code === "PageUp") key = "PageUp";
  else if (code === "PageDown") key = "PageDown";
  else if (code === "Space") key = "Space";
  else if (code === "Backquote") key = "`";

  if (!key) return null;
  // A bare letter would swallow that key system-wide, so require a modifier
  // unless it is a standalone key like PrintScreen or a function key.
  const standalone = /^(PrintScreen|F\d{1,2}|Insert|Home|End|PageUp|PageDown)$/.test(key);
  if (parts.length === 0 && !standalone) return null;

  parts.push(key);
  return parts.join("+");
}

hotkey.addEventListener("keydown", (e) => {
  e.preventDefault();
  const accel = toAccelerator(e);
  if (accel) hotkey.value = accel;
});

format.addEventListener("change", () => {
  qualityField.hidden = format.value !== "jpg";
});

quality.addEventListener("input", () => {
  qualityVal.textContent = quality.value;
});

async function load(): Promise<void> {
  const s = await invoke<Settings>("get_settings");
  hotkey.value = s.hotkey;
  saveDir.value = s.save_dir;
  format.value = s.format === "jpg" || s.format === "jpeg" ? "jpg" : "png";
  quality.value = String(s.jpeg_quality);
  qualityVal.textContent = String(s.jpeg_quality);
  redactStyle.value = s.redact_style;
  redactPadding.value = String(s.redact_padding);
  copyOnSave.checked = s.copy_on_save;
  quickSave.checked = s.quick_save;
  showMagnifier.checked = s.show_magnifier;
  autostart.checked = s.autostart;
  qualityField.hidden = format.value !== "jpg";
}

$<HTMLButtonElement>("save").addEventListener("click", async () => {
  const next: Settings = {
    hotkey: hotkey.value.trim(),
    save_dir: saveDir.value.trim(),
    format: format.value,
    jpeg_quality: Number(quality.value) || 92,
    copy_on_save: copyOnSave.checked,
    quick_save: quickSave.checked,
    redact_style: redactStyle.value as RedactStyle,
    redact_padding: Number(redactPadding.value) || 0,
    show_magnifier: showMagnifier.checked,
    autostart: autostart.checked,
  };
  try {
    await invoke("set_settings", { new: next });
    savedFlag.textContent = "Saved";
    savedFlag.classList.add("visible");
    window.setTimeout(() => savedFlag.classList.remove("visible"), 1800);
  } catch (e) {
    savedFlag.textContent = String(e);
    savedFlag.classList.add("visible");
  }
});

$<HTMLButtonElement>("close").addEventListener("click", () => {
  void getCurrentWindow().close();
});

void load();
