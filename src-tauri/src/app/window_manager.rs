use tauri::{AppHandle, Manager, Emitter};
use std::sync::atomic::Ordering;
use crate::app_state::SettingsState;
use crate::database::DbState;
use crate::infrastructure::repository::settings_repo::SettingsRepository;
use crate::global_state::*;
#[cfg(target_os = "windows")]
use crate::infrastructure::windows_ext::WindowExt;
#[cfg(target_os = "windows")]
use crate::app::system::subclass_window_for_taskbar;

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, POINT};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MonitorBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn monitor_bounds(monitor: &tauri::Monitor) -> MonitorBounds {
    let position = monitor.position();
    let size = monitor.size();

    MonitorBounds {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    }
}

fn same_monitor(a: &tauri::Monitor, b: &tauri::Monitor) -> bool {
    monitor_bounds(a) == monitor_bounds(b)
}

fn remap_fixed_window_position(
    window_pos: (i32, i32),
    window_size: (i32, i32),
    source_monitor: MonitorBounds,
    target_monitor: MonitorBounds,
) -> (i32, i32) {
    let (window_width, window_height) = window_size;
    let source_span_x = (source_monitor.width - window_width).max(0);
    let source_span_y = (source_monitor.height - window_height).max(0);
    let target_span_x = (target_monitor.width - window_width).max(0);
    let target_span_y = (target_monitor.height - window_height).max(0);

    let source_offset_x = (window_pos.0 - source_monitor.x).clamp(0, source_span_x);
    let source_offset_y = (window_pos.1 - source_monitor.y).clamp(0, source_span_y);

    let ratio_x = if source_span_x == 0 {
        0.0
    } else {
        source_offset_x as f64 / source_span_x as f64
    };
    let ratio_y = if source_span_y == 0 {
        0.0
    } else {
        source_offset_y as f64 / source_span_y as f64
    };

    let mapped_x = target_monitor.x + (ratio_x * target_span_x as f64).round() as i32;
    let mapped_y = target_monitor.y + (ratio_y * target_span_y as f64).round() as i32;

    (
        mapped_x.clamp(target_monitor.x, target_monitor.x + target_span_x),
        mapped_y.clamp(target_monitor.y, target_monitor.y + target_span_y),
    )
}

/// Ensure the `main` window exists, rebuilding it if it was released in lightweight mode.
pub fn ensure_main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Some(window);
    }
    rebuild_main_window(app)
}

fn apply_noactivate_style(window: &tauri::WebviewWindow, pinned: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let ex_style = GetWindowLongPtrW(HWND(hwnd.0), GWL_EXSTYLE);
            let next = if pinned {
                ex_style | WS_EX_NOACTIVATE.0 as isize
            } else {
                ex_style & !(WS_EX_NOACTIVATE.0 as isize)
            };
            let _ = SetWindowLongPtrW(HWND(hwnd.0), GWL_EXSTYLE, next);
        }
    }
}

fn persisted_window_size(app: &AppHandle) -> (f64, f64) {
    if let Some(db) = app.try_state::<DbState>() {
        let w = db.settings_repo.get("app.window_width").ok().flatten().and_then(|v| v.parse::<u32>().ok());
        let h = db.settings_repo.get("app.window_height").ok().flatten().and_then(|v| v.parse::<u32>().ok());
        if let (Some(w), Some(h)) = (w, h) {
            if w >= 200 && h >= 200 {
                return (w as f64, h as f64);
            }
        }
    }
    (352.0, 380.0)
}

/// Rebuild the `main` window from its config, re-applying runtime state that is otherwise
/// only set once at startup (pinned/focusable, persisted size, WS_EX_NOACTIVATE, taskbar subclass).
pub fn rebuild_main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let config = app.config().app.windows.iter().find(|c| c.label == "main").cloned()?;
    let pinned = WINDOW_PINNED.load(Ordering::Relaxed);

    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config).ok()?;
    builder = builder
        .visible(false)
        .focused(false)
        .always_on_top(pinned)
        .focusable(!pinned);

    // persisted_window_size returns LOGICAL pixels (see persist_window_size), and
    // inner_size() expects logical pixels — this pair must stay consistent, otherwise
    // the rebuilt panel grows by the scale factor on every lightweight-mode cycle.
    let (w, h) = persisted_window_size(app);
    builder = builder.inner_size(w, h);

    let window = builder.build().ok()?;

    apply_noactivate_style(&window, pinned);

    #[cfg(windows)]
    subclass_window_for_taskbar(&window);

    Some(window)
}

