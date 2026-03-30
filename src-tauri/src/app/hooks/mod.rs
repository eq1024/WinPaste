use tauri::{AppHandle, Emitter, Manager};
use std::sync::atomic::Ordering;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT,
    WM_KEYDOWN, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP,
    WM_MBUTTONDOWN
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN,
    RegisterHotKey, UnregisterHotKey, MOD_WIN, MOD_NOREPEAT
};

use crate::global_state::*;
use crate::app_state::SettingsState;
use crate::app::window_manager::{toggle_window, hide_window_cmd};
use crate::infrastructure::windows_ext::WindowExt;

// Store registered hotkey IDs for cleanup
static BLOCKED_HOTKEY_IDS: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());

#[tauri::command]
pub fn set_recording_mode(app_handle: AppHandle, enabled: bool) -> Result<(), String> {
    IS_RECORDING.store(enabled, Ordering::SeqCst);
    
    let mut ids = BLOCKED_HOTKEY_IDS.lock().unwrap();
    
    #[cfg(target_os = "windows")]
    if enabled {
        // Register ALL Win+ combinations to block system from handling them
        if let Some(window) = app_handle.get_webview_window("main") {
            if let Ok(hwnd_raw) = window.hwnd() {
                let hwnd = HWND(hwnd_raw.0);
                let mut id_counter = 0x1000i32;
                
                // Block Win + A-Z
                for vk in 0x41u32..=0x5Au32 {
                    unsafe {
                        if RegisterHotKey(Some(hwnd), id_counter, MOD_WIN | MOD_NOREPEAT, vk).is_ok() {
                            ids.push(id_counter);
                        }
                    }
                    id_counter += 1;
                }
                
                // Block Win + 0-9
                for vk in 0x30u32..=0x39u32 {
                    unsafe {
                        if RegisterHotKey(Some(hwnd), id_counter, MOD_WIN | MOD_NOREPEAT, vk).is_ok() {
                            ids.push(id_counter);
                        }
                    }
                    id_counter += 1;
                }
                
                // Block special keys
                let special_keys = [0x20u32, 0x0D, 0x09, 0x1B, 0x2C]; // Space, Enter, Tab, Esc, PrintScreen
                for vk in special_keys {
                    unsafe {
                        if RegisterHotKey(Some(hwnd), id_counter, MOD_WIN | MOD_NOREPEAT, vk).is_ok() {
                            ids.push(id_counter);
                        }
                    }
                    id_counter += 1;
                }
            }
        }
    } else {
        // Unregister all blocked hotkeys
        if let Some(window) = app_handle.get_webview_window("main") {
            if let Ok(hwnd_raw) = window.hwnd() {
                let hwnd = HWND(hwnd_raw.0);
                for id in ids.drain(..) {
                    unsafe {
                        let _ = UnregisterHotKey(Some(hwnd), id);
                    }
                }
            }
        }
    }
    
    Ok(())
}

