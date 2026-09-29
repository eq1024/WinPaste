use tauri::{AppHandle, Manager, Emitter};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use crate::app_state::SettingsState;
use crate::database::DbState;
use crate::infrastructure::repository::settings_repo::SettingsRepository;
use crate::global_state::*;
#[cfg(target_os = "windows")]
use crate::infrastructure::windows_ext::WindowExt;
#[cfg(target_os = "windows")]
use crate::app::system::subclass_window_for_taskbar;

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, POINT, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    GetWindowRect, IsIconic, IsWindowVisible, SetWindowPos, ShowWindow,
    HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    SW_RESTORE, SW_SHOWNA,
};

// —— 面板显示自检 / 自愈状态 ——
//
// 背景(2026-09-29 实证): 钩子与后端一切正常,但"面板窗口可见性"与用户看到的
// 完全脱节 —— 窗口在系统看来是可见的,屏幕上却什么都没有(透明窗口、被 DWM
// 遮蔽、最小化、被挪到屏外、或 WebView 渲染进程已死)。此时每次 Win+V 都只是
// 在一个"幽灵窗口"上空切换,必须重启应用才能恢复。
static PANEL_HEALTH_TOKEN: AtomicU64 = AtomicU64::new(0);
static PANEL_HEALTH_ACK: AtomicU64 = AtomicU64::new(0);
static PANEL_HEALTH_MISSES: AtomicU32 = AtomicU32::new(0);
static PANEL_HEALTH_LAST_RELOAD_MS: AtomicU64 = AtomicU64::new(0);
static PANEL_RECOVERY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 主窗口前端收到 panel-health-ping 后回执;长时间无回执说明渲染进程已死。
#[tauri::command]
pub fn panel_health_ack(token: u64) {
    PANEL_HEALTH_ACK.store(token, Ordering::Relaxed);
}

fn spawn_panel_health_check(app: AppHandle) {
    let token = PANEL_HEALTH_TOKEN.fetch_add(1, Ordering::Relaxed) + 1;
    if app.emit("panel-health-ping", token).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if PANEL_HEALTH_ACK.load(Ordering::Relaxed) == token {
            PANEL_HEALTH_MISSES.store(0, Ordering::Relaxed);
            return;
        }
        // 前端从未回执过(应用刚启动/界面还在加载)时不能当作"渲染进程已死"
        if PANEL_HEALTH_ACK.load(Ordering::Relaxed) == 0 {
            return;
        }
        let misses = PANEL_HEALTH_MISSES.fetch_add(1, Ordering::Relaxed) + 1;
        crate::error!(">>> [PANEL] health ping #{} missed ({} consecutive)", token, misses);
        if misses < 2 {
            return;
        }
        PANEL_HEALTH_MISSES.store(0, Ordering::Relaxed);
        let now = now_ms();
        if now.saturating_sub(PANEL_HEALTH_LAST_RELOAD_MS.load(Ordering::Relaxed)) < 60_000 {
            return;
        }
        PANEL_HEALTH_LAST_RELOAD_MS.store(now, Ordering::Relaxed);
        if let Some(window) = app.get_webview_window("main") {
            crate::info!(">>> [PANEL] renderer not responding; reloading webview to recover");
            let _ = window.reload();
        }
    });
}

#[cfg(windows)]
fn rect_on_any_monitor(window: &tauri::WebviewWindow, rect: &RECT) -> bool {
    let Ok(monitors) = window.available_monitors() else { return true; };
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        let left = pos.x;
        let top = pos.y;
        let right = left + size.width as i32;
        let bottom = top + size.height as i32;
        rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
    })
}

/// 收集"窗口层"的可见性异常。WebView 渲染进程是否存活由 panel-health-ping 探测。
#[cfg(windows)]
fn collect_panel_visibility_issues(window: &tauri::WebviewWindow) -> Vec<&'static str> {
    let mut issues: Vec<&'static str> = Vec::new();
    let Ok(hwnd_raw) = window.hwnd() else { return vec!["no-hwnd"]; };
    let hwnd = HWND(hwnd_raw.0 as _);
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() { issues.push("not-visible"); }
        if IsIconic(hwnd).as_bool() { issues.push("minimized"); }

        let mut cloaked: u32 = 0;
        let cloaked_ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok();
        if cloaked_ok && cloaked != 0 { issues.push("cloaked"); }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() && !rect_on_any_monitor(window, &rect) {
            issues.push("offscreen");
        }
    }
    issues
}