/// Destroy the `main` window, releasing its webview and resetting navigation/focus state.
pub fn destroy_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        WindowExt::release_win_keys();
        let _ = window.destroy();
    }
    crate::IS_MAIN_WINDOW_FOCUSED.store(false, Ordering::Relaxed);
    NAVIGATION_ENABLED.store(false, Ordering::SeqCst);
    NAVIGATION_MODE_ACTIVE.store(false, Ordering::SeqCst);
    let _ = app.emit("window-hidden", ());
}

/// Hide the main window; in lightweight mode destroy it instead so the webview is released.
pub fn hide_main_window_or_destroy(app: &AppHandle, restore_focus: bool) {
    let lightweight = app.state::<SettingsState>().lightweight_mode.load(Ordering::Relaxed);
    if lightweight {
        destroy_main_window(app);
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        WindowExt::release_win_keys();
        let _ = window.set_focusable(false);
        crate::IS_MAIN_WINDOW_FOCUSED.store(false, Ordering::Relaxed);
        let _ = window.hide();
        NAVIGATION_ENABLED.store(false, Ordering::SeqCst);
        NAVIGATION_MODE_ACTIVE.store(false, Ordering::SeqCst);
        if restore_focus {
            let _ = restore_last_focus(app.clone());
        }
        let _ = app.emit("window-hidden", ());
    }
}

/// Core lightweight-mode toggle shared by the tray handler and the Tauri command.
pub fn apply_lightweight_mode(app: &AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<SettingsState>().lightweight_mode.store(enabled, Ordering::Relaxed);
    if let Some(db) = app.try_state::<DbState>() {
        let _ = db.settings_repo.set("app.lightweight_mode", &enabled.to_string());
    }
    if enabled {
        destroy_main_window(app);
    } else {
        ensure_main_window(app);
    }
    Ok(())
}

#[tauri::command]
pub fn set_lightweight_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_lightweight_mode(&app, enabled)
}

/// Whether lightweight (record-only) mode is active.
pub fn is_lightweight(app: &AppHandle) -> bool {
    app.try_state::<SettingsState>()
        .map(|s| s.lightweight_mode.load(Ordering::Relaxed))
        .unwrap_or(false)
}

