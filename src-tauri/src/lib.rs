mod capture;
mod hook;
mod imageio;
mod ocr;
mod settings;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use settings::Settings;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const OVERLAY_LABEL: &str = "overlay";

/// Live capture frame plus everything the pin windows are holding.
#[derive(Default)]
struct AppState {
    frame: Mutex<Option<capture::Frame>>,
    pins: Mutex<HashMap<String, Vec<u8>>>,
    pin_counter: AtomicU32,
    settings: Mutex<Settings>,
}

impl AppState {
    /// A poisoned lock here just means some other command panicked; the data
    /// itself is still usable and losing the overlay would be worse.
    fn frame(&self) -> std::sync::MutexGuard<'_, Option<capture::Frame>> {
        self.frame.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn pins(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<u8>>> {
        self.pins.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn settings(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.settings.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------
// capture flow
// ---------------------------------------------------------------------------

/// Virtual-desktop rect in the coordinate space Tauri uses to place windows.
///
/// We take geometry from Tauri (not from the capture backend) so the overlay
/// window lands exactly where we think it does, then conform the captured
/// bitmap to it. That keeps the editor canvas 1:1 with the screen even when the
/// two backends disagree about DPI.
fn tauri_virtual_rect(app: &AppHandle) -> Result<(i32, i32, u32, u32)> {
    let monitors = app.available_monitors().context("list monitors")?;
    if monitors.is_empty() {
        return Err(anyhow!("no monitors reported"));
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for m in &monitors {
        let p = m.position();
        let s = m.size();
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x + s.width as i32);
        max_y = max_y.max(p.y + s.height as i32);
    }
    Ok((
        min_x,
        min_y,
        (max_x - min_x).max(1) as u32,
        (max_y - min_y).max(1) as u32,
    ))
}

/// Build the overlay window (hidden). Created once at startup and reused for
/// every capture, so the hotkey never pays the WebView2 cold-start cost — that
/// was the bulk of the old press-to-overlay delay.
fn build_overlay_window(app: &AppHandle) -> Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Voidshot")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .focused(false)
        .build()
        .context("build overlay window")
}

/// Grab the screen and hand the frozen frame to the reused overlay editor.
fn begin_capture(app: &AppHandle) -> Result<()> {
    // The overlay is reused between captures. Make sure it is hidden before we
    // grab, or we would screenshot our own UI.
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    }

    let (vx, vy, vw, vh) = tauri_virtual_rect(app)?;
    let monitors: Vec<capture::MonitorRect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            capture::MonitorRect {
                x: p.x - vx,
                y: p.y - vy,
                w: s.width,
                h: s.height,
            }
        })
        .collect();

    let mut frame = capture::capture_desktop()?;

    // Conform the bitmap to the window rect so screen pixels and canvas pixels
    // map 1:1 with no offset.
    if frame.pixels.width() != vw || frame.pixels.height() != vh {
        // Triangle, not Lanczos3: on a multi-monitor desktop the frame is huge
        // and Lanczos is several times slower for a difference nobody sees on a
        // screenshot. Speed here is the gap between pressing the key and the
        // overlay appearing.
        frame.pixels = image::imageops::resize(
            &frame.pixels,
            vw,
            vh,
            image::imageops::FilterType::Triangle,
        );
        frame.geometry.pixel_width = vw;
        frame.geometry.pixel_height = vh;
    }
    frame.geometry.x = vx;
    frame.geometry.y = vy;
    frame.geometry.monitors = monitors;

    let state = app.state::<AppState>();
    *state.frame() = Some(frame);

    // Reuse the preheated window; build one only if it is somehow gone.
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => build_overlay_window(app)?,
    };
    window
        .set_position(PhysicalPosition::new(vx, vy))
        .context("position overlay")?;
    window
        .set_size(PhysicalSize::new(vw, vh))
        .context("size overlay")?;

    // Tell the already-loaded frontend to load the new frame and repaint. When
    // it has painted it calls `overlay_ready`, which shows the window — so it
    // appears fully rendered, never as an empty flash.
    let _ = window.emit("voidshot:capture", ());
    Ok(())
}