#[cfg(windows)]
fn centered_on_cursor_monitor(window: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    let mut point = POINT::default();
    unsafe { let _ = GetCursorPos(&mut point); }
    let monitors = window.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let pos = m.position();
            let size = m.size();
            point.x >= pos.x
                && point.x < pos.x + size.width as i32
                && point.y >= pos.y
                && point.y < pos.y + size.height as i32
        })
        .or_else(|| monitors.first())?;
    let size = window.outer_size().ok();
    let w = size.as_ref().map(|s| s.width as i32).filter(|v| *v > 0).unwrap_or(360);
    let h = size.as_ref().map(|s| s.height as i32).filter(|v| *v > 0).unwrap_or(480);
    let pos = monitor.position();
    let msize = monitor.size();
    Some((
        pos.x + (msize.width as i32 - w) / 2,
        pos.y + (msize.height as i32 - h) / 2,
    ))
}

/// 显示后的自检:有问题就安排一次恢复(在线程里做,避免阻塞输入 worker)。
#[cfg(windows)]
fn verify_panel_visibility(app: &AppHandle, window: &tauri::WebviewWindow) {
    let issues = collect_panel_visibility_issues(window);
    if issues.is_empty() {
        crate::info!(">>> [PANEL] show verified");
        spawn_panel_health_check(app.clone());
    } else {
        crate::error!(">>> [PANEL] show verification failed: {:?}", issues);
        schedule_panel_recovery(app.clone(), issues.join(","));
    }
}

