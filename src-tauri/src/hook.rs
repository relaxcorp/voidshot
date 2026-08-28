//! Reliable global capture key on Windows.
//!
//! Why this exists: on Windows 11 "Use the Print screen key to open Snipping
//! Tool" is on by default, and the OS claims the PrintScreen key before any
//! `RegisterHotKey`-based global shortcut can see it. The result is that a
//! normal global-shortcut registration for PrintScreen either fails (the key is
//! already owned) or never fires — Snipping Tool opens instead of us.
//!
//! A low-level keyboard hook (`WH_KEYBOARD_LL`) sits at the very front of the
//! input chain. It sees PrintScreen before the Snipping Tool binding does, fires
//! our capture, and returns a non-zero value to swallow the key so nothing
//! downstream (Snipping Tool included) ever receives it. This is the same
//! mechanism ShareX and Greenshot use.
//!
//! Everything here is Windows-only; the rest of the app is cross-platform, so
//! non-Windows builds get no-op stubs.

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use std::thread;

    use windows::core::w;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, REG_SZ,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SNAPSHOT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, MSG,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    type Trigger = Box<dyn Fn() + Send + Sync>;

    struct Triggers {
        /// PrintScreen — open the region-select overlay.
        region: Trigger,
        /// Ctrl+PrintScreen — grab the whole desktop instantly, no overlay.
        fullscreen: Trigger,
    }

    /// Capture actions, set once at install time and read from the hook callback
    /// (which runs on the dedicated hook thread).
    static TRIGGERS: OnceLock<Triggers> = OnceLock::new();

    unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let msg = wparam.0 as u32;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                if kb.vkCode == VK_SNAPSHOT.0 as u32 {
                    if let Some(t) = TRIGGERS.get() {
                        // High bit set = key currently down.
                        let ctrl = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
                        if ctrl {
                            (t.fullscreen)();
                        } else {
                            (t.region)();
                        }
                    }
                    // Swallow the key: Snipping Tool and everyone else never see
                    // PrintScreen, so we are the only thing it triggers.
                    return LRESULT(1);
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// Install the low-level keyboard hook on a dedicated thread with its own
    /// message pump (a LL hook only delivers events while the installing thread
    /// pumps messages).
    pub fn install(region: Trigger, fullscreen: Trigger) {
        if TRIGGERS.set(Triggers { region, fullscreen }).is_err() {
            return; // already installed
        }
        thread::spawn(|| unsafe {
            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[voidshot] keyboard hook install failed: {e}");
                    return;
                }
            };
            let _ = hook; // kept alive for the life of the thread (= the app)

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                // No dispatch needed: the hook fires on its own. We only need to
                // keep the message queue serviced so the hook stays live.
            }
        });
    }

    /// Turn off Windows 11's "PrintScreen opens Snipping Tool" so the key is
    /// free for us even outside the hook (belt and braces). Best-effort: a
    /// failure here just means we rely on the hook alone.
    pub fn free_printscreen_key() {
        let value: u32 = 0;
        unsafe {
            let _ = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                w!("Control Panel\\Keyboard"),
                w!("PrintScreenKeyForSnippingEnabled"),
                REG_DWORD.0,
                Some(&value as *const u32 as *const c_void),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }

    /// Register the running executable to start with Windows, so PrintScreen
    /// keeps opening Voidshot after a reboot instead of silently reverting to
    /// the default tool. Best-effort.
    pub fn set_autostart(exe_path: &str) {
        // Quote the path so a Program Files space does not split the command.
        let quoted = format!("\"{exe_path}\"");
        let wide: Vec<u16> = quoted.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let _ = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
                w!("Voidshot"),
                REG_SZ.0,
                Some(wide.as_ptr() as *const c_void),
                (wide.len() * std::mem::size_of::<u16>()) as u32,
            );
        }
    }

    /// Remove the autostart entry.
    pub fn clear_autostart() {
        unsafe {
            let _ = RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
                w!("Voidshot"),
            );
        }
    }
}

#[cfg(windows)]
pub use win::{clear_autostart, free_printscreen_key, install, set_autostart};

// ---------------------------------------------------------------- non-Windows

#[cfg(not(windows))]
pub fn install(
    _region: Box<dyn Fn() + Send + Sync>,
    _fullscreen: Box<dyn Fn() + Send + Sync>,
) {
}

#[cfg(not(windows))]
pub fn free_printscreen_key() {}

#[cfg(not(windows))]
pub fn set_autostart(_exe_path: &str) {}

#[cfg(not(windows))]
pub fn clear_autostart() {}