/// Capture the whole desktop with no overlay: straight to clipboard and the save
/// folder. Bound to Ctrl+PrintScreen for a one-key "grab everything" shot.
fn instant_capture(app: &AppHandle) -> Result<()> {
    let frame = capture::capture_desktop()?;
    let img = frame.pixels;

    let settings = app.state::<AppState>().settings().clone();
    let _ = imageio::copy_image_to_clipboard(&img);

    let ext = if settings.format.eq_ignore_ascii_case("jpg")
        || settings.format.eq_ignore_ascii_case("jpeg")
    {
        "jpg"
    } else {
        "png"
    };
    let dir = settings::resolve_save_dir(app, &settings);
    let path = dir.join(imageio::default_filename(ext));
    let bytes = imageio::encode_for_path(&img, &path, settings.jpeg_quality)?;
    imageio::write_atomic(&path, &bytes)?;

    let _ = app.emit(
        "voidshot:toast",
        format!("Full screen copied · saved to {}", path.display()),
    );
    Ok(())
}

fn spawn_instant(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = instant_capture(&app) {
            eprintln!("[voidshot] instant capture failed: {e:#}");
            let _ = app.emit("voidshot:error", format!("Capture failed: {e}"));
        }
    });
}

fn close_overlay(app: &AppHandle) {
    // Hide, not close: the window is reused across captures. Hiding keeps the
    // warm WebView2 alive for an instant next capture.
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.hide();
    }
    let state = app.state::<AppState>();
    // Drop the captured pixels as soon as the overlay goes away -- no reason to
    // keep a picture of the user's screen sitting in memory.
    *state.frame() = None;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn frame_info(state: tauri::State<'_, AppState>) -> Result<capture::DesktopGeometry, String> {
    state
        .frame()
        .as_ref()
        .map(|f| f.geometry.clone())
        .ok_or_else(|| "no active capture".to_string())
}