pub fn start_input_worker(app_handle: AppHandle, mut rx: tokio::sync::mpsc::UnboundedReceiver<InputEvent>) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, GetAsyncKeyState
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN,
        WM_LBUTTONUP, WM_RBUTTONUP
    };

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                InputEvent::Keyboard { vk_code, is_down } => {
                    // 1. Handle Recording Mode
                    if IS_RECORDING.load(Ordering::SeqCst) {
                        if vk_code == 0x1B && is_down { // ESC to cancel
                            IS_RECORDING.store(false, Ordering::SeqCst);
                            let _ = app_handle.emit("recording-cancelled", ());
                            continue;
                        }

                        let is_win = vk_code == 0x5B || vk_code == 0x5C;
                        let is_other_modifier = (vk_code >= 0x10 && vk_code <= 0x12) || (vk_code >= 0xA0 && vk_code <= 0xA5);
                        
                        if !is_win && !is_other_modifier && is_down {
                            let ctrl_down = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000 != 0 };
                            let alt_down = unsafe { GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000 != 0 };
                            let win_down = unsafe { (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000 != 0) || 
                                          (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000 != 0) };

                            let key_name = match vk_code {
                                0x20 => "Space".to_string(),
                                0x0D => "Enter".to_string(),
                                0x09 => "Tab".to_string(),
                                0x08 => "Backspace".to_string(),
                                0x2E => "Delete".to_string(),
                                0x2D => "Insert".to_string(),
                                0x21 => "PageUp".to_string(),
                                0x22 => "PageDown".to_string(),
                                0x23 => "End".to_string(),
                                0x24 => "Home".to_string(),
                                0x25 => "Left".to_string(),
                                0x26 => "Up".to_string(),
                                0x27 => "Right".to_string(),
                                0x28 => "Down".to_string(),
                                0xBB => "Plus".to_string(),
                                0xBC => "Comma".to_string(),
                                0xBD => "Minus".to_string(),
                                0xBE => "Period".to_string(),
                                0xBF => "/".to_string(),
                                0xC0 => "`".to_string(),
                                0xBA => ";".to_string(),
                                0xDB => "[".to_string(),
                                0xDC => "\\".to_string(),
                                0xDD => "]".to_string(),
                                0xDE => "'".to_string(),
                                k if k >= 0x70 && k <= 0x87 => format!("F{}", k - 0x6F),
                                k if (k >= 0x30 && k <= 0x39) || (k >= 0x41 && k <= 0x5A) => 
                                    format!("{}", char::from_u32(k).unwrap()),
                                _ => format!("Key_{}", vk_code)
                            };

                            let final_hotkey = format!("{}{}{}{}{}", 
                                if ctrl_down { "Ctrl+" } else { "" },
                                if unsafe { GetAsyncKeyState(windows::Win32::UI::Input::KeyboardAndMouse::VK_SHIFT.0 as i32) as u16 & 0x8000 != 0 } { "Shift+" } else { "" },
                                if alt_down { "Alt+" } else { "" },
                                if win_down { "Win+" } else { "" },
                                key_name
                            );
                            
                            let _ = app_handle.emit("hotkey-recorded", final_hotkey);
                            IS_RECORDING.store(false, Ordering::SeqCst);
                        }
                        continue;
                    }

                    // 2. Global Paste Sound Trigger (Ctrl+V)
                    if vk_code == 0x56 && is_down {
                        let ctrl_down = unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 };
                        let alt_down = unsafe { (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0 };
                        let win_down = unsafe { (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000 != 0) || (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000 != 0) };

                        if ctrl_down && !alt_down && !win_down {
                            if let Some(settings) = app_handle.try_state::<SettingsState>() {
                                if settings.sound_enabled.load(Ordering::Relaxed) {
                                    let _ = app_handle.emit("play-sound", "paste");
                                }
                            }
                        }
                    }

                    // 3. Global Navigation Keys
                    if NAVIGATION_ENABLED.load(Ordering::SeqCst) && is_down {
                        if IS_HIDDEN.load(Ordering::Relaxed) { continue; }
                        
                        let allow_navigation = if let Some(settings) = app_handle.try_state::<SettingsState>() {
                            settings.arrow_key_selection.load(Ordering::Relaxed)
                        } else {
                            true
                        };

                        let is_enter = vk_code == 0x0D;
                        let is_escape = vk_code == 0x1B;
                        let is_up_down = vk_code == 0x26 || vk_code == 0x28;

                        // 只有方向键导航才受 allow_navigation 控制。ESC 和 Enter 永远可以。
                        if is_up_down && !allow_navigation { continue; }

                        if is_enter || is_escape || is_up_down {
                            if is_enter && !NAVIGATION_MODE_ACTIVE.load(Ordering::Relaxed) {
                                continue;
                            }

                            let ctrl_down = unsafe { (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 };
                            let alt_down = unsafe { (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0 };
                            let win_down = unsafe { (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000 != 0) || (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000 != 0) };

                            if !ctrl_down && !alt_down && !win_down {
                                let action = match vk_code {
                                    0x26 => "up",
                                    0x28 => "down",
                                    0x0D => "enter",
                                    0x1B => "escape",
                                    _ => "",
                                };
                                
                                if !action.is_empty() {
                                    if is_up_down {
                                        NAVIGATION_MODE_ACTIVE.store(true, Ordering::Relaxed);
                                    } else if is_escape {
                                        NAVIGATION_MODE_ACTIVE.store(false, Ordering::Relaxed);
                                    }

                                    if action == "escape" {
                                        let _ = app_handle.emit("navigation-action", "escape");
                                        toggle_window(&app_handle);
                                    } else {
                                        let _ = app_handle.emit("navigation-action", action);
                                    }
                                }
                            }
                        }
                    }
                }
                InputEvent::Mouse { msg, pt } => {
                    if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN {
                        IS_MOUSE_BUTTON_DOWN.store(true, Ordering::SeqCst);
                        
                        // Click Elsewhere to Hide Logic
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if !IGNORE_BLUR.load(Ordering::Relaxed) {
                                if let Ok(hwnd_raw) = window.hwnd() {
                                    let main_hwnd = HWND(hwnd_raw.0);
                                    if WindowExt::is_window_visible(main_hwnd) {
                                        if let Some(rect) = WindowExt::get_window_rect(main_hwnd) {
                                            let margin = 5;
                                            let is_outside = pt.x < rect.left - margin || pt.x > rect.right + margin ||
                                                            pt.y < rect.top - margin || pt.y > rect.bottom + margin;

                                            if is_outside {
                                                NAVIGATION_MODE_ACTIVE.store(false, Ordering::SeqCst);
                                                if WINDOW_PINNED.load(Ordering::Relaxed) {
                                                    // In pinned mode, don't hide, but we can release focus
                                                    // However, DON'T set focusable(false) as it prevents clicking back to focus
                                                } else {
                                                    let _ = hide_window_cmd(app_handle.clone());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else if msg == WM_LBUTTONUP || msg == WM_RBUTTONUP {
                        IS_MOUSE_BUTTON_DOWN.store(false, Ordering::SeqCst);
                    } else if msg == WM_MBUTTONDOWN {
                        if IS_RECORDING.load(Ordering::SeqCst) {
                            let _ = app_handle.emit("hotkey-recorded", "MouseMiddle");
                            IS_RECORDING.store(false, Ordering::SeqCst);
                        } else {
                            let current = HOTKEY_STRING.lock().unwrap().to_lowercase();
                            if current == "mousemiddle" || current == "mbutton" {
                                toggle_window(&app_handle);
                            }
                        }
                    }
                }
            }
        }
    });
}

// Low-level Keyboard Hook Procedure
#[cfg(target_os = "windows")]
pub unsafe extern "system" fn keyboard_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    let msg = w_param.0 as u32;
    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
    let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

    if n_code >= 0 && (is_down || is_up) {
        let kbd_struct = *(l_param.0 as *const KBDLLHOOKSTRUCT);
        
        // Fast path: send to asynchronous channel and return
        if let Some(sender) = INPUT_SENDER.get() {
            let _ = sender.send(InputEvent::Keyboard {
                vk_code: kbd_struct.vkCode,
                is_down,
            });
        }

        // Special case: block navigation keys if window is active to prevent system from handling them
        if NAVIGATION_ENABLED.load(Ordering::SeqCst) && !IS_HIDDEN.load(Ordering::Relaxed) {
            let vk = kbd_struct.vkCode;
            let is_navigation_key = vk == 0x26 || vk == 0x28 || vk == 0x0D || vk == 0x1B;
            if is_navigation_key && is_down {
                let ctrl_down = (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
                let alt_down = (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;
                let win_down = (GetAsyncKeyState(VK_LWIN.0 as i32) as u16 & 0x8000 != 0) || (GetAsyncKeyState(VK_RWIN.0 as i32) as u16 & 0x8000 != 0);
                
                if !ctrl_down && !alt_down && !win_down {
                    // 当窗口固定置顶时，如果窗口没有聚焦且没有进入显式导航模式，不拦截按键，允许操作其他软件
                    if WINDOW_PINNED.load(Ordering::Relaxed) && 
                       !IS_MAIN_WINDOW_FOCUSED.load(Ordering::Relaxed) &&
                       !NAVIGATION_MODE_ACTIVE.load(Ordering::Relaxed) {
                        return CallNextHookEx(None, n_code, w_param, l_param);
                    }

                    // Block these keys so the background worker can handle them without system interference
                    return LRESULT(1);
                }
            }
        }
        
        // Block all keys during recording mode except ESC (handled in worker)
        if IS_RECORDING.load(Ordering::SeqCst) {
            let vk = kbd_struct.vkCode;
            if vk != 0x1B { // Not ESC
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

// Low-level Mouse Hook Procedure
#[cfg(target_os = "windows")]
pub unsafe extern "system" fn mouse_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let msg = w_param.0 as u32;
        let mouse_struct = *(l_param.0 as *const MSLLHOOKSTRUCT);

        if let Some(sender) = INPUT_SENDER.get() {
            let _ = sender.send(InputEvent::Mouse {
                msg,
                pt: mouse_struct.pt,
            });
        }

        // Special case: block middle click during recording or if it's the toggle hotkey
        if msg == WM_MBUTTONDOWN {
            if IS_RECORDING.load(Ordering::SeqCst) {
                return LRESULT(1);
            }
            let current = HOTKEY_STRING.lock().unwrap().to_lowercase();
            if current == "mousemiddle" || current == "mbutton" {
                return LRESULT(1);
            }
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

pub fn parse_hotkey_for_hook(hotkey: &str) -> Option<HookHotkey> {
    let parts: Vec<&str> = hotkey.split('+').collect();
    let mut vk = 0u32;
    let mut ctrl = false;
    let mut shift = false;
    let mut alt = false;
    let mut win = false;

    for part in parts {
        let part_upper = part.trim().to_uppercase();
        match part_upper.as_str() {
            "CTRL" | "CONTROL" => ctrl = true,
            "SHIFT" => shift = true,
            "ALT" | "MENU" => alt = true,
            "SUPER" | "WIN" | "COMMAND" | "META" => win = true,
            "SPACE" => vk = 0x20,
            "ENTER" | "RETURN" => vk = 0x0D,
            "TAB" => vk = 0x09,
            "BACKSPACE" => vk = 0x08,
            "DELETE" => vk = 0x2E,
            "INSERT" => vk = 0x2D,
            "PAGEUP" => vk = 0x21,
            "PAGEDOWN" => vk = 0x22,
            "END" => vk = 0x23,
            "HOME" => vk = 0x24,
            "LEFT" => vk = 0x25,
            "UP" => vk = 0x26,
            "RIGHT" => vk = 0x27,
            "DOWN" => vk = 0x28,
            "PLUS" | "=" => vk = 0xBB,
            "COMMA" | "," => vk = 0xBC,
            "MINUS" | "-" => vk = 0xBD,
            "PERIOD" | "." => vk = 0xBE,
            "/" | "SLASH" => vk = 0xBF,
            "`" | "TILDE" | "GRAVE" => vk = 0xC0,
            ";" | "SEMICOLON" => vk = 0xBA,
            "[" | "LBRACKET" => vk = 0xDB,
            "\\" | "BACKSLASH" => vk = 0xDC,
            "]" | "RBRACKET" => vk = 0xDD,
            "'" | "QUOTE" => vk = 0xDE,
            key if key.starts_with('F') && key.len() > 1 => {
                if let Ok(num) = key[1..].parse::<u32>() {
                    if (1..=24).contains(&num) {
                        vk = 0x6F + num;
                    }
                }
            }
            key => {
                if key.len() == 1 {
                    vk = key.chars().next().unwrap() as u32;
                }
            }
        }
    }
    
    if vk != 0 {
        Some(HookHotkey { vk, ctrl, shift, alt, win })
    } else {
        None
    }
}

pub fn is_win_v_hotkey(hotkey: &str) -> bool {
    let parts: Vec<String> = hotkey
        .split('+')
        .map(|p| p.trim().to_uppercase())
        .filter(|p| !p.is_empty())
        .collect();

    if parts.is_empty() {
        return false;
    }

    let mut has_win = false;
    let mut has_v = false;

    for part in &parts {
        match part.as_str() {
            "WIN" | "SUPER" | "COMMAND" | "META" => has_win = true,
            "V" => has_v = true,
            _ => return false,
        }
    }

    has_win && has_v
}