pub fn toggle_window(app: &AppHandle) {
    // 轻量模式 = 仅记录：面板不弹出，需到托盘关闭轻量模式后才能使用。
    if is_lightweight(app) {
        return;
    }
    let window = match ensure_main_window(app) {
        Some(w) => w,
        None => return,
    };
    {
        #[cfg(windows)]
        let mut active_center: Option<(i32, i32)> = None;
        let is_visible = window.is_visible().unwrap_or(false);
        let is_hidden_by_edge = IS_HIDDEN.load(Ordering::Relaxed);

        if is_visible && !is_hidden_by_edge {
            hide_main_window_or_destroy(app, true);
            IS_HIDDEN.store(false, Ordering::Relaxed);
            return;
        }

        IS_HIDDEN.store(false, Ordering::Relaxed);
        NAVIGATION_ENABLED.store(true, Ordering::SeqCst);
        let was_docked = is_hidden_by_edge;
        let current_dock_val = CURRENT_DOCK.load(Ordering::Relaxed);
        CURRENT_DOCK.store(0, Ordering::Relaxed);

        #[cfg(windows)]
        {
            let hwnd = WindowExt::get_foreground_window();
            let current_hwnd_val = hwnd.0 as isize;
            if current_hwnd_val != 0 {
                let mut main_hwnd_val = 0isize;
                if let Ok(h) = window.hwnd() {
                    main_hwnd_val = h.0 as isize;
                }
                if current_hwnd_val != main_hwnd_val {
                    LAST_ACTIVE_HWND.store(current_hwnd_val as usize, Ordering::Relaxed);
                    if let Some(rect) = WindowExt::get_window_rect(hwnd) {
                        let cx = (rect.left + rect.right) / 2;
                        let cy = (rect.top + rect.bottom) / 2;
                        active_center = Some((cx, cy));
                    }
                }
            }
        }

        if let Ok(size) = window.outer_size() {
            let settings = app.state::<SettingsState>();
            let follow_mouse = settings.follow_mouse.load(Ordering::Relaxed);
            let follow_caret = settings.follow_caret.load(Ordering::Relaxed);

            if follow_mouse || follow_caret {
                let w = size.width as i32;
                let h = size.height as i32;
                
                #[cfg(windows)]
                {
                    let mut point = POINT::default();
                    unsafe { let _ = GetCursorPos(&mut point); }
                    
                    let mut caret_top = point.y;
                    let mut got_caret = false;

                    if follow_caret {
                        if let Some((cx, c_bottom, c_top)) = WindowExt::get_caret_pos() {
                            point.x = cx;
                            point.y = c_bottom; 
                            caret_top = c_top;
                            got_caret = true;
                        }
                    }
                    
                    // 初始位置，随后在 monitor 块中进行智能避让计算
                    let mut target_x = point.x;
                    let mut target_y = point.y;

                    let mut target_monitor: Option<tauri::Monitor> = None;
                    if let Ok(monitors) = window.available_monitors() {
                        for m in &monitors {
                            let m_pos = m.position();
                            let m_size = m.size();
                            let mx = m_pos.x;
                            let my = m_pos.y;
                            let mw = m_size.width as i32;
                            let mh = m_size.height as i32;
                            if point.x >= mx && point.x < mx + mw && point.y >= my && point.y < my + mh {
                                target_monitor = Some(m.clone());
                                break;
                            }
                        }
                        if target_monitor.is_none() && !monitors.is_empty() {
                            target_monitor = Some(monitors[0].clone());
                        }
                    }

                    if let Some(m) = target_monitor.as_ref() {
                        let m_pos = m.position();
                        let m_size = m.size();
                        let mx = m_pos.x;
                        let my = m_pos.y;
                        let mw = m_size.width as i32;
                        let mh = m_size.height as i32;

                        // --- 最佳实践定位算法 (Best Practice Implementation) ---
                        // 1. 定义参考点与安全区
                        let gap = 24; // 避让间距
                        let cx = point.x;
                        let c_top = if follow_caret && got_caret { caret_top } else { point.y };
                        let c_bottom = point.y;

                        let safe_left = cx - gap;
                        let safe_right = cx + gap;
                        let safe_top = c_top - gap;
                        let safe_bottom = c_bottom + gap;

                        // 2. 空间检测 (Current Monitor)
                        let space_right = (mx + mw) - safe_right;
                        let space_left = safe_left - mx;
                        let space_bottom = (my + mh) - safe_bottom;
                        let space_top = safe_top - my;

                        // 3. 方向选择 & 4. 坐标计算与修正
                        // 水平方向优先选择空间充裕的一侧
                        if space_right >= space_left {
                            // 选右侧
                            target_x = safe_right;
                            // 极端情况处理：如果右侧放不下，且左侧能放下，翻转；否则保持右侧
                            if target_x + w > mx + mw && space_left >= w {
                                target_x = safe_left - w;
                            }
                        } else {
                            // 选左侧
                            target_x = safe_left - w;
                            // 极端情况处理
                            if target_x < mx && space_right >= w {
                                target_x = safe_right;
                            }
                        }

                        // 垂直方向适配
                        if space_bottom >= space_top {
                            // 选下方
                            target_y = safe_bottom;
                            // 修正
                            if target_y + h > my + mh && space_top >= h {
                                target_y = safe_top - h;
                            }
                        } else {
                            // 选上方
                            target_y = safe_top - h;
                            // 修正
                            if target_y < my && space_bottom >= h {
                                target_y = safe_bottom;
                            }
                        }

                        // 5. 最终位置检查与智能 Clamp，确保无论如何调整都不会覆盖安全区
                        if w > mw {
                            target_x = mx; // 屏幕太小，强制左对齐
                            // 如果还是遮挡了安全区
                            if target_x + w > safe_left && target_x < safe_right {
                                target_x = safe_right; // 强制向右推，允许超出屏幕，不遮挡
                            }
                        } else {
                            target_x = target_x.clamp(mx, mx + mw - w);
                            // 再次检查安全区冲突 (仅在垂直范围也重叠时)
                            let y_overlaps = target_y < safe_bottom && target_y + h > safe_top;
                            if y_overlaps && target_x < safe_right && target_x + w > safe_left {
                                // 发生重叠，向空间大的方向推
                                if space_right >= space_left {
                                    target_x = safe_right;
                                } else {
                                    target_x = safe_left - w;
                                }
                            }
                        }

                        // Y 轴 Clamp 类似
                        if h > mh {
                            target_y = my;
                        } else {
                            target_y = target_y.clamp(my, my + mh - h);
                            let x_overlaps = target_x < safe_right && target_x + w > safe_left;
                            if x_overlaps && target_y < safe_bottom && target_y + h > safe_top {
                                if space_bottom >= space_top {
                                    target_y = safe_bottom;
                                } else {
                                    target_y = safe_top - h;
                                }
                            }
                        }
                    }

                    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: target_x, y: target_y }));
                }
            } else if was_docked {
                let mut target_monitor = window.current_monitor().ok().flatten();

                #[cfg(windows)]
                {
                    let mut point = POINT::default();
                    unsafe { let _ = GetCursorPos(&mut point); }
                    let (ref_x, ref_y) = active_center.unwrap_or((point.x, point.y));

                    if let Ok(monitors) = window.available_monitors() {
                        for m in &monitors {
                            let m_pos = m.position();
                            let m_size = m.size();
                            let mx = m_pos.x;
                            let my = m_pos.y;
                            let mw = m_size.width as i32;
                            let mh = m_size.height as i32;
                            if ref_x >= mx && ref_x < mx + mw && ref_y >= my && ref_y < my + mh {
                                target_monitor = Some(m.clone());
                                break;
                            }
                        }
                        if target_monitor.is_none() && !monitors.is_empty() {
                            target_monitor = Some(monitors[0].clone());
                        }
                    }
                }

                if let Some(monitor) = target_monitor {
                     let m_size = monitor.size();
                     let m_pos = monitor.position();
                     let w = size.width as i32;
                     let h = size.height as i32;
                     let mx = m_pos.x;
                     let my = m_pos.y;
                     let mw = m_size.width as i32;
                     
                     match current_dock_val {
                          1 => { let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: mx + (mw/2 - w/2), y: my + 10 })); },
                          2 => { let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: mx + 10, y: my + 10 })); },
                          3 => { let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: mx + mw - w - 10, y: my + 10 })); },
                          _ => {
                                  let center_x = mx + (mw / 2) - (w / 2);
                                  let center_y = my + (m_size.height as i32 / 2) - (h / 2);
                                  let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: center_x, y: center_y }));
                          }
                     }
                }
            } else {
                let w = size.width as i32;
                let h = size.height as i32;

                #[cfg(windows)]
                {
                    let mut point = POINT::default();
                    unsafe { let _ = GetCursorPos(&mut point); }
                    let (ref_x, ref_y) = active_center.unwrap_or((point.x, point.y));

                    let mut target_monitor: Option<tauri::Monitor> = None;
                    if let Ok(monitors) = window.available_monitors() {
                        for m in &monitors {
                            let m_pos = m.position();
                            let m_size = m.size();
                            let mx = m_pos.x;
                            let my = m_pos.y;
                            let mw = m_size.width as i32;
                            let mh = m_size.height as i32;
                            if ref_x >= mx && ref_x < mx + mw && ref_y >= my && ref_y < my + mh {
                                target_monitor = Some(m.clone());
                                break;
                            }
                        }
                        if target_monitor.is_none() && !monitors.is_empty() {
                            target_monitor = Some(monitors[0].clone());
                        }
                    }

                    if let Some(target) = target_monitor {
                        let current = window.current_monitor().ok().flatten();
                        let is_same = current
                            .as_ref()
                            .map(|c| same_monitor(c, &target))
                            .unwrap_or(false);

                        if !is_same {
                            let mapped_position = current
                                .as_ref()
                                .and_then(|current_monitor| {
                                    window.outer_position().ok().map(|current_pos| {
                                        remap_fixed_window_position(
                                            (current_pos.x, current_pos.y),
                                            (w, h),
                                            monitor_bounds(current_monitor),
                                            monitor_bounds(&target),
                                        )
                                    })
                                })
                                .unwrap_or_else(|| {
                                    let target_bounds = monitor_bounds(&target);
                                    (
                                        target_bounds.x + (target_bounds.width - w) / 2,
                                        target_bounds.y + (target_bounds.height - h) / 2,
                                    )
                                });

                            let _ = window.set_position(tauri::Position::Physical(
                                tauri::PhysicalPosition {
                                    x: mapped_position.0,
                                    y: mapped_position.1,
                                },
                            ));
                        }
                    }
                }
            }
        }

        #[cfg(target_os = "windows")]
        WindowExt::release_win_keys();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        LAST_SHOW_TIMESTAMP.store(now, Ordering::Relaxed);

        let pinned = WINDOW_PINNED.load(Ordering::Relaxed);
        // 面板呼出时无论是否置顶，一律不抢占焦点，实现类似原生 Win+V 的行为
        let _ = window.set_always_on_top(pinned);
        let _ = window.set_focusable(false);
        crate::IS_MAIN_WINDOW_FOCUSED.store(false, Ordering::Relaxed);
        let _ = app.emit("window-pinned-changed", pinned);

        #[cfg(target_os = "windows")]
        {
            if let Ok(hwnd_raw) = window.hwnd() {
                unsafe {
                    let ex_style = GetWindowLongPtrW(HWND(hwnd_raw.0), GWL_EXSTYLE);
                    let _ = SetWindowLongPtrW(HWND(hwnd_raw.0), GWL_EXSTYLE, ex_style | WS_EX_NOACTIVATE.0 as isize);
                }
                let _ = window.show();
                let _ = app.emit("window-shown", ());
                
                if pinned {
                    WindowExt::show_window_no_activate(HWND(hwnd_raw.0));
                } else {
                    WindowExt::show_window_no_activate_normal(HWND(hwnd_raw.0));
                }
            } else {
                let _ = window.show();
                let _ = app.emit("window-shown", ());
            }
        }

        #[cfg(not(windows))]
        {
            let _ = window.show();
            let _ = app.emit("window-shown", ());
        }
    }
}

