use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use crate::app_state::SettingsState;
use crate::database::DbState;
use crate::error::{AppResult, AppError};
use crate::infrastructure::repository::settings_repo::SettingsRepository;

#[derive(Debug, Serialize)]
pub struct PlatformInfo {
    pub platform: String,
    pub is_windows_10: bool,
    pub is_windows_11: bool,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    #[cfg(target_os = "windows")]
    {
        let build = windows_version::OsVersion::current().build;
        let is_windows_11 = build >= 22000;
        let is_windows_10 = build >= 10240 && build < 22000;
        PlatformInfo {
            platform: "windows".to_string(),
            is_windows_10,
            is_windows_11,
        }
    }

    #[cfg(target_os = "macos")]
    {
        PlatformInfo {
            platform: "macos".to_string(),
            is_windows_10: false,
            is_windows_11: false,
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        PlatformInfo {
            platform: "other".to_string(),
            is_windows_10: false,
            is_windows_11: false,
        }
    }
}

#[tauri::command]
pub fn send_system_notification(app: AppHandle, title: String, body: String) -> AppResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|err| AppError::Internal(format!("发送系统通知失败: {}", err)))?;

    Ok(())
}

#[tauri::command]
pub fn set_theme(
    window: WebviewWindow,
    state: State<'_, SettingsState>,
    db_state: State<'_, DbState>,
    _theme: String,
    _color_mode: Option<String>,
    show_app_border: Option<bool>,
    vibrancy_enabled: Option<bool>,
) -> AppResult<()> {
    let mut effective_show_app_border = show_app_border;
    if effective_show_app_border.is_none() {
        effective_show_app_border = db_state
            .settings_repo
            .get("app.show_app_border")
            .unwrap_or(Some("true".to_string()))
            .map(|v| v != "false");
    }
    let _show_border = effective_show_app_border.unwrap_or(true);

    let use_vibrancy = vibrancy_enabled.unwrap_or(true);

    if let Ok(mut guard) = state.theme.lock() {
        *guard = "fluent".to_string();
    }
    
    #[cfg(target_os = "windows")]
    use windows::core::BOOL;
    #[cfg(target_os = "windows")]
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWM_WINDOW_CORNER_PREFERENCE,
        DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    #[cfg(target_os = "windows")]
    use windows::Win32::Foundation::HWND;

    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| AppError::Internal(e.to_string()))?;
        let hwnd = HWND(hwnd.0 as _);
        
        if !use_vibrancy {
            let _ = window_vibrancy::clear_vibrancy(&window);
        }

        // Hardcode dark mode for fluent theme
        let is_dark = true;

        let dark_mode = BOOL::from(is_dark);
        unsafe {
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark_mode as *const _ as _, std::mem::size_of::<BOOL>() as u32);
            
            // We rely on CSS border for Fluent Design UI.
            // Setting native DWMWA_BORDER_COLOR on transparent windows often causes black/empty bars
            // that the WebView cannot fill.

            // Only use rounded corners on Windows 11
            let build = windows_version::OsVersion::current().build;
            if build >= 22000 {
                let corner_pref = DWM_WINDOW_CORNER_PREFERENCE(DWMWCP_ROUND.0);
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &corner_pref as *const _ as _,
                    std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                );
            }
        }

        if use_vibrancy {
            let build = windows_version::OsVersion::current().build;
            let is_win11 = build >= 22000;
            let is_win10_1803 = build >= 17134;

            if is_win11 {
                let _ = window_vibrancy::apply_mica(&window, Some(is_dark));
            } else if is_win10_1803 {
                let _ = window_vibrancy::apply_blur(&window, Some((20, 20, 20, 200)));
            }
        }
        
        // Disable native shadow to fix the black bars issue on transparent windows.
        let _ = window.set_shadow(false);
    }
    
    #[cfg(target_os = "macos")]
    {
        if use_vibrancy {
            let _ = window_vibrancy::apply_vibrancy(&window, window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground, None, None);
        }
    }
    
    let _ = window.emit("theme-changed", "fluent");
    Ok(())
}