/// Raw RGBA bytes over the binary IPC channel. Deliberately not base64/JSON:
/// a 4K frame is ~33 MB and the overlay has to appear instantly.
#[tauri::command]
fn frame_pixels(state: tauri::State<'_, AppState>) -> tauri::ipc::Response {
    let bytes = state
        .frame()
        .as_ref()
        .map(|f| f.pixels.as_raw().clone())
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

fn decode_b64_png(data: &str) -> Result<RgbaImage> {
    // Accept both a bare base64 payload and a full `data:image/png;base64,...` URL.
    let payload = data.split(",").last().unwrap_or(data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .context("decode base64 image")?;
    imageio::decode_to_pixels(&bytes)
}

#[derive(Serialize)]
struct FinishResult {
    saved_path: Option<String>,
    copied: bool,
    message: String,
}

#[derive(Deserialize)]
struct FinishArgs {
    /// base64 PNG of the flattened editor canvas
    image: String,
    /// "copy" | "save" | "save_as" | "pin"
    action: String,
}

#[tauri::command]
async fn finish_capture(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    args: FinishArgs,
) -> Result<FinishResult, String> {
    let img = decode_b64_png(&args.image).map_err(|e| e.to_string())?;
    let settings = state.settings().clone();

    match args.action.as_str() {
        "copy" => {
            imageio::copy_image_to_clipboard(&img).map_err(|e| e.to_string())?;
            close_overlay(&app);
            Ok(FinishResult {
                saved_path: None,
                copied: true,
                message: "Copied to clipboard".into(),
            })
        }
        "pin" => {
            let png = imageio::encode_png(&img).map_err(|e| e.to_string())?;
            spawn_pin(&app, &state, png, img.width(), img.height()).map_err(|e| e.to_string())?;
            close_overlay(&app);
            Ok(FinishResult {
                saved_path: None,
                copied: false,
                message: "Pinned".into(),
            })
        }
        "save" | "save_as" => {
            // Close the overlay FIRST. It is always-on-top, so a native save
            // dialog opened while it is up appears behind it and looks like
            // nothing happened. The flattened image is already in `args.image`,
            // so dropping the overlay here loses nothing.
            close_overlay(&app);

            let ext = if settings.format.eq_ignore_ascii_case("jpg")
                || settings.format.eq_ignore_ascii_case("jpeg")
            {
                "jpg"
            } else {
                "png"
            };
            let dir = settings::resolve_save_dir(&app, &settings);
            let name = imageio::default_filename(ext);

            let path = if args.action == "save" && settings.quick_save {
                dir.join(name)
            } else {
                use tauri_plugin_dialog::DialogExt;
                let picked = app
                    .dialog()
                    .file()
                    .set_file_name(&name)
                    .set_directory(&dir)
                    .add_filter("PNG image", &["png"])
                    .add_filter("JPEG image", &["jpg", "jpeg"])
                    .blocking_save_file();
                match picked.and_then(|p| p.into_path().ok()) {
                    Some(p) => p,
                    None => {
                        return Ok(FinishResult {
                            saved_path: None,
                            copied: false,
                            message: "Save cancelled".into(),
                        })
                    }
                }
            };

            let bytes = imageio::encode_for_path(&img, &path, settings.jpeg_quality)
                .map_err(|e| e.to_string())?;
            imageio::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;

            let copied = if settings.copy_on_save {
                imageio::copy_image_to_clipboard(&img).is_ok()
            } else {
                false
            };

            Ok(FinishResult {
                saved_path: Some(path.to_string_lossy().to_string()),
                copied,
                message: format!("Saved to {}", path.display()),
            })
        }
        other => Err(format!("unknown action: {other}")),
    }
}

#[tauri::command]
fn cancel_capture(app: AppHandle) {
    close_overlay(&app);
}

/// The overlay is built hidden; the frontend calls this once it has painted the
/// first frame, so the window only appears fully rendered (frozen screen + dim).
#[tauri::command]
fn overlay_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn ocr_region(image: String) -> Result<String, String> {
    let img = decode_b64_png(&image).map_err(|e| e.to_string())?;
    let text = ocr::recognize(&img).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Err("no text recognized".into());
    }
    Ok(text)
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// pin windows
// ---------------------------------------------------------------------------

fn spawn_pin(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    png: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<()> {
    let n = state.pin_counter.fetch_add(1, Ordering::Relaxed);
    let label = format!("pin-{n}");

    state.pins().insert(label.clone(), png);

    // Size in logical units so the pin shows at the same apparent size as the
    // region the user selected, whatever the monitor scale is.
    let scale = app
        .get_webview_window(OVERLAY_LABEL)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let logical_w = (width as f64 / scale).max(60.0);
    let logical_h = (height as f64 / scale).max(40.0);

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("pin.html".into()))
        .title("Voidshot pin")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .inner_size(logical_w, logical_h)
        .visible(true)
        .build()
        .context("build pin window")?;

    let _ = window.set_min_size(Some(LogicalSize::new(60.0, 40.0)));
    Ok(())
}

#[tauri::command]
fn pin_bytes(window: WebviewWindow, state: tauri::State<'_, AppState>) -> tauri::ipc::Response {
    let bytes = state
        .pins()
        .get(window.label())
        .cloned()
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
fn close_pin(window: WebviewWindow, state: tauri::State<'_, AppState>) {
    state.pins().remove(window.label());
    let _ = window.close();
}

#[tauri::command]
fn copy_pin(window: WebviewWindow, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let bytes = state
        .pins()
        .get(window.label())
        .cloned()
        .ok_or_else(|| "pin not found".to_string())?;
    let img = imageio::decode_to_pixels(&bytes).map_err(|e| e.to_string())?;
    imageio::copy_image_to_clipboard(&img).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// settings commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.settings().clone()
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    new: Settings,
) -> Result<(), String> {
    let old_hotkey = state.settings().hotkey.clone();
    if new.hotkey != old_hotkey {
        rebind_hotkey(&app, &old_hotkey, &new.hotkey).map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        let old_auto = state.settings().autostart;
        if new.autostart != old_auto {
            if new.autostart {
                if let Ok(exe) = std::env::current_exe() {
                    hook::set_autostart(&exe.to_string_lossy());
                }
            } else {
                hook::clear_autostart();
            }
        }
    }

    *state.settings() = new.clone();
    settings::save(&app, &new).map_err(|e| e.to_string())
}

fn rebind_hotkey(app: &AppHandle, old: &str, new: &str) -> Result<()> {
    let gs = app.global_shortcut();
    if let Ok(sc) = old.parse::<Shortcut>() {
        let _ = gs.unregister(sc);
    }
    let sc = new
        .parse::<Shortcut>()
        .map_err(|e| anyhow!("invalid hotkey {new}: {e}"))?;
    gs.register(sc)
        .map_err(|e| anyhow!("register hotkey {new}: {e}"))?;
    Ok(())
}

/// Register the user's hotkey, falling back through alternatives if it is taken.
///
/// This matters more than it looks on Windows 11: "Use the Print screen key to
/// open Snipping Tool" is ON by default, which means the OS swallows
/// PrintScreen before we ever see it. Silently failing would leave the app
/// looking dead, so walk a chain and report which one stuck.
fn register_hotkey_with_fallbacks(app: &AppHandle, preferred: &str) -> Option<String> {
    let fallbacks = [
        preferred,
        settings::default_hotkey(),
        "CmdOrControl+Shift+S",
        "CmdOrControl+Shift+X",
        "CmdOrControl+Alt+S",
    ];

    let mut tried = Vec::new();
    for candidate in fallbacks {
        if candidate.is_empty() || tried.contains(&candidate) {
            continue;
        }
        tried.push(candidate);
        match rebind_hotkey(app, "", candidate) {
            Ok(()) => return Some(candidate.to_string()),
            Err(e) => eprintln!("[voidshot] hotkey {candidate} unavailable: {e}"),
        }
    }
    None
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Voidshot — Settings")
        .inner_size(560.0, 720.0)
        .min_inner_size(520.0, 560.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// tray + app setup
// ---------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> Result<()> {
    let capture_item = MenuItem::with_id(app, "capture", "New capture", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture_item, &settings_item, &sep, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("voidshot-tray")
        .tooltip("Voidshot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => {
                let app = app.clone();
                spawn_capture(app);
            }
            "settings" => {
                let _ = open_settings(app.clone());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                spawn_capture(tray.app_handle().clone());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Capture involves blocking screen grabs, so keep it off the UI thread.
fn spawn_capture(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = begin_capture(&app) {
            eprintln!("[voidshot] capture failed: {e:#}");
            let _ = app.emit("voidshot:error", format!("Capture failed: {e}"));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Fire on press only; the release event would double-trigger.
                    if event.state() == ShortcutState::Pressed {
                        spawn_capture(app.clone());
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        // Serve the frozen frame's raw RGBA over a custom protocol instead of the
        // invoke IPC. The IPC bridge copies a ~40 MB frame through a slow encoded
        // path (measured at ~5 s on a 3-monitor desktop); the protocol handler
        // streams the bytes natively in tens of milliseconds.
        .register_uri_scheme_protocol("frame", |ctx, _request| {
            let bytes = ctx
                .app_handle()
                .state::<AppState>()
                .frame()
                .as_ref()
                .map(|f| f.pixels.as_raw().clone())
                .unwrap_or_default();
            tauri::http::Response::builder()
                .header("Content-Type", "application/octet-stream")
                .header("Cache-Control", "no-store")
                // The app origin differs from this scheme's origin, so without
                // CORS the fetch is blocked and the frame never arrives.
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            frame_info,
            frame_pixels,
            finish_capture,
            cancel_capture,
            overlay_ready,
            ocr_region,
            copy_text,
            pin_bytes,
            close_pin,
            copy_pin,
            get_settings,
            set_settings,
            open_settings,
            reveal_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let mut loaded = settings::load(&handle);

            match register_hotkey_with_fallbacks(&handle, &loaded.hotkey) {
                Some(active) if active != loaded.hotkey => {
                    // Persist what actually works, so the settings window shows
                    // the truth rather than a hotkey that never fires.
                    eprintln!(
                        "[voidshot] '{}' was unavailable, using '{active}' instead",
                        loaded.hotkey
                    );
                    loaded.hotkey = active;
                    let _ = settings::save(&handle, &loaded);
                }
                Some(_) => {}
                None => eprintln!(
                    "[voidshot] no hotkey could be registered; use the tray icon to capture"
                ),
            }

            *app.state::<AppState>().settings() = loaded;

            // Windows: own PrintScreen for real. RegisterHotKey (above) loses the
            // key to Snipping Tool on Win11, so a low-level keyboard hook grabs it
            // ahead of the OS. Also free the key in the registry and start with
            // Windows, so "PrintScreen opens Voidshot" holds across reboots.
            #[cfg(windows)]
            {
                hook::free_printscreen_key();
                // Keep the autostart entry in sync with the setting (and with the
                // current exe path) on every launch.
                if app.state::<AppState>().settings().autostart {
                    if let Ok(exe) = std::env::current_exe() {
                        hook::set_autostart(&exe.to_string_lossy());
                    }
                } else {
                    hook::clear_autostart();
                }
                let h1 = handle.clone();
                let h2 = handle.clone();
                hook::install(
                    Box::new(move || spawn_capture(h1.clone())),
                    Box::new(move || spawn_instant(h2.clone())),
                );
            }

            build_tray(&handle)?;

            // Preheat the overlay window (hidden) so the very first capture is
            // as instant as every one after it.
            let _ = build_overlay_window(&handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the overlay must always release the captured frame.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == OVERLAY_LABEL {
                let state = window.app_handle().state::<AppState>();
                *state.frame() = None;
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Voidshot")
        .run(|_app, event| {
            // Tray app: closing every window must not quit the process.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