#[tauri::command]
pub fn set_navigation_enabled(enabled: bool) -> Result<(), String> {
    NAVIGATION_ENABLED.store(enabled, Ordering::SeqCst);
    if !enabled {
        NAVIGATION_MODE_ACTIVE.store(false, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn set_navigation_mode(active: bool) -> Result<(), String> {
    NAVIGATION_MODE_ACTIVE.store(active, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn set_search_focused(focused: bool) -> Result<(), String> {
    IS_SEARCH_FOCUSED.store(focused, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn activate_window_focus(app_handle: AppHandle) -> Result<(), String> {
    // Temporarily ignore blur events during window activation to prevent focus-fight reset loops
    IGNORE_BLUR.store(true, Ordering::Relaxed);
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        IGNORE_BLUR.store(false, Ordering::Relaxed);
    });

    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.set_focusable(true);
        crate::IS_MAIN_WINDOW_FOCUSED.store(true, std::sync::atomic::Ordering::Relaxed);
        
        #[cfg(windows)]
        {
            if let Ok(hwnd_raw) = window.hwnd() {
                unsafe {
                    // 在抢占焦点前，精准捕获并记录当前系统前台窗口（作为粘贴的目标）
                    let fg_hwnd = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
                    crate::info!("[DEBUG] activate_window_focus triggered. Current Foreground: {:?}, Our Window: {:?}", fg_hwnd.0 as usize, hwnd_raw.0 as usize);
                    if !fg_hwnd.0.is_null() && fg_hwnd.0 != hwnd_raw.0 {
                        crate::LAST_ACTIVE_HWND.store(fg_hwnd.0 as usize, std::sync::atomic::Ordering::Relaxed);
                        crate::info!("[DEBUG] LAST_ACTIVE_HWND successfully updated to: {:?}", fg_hwnd.0 as usize);
                    } else {
                        crate::info!("[DEBUG] LAST_ACTIVE_HWND NOT updated. Is null? {} Or is same as our window? {}", fg_hwnd.0.is_null(), fg_hwnd.0 == hwnd_raw.0);
                    }

                    let ex_style = GetWindowLongPtrW(HWND(hwnd_raw.0), GWL_EXSTYLE);
                    let next = ex_style & !(WS_EX_NOACTIVATE.0 as isize);
                    let _ = SetWindowLongPtrW(HWND(hwnd_raw.0), GWL_EXSTYLE, next);
                }
                let _ = window.set_focus();
                WindowExt::force_focus_window(HWND(hwnd_raw.0));
                return Ok(());
            }
        }
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn hide_window_cmd(app_handle: AppHandle) -> Result<(), String> {
    hide_main_window_or_destroy(&app_handle, true);
    Ok(())
}

/// Hide the main window without restoring focus to the previous window.
/// Used when the user clicks outside the panel — the click already transferred
/// focus naturally, so calling restore_last_focus would cause a focus fight.
pub fn hide_window_no_restore(app_handle: &AppHandle) {
    hide_main_window_or_destroy(app_handle, false);
}

#[tauri::command]
pub fn toggle_window_cmd(app_handle: AppHandle) -> Result<(), String> {
    toggle_window(&app_handle);
    Ok(())
}

#[tauri::command]
pub fn focus_clipboard_window(app_handle: AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.set_focusable(true);
        let _ = window.show();
        let _ = app_handle.emit("window-shown", ());
        
        #[cfg(windows)]
        {
            if let Ok(hwnd_raw) = window.hwnd() {
                unsafe {
                    let ex_style = GetWindowLongPtrW(HWND(hwnd_raw.0), GWL_EXSTYLE);
                    let next = ex_style & !(WS_EX_NOACTIVATE.0 as isize);
                    let _ = SetWindowLongPtrW(HWND(hwnd_raw.0), GWL_EXSTYLE, next);
                }
                let _ = window.set_focus();
                WindowExt::force_focus_window(HWND(hwnd_raw.0));
                return Ok(());
            }
        }
        let _ = window.set_focus();
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub fn restore_last_focus(_app_handle: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let last_hwnd_val = LAST_ACTIVE_HWND.load(Ordering::Relaxed);
        if last_hwnd_val == 0 {
            return Ok(());
        }
        WindowExt::force_focus_window(HWND(last_hwnd_val as _));
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
    Ok(())
}

pub fn release_win_keys() {
    #[cfg(target_os = "windows")]
    WindowExt::release_win_keys();
}

pub fn is_main_window_focused() -> bool {
    IS_MAIN_WINDOW_FOCUSED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::{remap_fixed_window_position, MonitorBounds};

    #[test]
    fn keeps_bottom_right_anchor_when_switching_monitors() {
        let source = MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let target = MonitorBounds {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
        };

        let mapped = remap_fixed_window_position(
            (1610, 670),
            (300, 400),
            source,
            target,
        );

        assert_eq!(mapped, (4180, 1040));
    }

    #[test]
    fn preserves_center_ratio_for_mid_screen_window() {
        let source = MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let target = MonitorBounds {
            x: -1600,
            y: 0,
            width: 1600,
            height: 900,
        };

        let mapped = remap_fixed_window_position(
            (810, 340),
            (300, 400),
            source,
            target,
        );

        assert_eq!(mapped, (-800, 250));
    }

    #[test]
    fn clamps_positions_that_started_partly_outside_source_monitor() {
        let source = MonitorBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let target = MonitorBounds {
            x: 1920,
            y: 0,
            width: 1280,
            height: 1024,
        };

        let mapped = remap_fixed_window_position(
            (2000, 900),
            (500, 500),
            source,
            target,
        );

        assert_eq!(mapped, (2700, 524));
    }
}
