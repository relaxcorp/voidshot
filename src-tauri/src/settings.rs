//! User settings, persisted as JSON in the platform config directory.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// Global hotkey that opens the capture overlay.
    pub hotkey: String,
    /// Where "Save" writes to. Empty means the OS pictures directory.
    pub save_dir: String,
    /// "png" or "jpg".
    pub format: String,
    pub jpeg_quality: u8,
    /// Copy the result to the clipboard on save as well.
    pub copy_on_save: bool,
    /// Skip the file dialog and write straight to `save_dir`.
    pub quick_save: bool,
    /// Default redaction style: "blur", "mosaic" or "solid".
    pub redact_style: String,
    /// Grow every redaction rect by this many pixels, so the shape of the box
    /// does not leak the length of what was hidden.
    pub redact_padding: u32,
    pub show_magnifier: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: default_hotkey().to_string(),
            save_dir: String::new(),
            format: "png".into(),
            jpeg_quality: 92,
            copy_on_save: true,
            quick_save: false,
            redact_style: "blur".into(),
            redact_padding: 2,
            show_magnifier: true,
        }
    }
}

/// PrintScreen is the natural key on Windows. On Linux it is usually already
/// bound by the desktop environment, so default to something free there.
pub fn default_hotkey() -> &'static str {
    if cfg!(windows) {
        "PrintScreen"
    } else {
        "CmdOrControl+Shift+S"
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("resolve app config dir")?;
    std::fs::create_dir_all(&dir).context("create app config dir")?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = config_path(app) else {
        return Settings::default();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    // A corrupt or half-written settings file must never block startup.
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let path = config_path(app)?;
    let raw = serde_json::to_vec_pretty(settings).context("serialize settings")?;
    crate::imageio::write_atomic(&path, &raw)
}

/// Resolve the directory saves land in, falling back to Pictures/Voidshot.
pub fn resolve_save_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if !settings.save_dir.trim().is_empty() {
        return PathBuf::from(&settings.save_dir);
    }
    app.path()
        .picture_dir()
        .map(|p| p.join("Voidshot"))
        .unwrap_or_else(|_| std::env::temp_dir().join("Voidshot"))
}