#[cfg(windows)]
fn schedule_panel_recovery(app: AppHandle, reason: String) {
    if PANEL_RECOVERY_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        recover_panel(&app, &reason);
        PANEL_RECOVERY_IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

/// 恢复顺序:就地矫正(还原/移回屏内/重新置顶) → 仍不可见则重建主窗口。
/// 重建等价于"用户手动重启应用后"的状态,是最后兜底。
#[cfg(windows)]
fn recover_panel(app: &AppHandle, reason: &str) {
    crate::info!(">>> [PANEL] attempting recovery: {}", reason);
    let Some(window) = ensure_main_window(app) else {
        crate::error!(">>> [PANEL] recovery aborted: main window unavailable");
        return;
    };

    if let Ok(hwnd_raw) = window.hwnd() {
        let hwnd = HWND(hwnd_raw.0 as _);
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() && !rect_on_any_monitor(&window, &rect) {
                if let Some((x, y)) = centered_on_cursor_monitor(&window) {
                    crate::info!(">>> [PANEL] window off-screen; moving to ({}, {})", x, y);
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(150));
    let issues = collect_panel_visibility_issues(&window);
    if issues.is_empty() {
        crate::info!(">>> [PANEL] in-place recovery succeeded");
        spawn_panel_health_check(app.clone());
        return;
    }

    crate::error!(">>> [PANEL] in-place recovery failed ({:?}); rebuilding main window", issues);
    destroy_main_window(app);
    // destroy 是异步派发的:给 WebView2 一点时间释放,否则同 label 重建会失败
    let mut rebuilt = None;
    for _ in 0..6 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if let Some(window) = rebuild_main_window(app) {
            rebuilt = Some(window);
            break;
        }
    }
    let Some(rebuilt) = rebuilt else {
        crate::error!(">>> [PANEL] rebuild failed after retries");
        return;
    };
    if let Some((x, y)) = centered_on_cursor_monitor(&rebuilt) {
        let _ = rebuilt.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = rebuilt.set_focusable(false);
    NAVIGATION_ENABLED.store(true, Ordering::SeqCst);
    IS_HIDDEN.store(false, Ordering::Relaxed);
    IS_MAIN_WINDOW_FOCUSED.store(false, Ordering::Relaxed);
    let _ = rebuilt.show();
    if let Ok(hwnd_raw) = rebuilt.hwnd() {
        let hwnd = HWND(hwnd_raw.0 as _);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }
    let _ = app.emit("window-shown", ());
    crate::info!(">>> [PANEL] main window rebuilt for recovery");
    spawn_panel_health_check(app.clone());
}

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

/// Destroy transient panel-UI webview windows (currently only `compact-preview`).
/// The compact preview is an independent WebviewWindow that, once created, is
/// only ever hidden — never destroyed — so it survives `main` and keeps a
/// WebView2 renderer process alive (this is the residual "WebView2: WinPaste"
/// process seen after enabling lightweight mode following a search).
///
/// Sticky notes (`sticky-*`) are intentionally NOT touched: they are user
/// content pinned to the desktop and must survive lightweight mode.
fn destroy_transient_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label == "compact-preview" {
            crate::info!("[lightweight] destroying residual window: {}", label);
            let _ = window.destroy();
        }
    }
}

/// Destroy the `main` window, releasing its webview and resetting navigation/focus state.
/// Only called on lightweight-mode entry paths (tray toggle / command / startup),
/// so transient panel webviews (compact-preview) are torn down here as well.
pub fn destroy_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        WindowExt::release_win_keys();
        let _ = window.destroy();
    }
    destroy_transient_windows(app);
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
        crate::info!(">>> [TOGGLE] skipped: lightweight mode is on");
        return;
    }
    let window = match ensure_main_window(app) {
        Some(w) => w,
        None => {
            crate::error!(">>> [TOGGLE] ensure_main_window returned None");
            return;
        }
    };
    {
        #[cfg(windows)]
        let mut active_center: Option<(i32, i32)> = None;
        let is_visible = window.is_visible().unwrap_or(false);
        let is_hidden_by_edge = IS_HIDDEN.load(Ordering::Relaxed);
        crate::info!(
            ">>> [TOGGLE] is_visible={} hidden_by_edge={} pinned={}",
            is_visible,
            is_hidden_by_edge,
            WINDOW_PINNED.load(Ordering::Relaxed)
        );

        // 窗口"系统认为可见、用户实际看不到"(幽灵窗口)时,不能把它当成一次 hide
        // 白白吃掉 —— 否则用户会连按多次都毫无反应。第一下就转入恢复流程。
        #[cfg(windows)]
        let phantom_issues: Vec<&str> = if is_visible && !is_hidden_by_edge {
            collect_panel_visibility_issues(&window)
        } else {
            Vec::new()
        };
        #[cfg(not(windows))]
        let phantom_issues: Vec<&str> = Vec::new();

        if is_visible && !is_hidden_by_edge && phantom_issues.is_empty() {
            crate::info!(">>> [TOGGLE] hiding panel");
            hide_main_window_or_destroy(app, true);
            IS_HIDDEN.store(false, Ordering::Relaxed);
            return;
        }
        if !phantom_issues.is_empty() {
            crate::error!(">>> [TOGGLE] panel is 'visible' but actually not rendered: {:?}; recovering", phantom_issues);
            schedule_panel_recovery(app.clone(), phantom_issues.join(","));
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
                    crate::infrastructure::windows_api::window_tracker::push_recent_foreground(current_hwnd_val as usize);
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
                let hwnd = HWND(hwnd_raw.0 as _);
                unsafe {
                    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_NOACTIVATE.0 as isize);
                    // 最小化过的窗口即使再 ShowWindow 也不会回到可见状态,必须先还原
                    if IsIconic(hwnd).as_bool() {
                        crate::info!(">>> [PANEL] window was minimized; restoring before show");
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                }
                let _ = window.show();
                let _ = app.emit("window-shown", ());
                
                if pinned {
                    WindowExt::show_window_no_activate(hwnd);
                } else {
                    WindowExt::show_window_no_activate_normal(hwnd);
                }
                // 显示后自检:窗口层不可见 → 就地恢复/重建;窗口可见 → 探测渲染进程
                verify_panel_visibility(app, &window);
            } else {
                let _ = window.show();
                let _ = app.emit("window-shown", ());
                crate::error!(">>> [PANEL] window has no hwnd; falling back to health check");
                spawn_panel_health_check(app.clone());
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
                        crate::infrastructure::windows_api::window_tracker::push_recent_foreground(fg_hwnd.0 as usize);
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

    // The remap is proportional, not corner-anchored: a window sitting 10px off
    // the bottom-right keeps a scaled 10px-ish margin on the new monitor rather
    // than snapping flush into the corner.
    #[test]
    fn keeps_relative_position_near_bottom_right_corner() {
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

        // ratio = 1610/1620 ≈ 0.9938, 670/680 ≈ 0.9853 (near bottom-right, not
        // exactly at the edge) applied to target spans 2260x1040.
        assert_eq!(mapped, (4166, 1025));
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

        // ratio 0.5 applied to target spans 1300x500 → (-1600+650, 250).
        assert_eq!(mapped, (-950, 250));
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
