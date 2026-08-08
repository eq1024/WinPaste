// Clipboard operations module
use crate::app_state::{SettingsState, SessionHistory};
use crate::database::DbState;
use crate::infrastructure::repository::settings_repo::SettingsRepository;
use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;
use crate::error::{AppResult, AppError};
use chrono::Utc;
use base64::{engine::general_purpose, Engine as _};
use regex::Regex;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::{Emitter, Manager, State};
use urlencoding::decode;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::AttachThreadInput;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible, IsIconic,
    SetForegroundWindow,
};

const RICH_IMAGE_FALLBACK_PREFIX: &str = "<!--WINPASTE_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX: &str = "-->";

// SVG temp files use a counter suffix so two pastes within the same second
// can never collide on one path (which would silently overwrite the first
// SVG). Stale files are cleaned up at startup via cleanup_svg_temp_files().
static SVG_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Remove leftover winpaste_SVG_* temp files from previous runs. Called at
/// startup — by then nothing references the old clipboard payloads anymore.
pub fn cleanup_svg_temp_files() {
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("winpaste_SVG_") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Write file paths to the clipboard as CF_HDROP and record the hash the
/// monitor will compute, so our own paste is skipped as an echo. The hash
/// MUST match clipboard/mod.rs — it hashes the joined paths after
/// `content.trim().replace("\r\n", "\n")`. All paste paths go through here
/// so the protocol can't drift between branches.
fn set_clipboard_files_with_self_skip_hash(win_paths: Vec<String>) -> AppResult<()> {
    let mut hasher = DefaultHasher::new();
    win_paths.join("\n").trim().hash(&mut hasher);
    let hdrop_hash = hasher.finish();
    crate::LAST_APP_SET_HASH.store(hdrop_hash, Ordering::SeqCst);
    crate::info!("[DEBUG] copy_to_clipboard: SETTING LAST_APP_SET_HASH to {} for {} paths", hdrop_hash, win_paths.len());
    unsafe {
        crate::infrastructure::windows_api::win_clipboard::set_clipboard_files(win_paths)
            .map_err(|e| {
                crate::info!("[ERROR] set_clipboard_files failed: {}", e);
                AppError::from(e)
            })?;
    }
    Ok(())
}

fn split_rich_html_and_image_fallback(html: &str) -> (String, Option<String>) {
    if let Some(start) = html.rfind(RICH_IMAGE_FALLBACK_PREFIX) {
        let marker_start = start + RICH_IMAGE_FALLBACK_PREFIX.len();
        if let Some(end_rel) = html[marker_start..].find(RICH_IMAGE_FALLBACK_SUFFIX) {
            let marker_end = marker_start + end_rel;
            let mut cleaned = String::with_capacity(html.len());
            cleaned.push_str(&html[..start]);
            cleaned.push_str(&html[marker_end + RICH_IMAGE_FALLBACK_SUFFIX.len()..]);

            let payload = html[marker_start..marker_end].trim();
            if payload.is_empty() {
                return (cleaned.trim().to_string(), None);
            }
            // Accept both data URL fallback and persisted local file path fallback.
            return (cleaned.trim().to_string(), Some(payload.to_string()));
        }
    }
    (html.to_string(), None)
}

fn resolve_rich_image_fallback_bytes(payload: &str) -> Option<Vec<u8>> {
    let value = payload.trim();

    if value.starts_with("data:image/") {
        let b64_data = value.split(',').nth(1)?;
        if b64_data.is_empty() {
            return None;
        }
        return general_purpose::STANDARD.decode(b64_data).ok();
    }

    let path_raw = if value.starts_with("file://") {
        value.trim_start_matches("file://")
    } else {
        value
    };

    let path_without_drive_prefix = if path_raw.starts_with('/') && path_raw.chars().nth(2) == Some(':') {
        &path_raw[1..]
    } else {
        path_raw
    };

    let decoded_path = decode(path_without_drive_prefix)
        .map(|p| p.into_owned())
        .unwrap_or_else(|_| path_without_drive_prefix.to_string());

    if decoded_path.is_empty() {
        return None;
    }

    std::fs::read(decoded_path).ok()
}

#[tauri::command]
pub async fn copy_to_clipboard(
    app_handle: tauri::AppHandle,
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    mut content: String,
    content_type: String,
    paste: bool,
    id: i64,
    delete_after_use: bool,
    paste_with_format: Option<bool>,
    move_to_top: Option<bool>,
) -> AppResult<()> {
    crate::info!("[DEBUG] copy_to_clipboard called: id={}, paste={}, content_type={}, content_len={}", id, paste, content_type, content.len());

    let mut html_content: Option<String> = None;

    // 0. Resolve full content if ID is provided and content is placeholder/truncated
    if id != 0 {
        if id > 0 {
            // Fetch from Database
            if let Ok(Some((full_content, _ctype, html))) = state.repo.get_entry_content_with_html(id) {
                content = full_content;
                html_content = html;
            }
        } else {
            // Fetch from Session
            let session_items = session.inner().0.lock().unwrap();
            if let Some(item) = session_items.iter().find(|i| i.id == id) {
                content = item.content.clone();
                html_content = item.html_content.clone();
            }
        }
    }

    if content_type == "rich_text" {
        let normalized = crate::services::clipboard::derive_rich_text_content(&content, html_content.as_deref());
        if !normalized.trim().is_empty() {
            content = normalized;
        }
    }

    // 1. Handle Window Visibility and Focus
    if paste {
        handle_window_focus_for_paste(&app_handle).await?;
    }

    // 2. Copy to system clipboard
    prepare_clipboard_payload(
        &content,
        &content_type,
        html_content.as_deref(),
        paste_with_format.unwrap_or(content_type == "rich_text" && html_content.as_deref().is_some()),
    )
    .await?;

    // 3. Perform paste action if requested
    if paste {
        perform_paste_action(
            &app_handle,
            &state,
            id,
            delete_after_use,
            Some(&content),
            &content_type,
            move_to_top
        ).await?;
    }

    Ok(())
}

async fn handle_window_focus_for_paste(app_handle: &tauri::AppHandle) -> AppResult<()> {
    let was_focused = crate::IS_MAIN_WINDOW_FOCUSED.load(Ordering::Relaxed);

    // 1. 先把自己变成不会抢夺焦点的幽灵状态（或直接隐藏）
    if crate::WINDOW_PINNED.load(Ordering::Relaxed) {
        // 在置顶模式下，恢复为悬浮面板状态
        if let Some(window) = app_handle.get_webview_window("main") {
            #[cfg(target_os = "windows")]
            if let Ok(hwnd_raw) = window.hwnd() {
                unsafe {
                    let ex_style = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(windows::Win32::Foundation::HWND(hwnd_raw.0), windows::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE);
                    let _ = windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                        windows::Win32::Foundation::HWND(hwnd_raw.0),
                        windows::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
                        ex_style | windows::Win32::UI::WindowsAndMessaging::WS_EX_NOACTIVATE.0 as isize
                    );
                }
            }
            // 不要调用 window.set_focusable(false)，因为它在某些 Tauri 平台上会导致窗口闪烁并强制触发焦点事件
        }
        crate::IS_MAIN_WINDOW_FOCUSED.store(false, Ordering::Relaxed); // 自己退居二线
    } else {
        // 在非置顶模式下，直接隐藏窗口
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.hide();
            crate::IS_HIDDEN.store(false, std::sync::atomic::Ordering::Relaxed);
            crate::app::window_manager::release_win_keys();
        }
        crate::IS_MAIN_WINDOW_FOCUSED.store(false, Ordering::Relaxed);
    }
    
    // 给系统留出极短的时间响应窗口样式的变化
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;

    // 2. 然后，如果之前我们拥有焦点，再郑重其事地把焦点交还给那个精准快照保存的目标窗口
    if was_focused {
        let _ = restore_focus_before_paste(app_handle).await;
    }

    Ok(())
}

async fn restore_focus_before_paste(_app_handle: &tauri::AppHandle) -> AppResult<()> {
    let last_hwnd_val = crate::LAST_ACTIVE_HWND.load(Ordering::Relaxed);
    crate::info!("[DEBUG] restore_focus_before_paste called. Target HWND = {:?}", last_hwnd_val);
    
    if last_hwnd_val == 0 {
        return Err(AppError::Internal("No last active window captured".to_string()));
    }

    #[cfg(target_os = "windows")]
    {
        use crate::infrastructure::windows_ext::WindowExt;
        
        let target_hwnd = HWND(last_hwnd_val as _);
        unsafe {
            if !IsWindowVisible(target_hwnd).as_bool() {
                 crate::info!("[WARN] Target window is no longer visible.");
                 return Err(AppError::Internal("Target window is no longer visible".to_string()));
            }

            let fg_hwnd = GetForegroundWindow();
            crate::info!("[DEBUG] Before SetForegroundWindow, Current Foreground is {:?}", fg_hwnd.0 as usize);
            
            if fg_hwnd.0 != target_hwnd.0 {
                use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP};
                
                // 1. 发送一次虚拟的 Alt 键按下来绕过 ForegroundLockTimeout 限制
                keybd_event(windows::Win32::UI::Input::KeyboardAndMouse::VK_MENU.0 as u8, 0, windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0), 0);
                keybd_event(windows::Win32::UI::Input::KeyboardAndMouse::VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);

                // 2. 将当前 Tokio 后台工作线程与前台线程进行输入附加，赋予当前线程前台特权
                let current_thread_id = windows::Win32::System::Threading::GetCurrentThreadId();
                let fg_thread_id = GetWindowThreadProcessId(fg_hwnd, None);
                let target_thread_id = GetWindowThreadProcessId(target_hwnd, None);

                let attached_to_fg = if current_thread_id != fg_thread_id && fg_thread_id != 0 {
                    windows::Win32::System::Threading::AttachThreadInput(current_thread_id, fg_thread_id, true).as_bool()
                } else { false };

                let attached_to_target = if fg_thread_id != target_thread_id && target_thread_id != 0 {
                    windows::Win32::System::Threading::AttachThreadInput(fg_thread_id, target_thread_id, true).as_bool()
                } else { false };

                let _ = SetForegroundWindow(target_hwnd);
                
                if IsIconic(target_hwnd).as_bool() {
                    let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(target_hwnd, windows::Win32::UI::WindowsAndMessaging::SW_RESTORE);
                }
                let _ = windows::Win32::UI::WindowsAndMessaging::BringWindowToTop(target_hwnd);
                
                if attached_to_target {
                    let _ = windows::Win32::System::Threading::AttachThreadInput(fg_thread_id, target_thread_id, false);
                }
                if attached_to_fg {
                    let _ = windows::Win32::System::Threading::AttachThreadInput(current_thread_id, fg_thread_id, false);
                }
                
                crate::info!("[DEBUG] Tried to set foreground. Attached to FG: {}, Attached to Target: {}", attached_to_fg, attached_to_target);
            } else {
                crate::info!("[DEBUG] Target window is already the foreground window.");
            }
        }

        // Wait for focus with polling instead of blind sleep
        crate::info!("[DEBUG] Waiting for focus to settle on target window {:?}...", target_hwnd.0 as usize);
        if !WindowExt::wait_for_focus_raw(target_hwnd.0 as usize, 300).await {
            unsafe {
                let current_fg = GetForegroundWindow();
                crate::info!("[WARN] Failed to confirm focus on target window after 300ms. Current Foreground is actually {:?}", current_fg.0 as usize);
            }
        } else {
            crate::info!("[DEBUG] Successfully confirmed target window is foreground!");
        }
    }

    Ok(())
}

fn calculate_content_hash(content: &str) -> (u64, u64) {
    let normalized = content.trim().replace("\r\n", "\n");
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    let content_hash = hasher.finish();

    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    (content_hash, current_time)
}

pub async fn prepare_clipboard_payload(
    content: &str,
    content_type: &str,
    html_content: Option<&str>,
    paste_with_format: bool,
) -> AppResult<()> {
    let (content_hash, current_time) = calculate_content_hash(content);
    crate::LAST_APP_SET_HASH.store(content_hash, Ordering::SeqCst);
    crate::LAST_APP_SET_HASH_ALT.store(0, Ordering::SeqCst);
    crate::LAST_APP_SET_TIMESTAMP.store(current_time, Ordering::SeqCst);

    copy_content_to_system_clipboard(
        content,
        content_type,
        html_content,
        paste_with_format,
        content_hash,
        current_time,
    )
    .await
}

async fn copy_content_to_system_clipboard(
    content: &str,
    content_type: &str,
    html_content: Option<&str>,
    paste_with_format: bool,
    content_hash: u64,
    current_time: u64,
) -> AppResult<()> {
    match content_type {
        "image" | "video" | "file" => {
            if content_hash == 0 {
                crate::LAST_APP_SET_HASH.store(1, Ordering::SeqCst);
            }

            if !content.starts_with("data:") && (content.starts_with('/') || content.contains(":\\"))
            {
                // Check if file still exists
                let first_file = content.lines().next().unwrap_or(content);
                let clean_path = if first_file.starts_with("file://") {
                    first_file.strip_prefix("file://").unwrap_or(first_file)
                } else {
                    first_file
                };
                if !std::path::Path::new(clean_path).exists() {
                    return Err(AppError::IO("File not found".to_string()));
                }

                let mut fallback_to_file = true;
                if content_type == "image" {
                    // For image type with local path, check size
                    if let Ok(metadata) = std::fs::metadata(clean_path) {
                        // If file size <= 1MB, read pixels for better compatibility with chat apps
                        if metadata.len() <= 1024 * 1024 {
                            if let Ok(bytes) = std::fs::read(clean_path) {
                                if let Ok((primary_hash, _secondary_hash)) = copy_image_bytes_to_clipboard(bytes, current_time) {
                                    // Keep LAST_APP_SET_HASH as content_hash (path hash)
                                    // Store pixel/byte hash in HASH_ALT
                                    crate::LAST_APP_SET_HASH_ALT.store(primary_hash, Ordering::SeqCst);
                                    fallback_to_file = false;
                                }
                            }
                        }
                    }
                }
                
                if fallback_to_file {
                    // Multi-file selections must be written to CF_HDROP as a
                    // whole — pasting only the first path would drop the rest.
                    let win_paths: Vec<String> = content
                        .lines()
                        .map(|line| {
                            let clean = if line.starts_with("file://") {
                                line.strip_prefix("file://").unwrap_or(line)
                            } else {
                                line
                            };
                            clean.replace("/", "\\")
                        })
                        .collect();
                    crate::info!("[DEBUG] copy_to_clipboard: fallback_to_file for paths={}", win_paths.len());
                    set_clipboard_files_with_self_skip_hash(win_paths)?;
                }
            } else if content_type == "image" {
                // SVG is a vector text format that the rasterizer can't
                // convert to PNG — paste it back as a .svg file instead.
                if content.starts_with("data:image/svg") {
                    let b64_data = content.split(',').nth(1).unwrap_or(content);
                    let bytes = general_purpose::STANDARD
                        .decode(b64_data)
                        .map_err(|e| AppError::Internal(format!("Base64 解码失败: {}", e)))?;
                    let temp_path = std::env::temp_dir().join(format!(
                        "winpaste_SVG_{}_{}.svg",
                        current_time,
                        SVG_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
                    ));
                    std::fs::write(&temp_path, &bytes)
                        .map_err(|e| AppError::IO(format!("写入临时 SVG 失败: {}", e)))?;
                    let win_path = temp_path.to_string_lossy().replace("/", "\\");
                    set_clipboard_files_with_self_skip_hash(vec![win_path])?;
                } else {
                    let b64_data = if content.starts_with("data:image") {
                        content.split(',').nth(1).unwrap_or(content)
                    } else {
                        content
                    };

                    let bytes = general_purpose::STANDARD
                        .decode(b64_data)
                        .map_err(|e| AppError::Internal(format!("Base64 解码失败: {}", e)))?;

                    let (primary_hash, _secondary_hash) = copy_image_bytes_to_clipboard(bytes, current_time)?;
                    // Keep LAST_APP_SET_HASH as content_hash (dataurl hash)
                    // Store pixel/byte hash in HASH_ALT
                    crate::LAST_APP_SET_HASH_ALT.store(primary_hash, Ordering::SeqCst);
                }
            } else {
                let mut clipboard = arboard::Clipboard::new().map_err(AppError::from)?;
                clipboard.set_text(content.to_string()).map_err(AppError::from)?;
            }
        }
        ct if ct == "rich_text" || (paste_with_format && html_content.is_some()) => {
            if let Some(html) = html_content {
                if paste_with_format {
                    let (clean_html, fallback_image_data_url) = split_rich_html_and_image_fallback(html);
                    let html_for_paste = if clean_html.trim().is_empty() {
                        html
                    } else {
                        clean_html.as_str()
                    };
                    let cf_html = generate_cf_html(html_for_paste);

                    if let Some(payload) = fallback_image_data_url {
                        if let Some(bytes) = resolve_rich_image_fallback_bytes(&payload) {
                            let (primary_hash, _secondary_hash) = copy_image_bytes_to_clipboard(bytes, current_time)?;
                            crate::LAST_APP_SET_HASH_ALT.store(primary_hash, Ordering::SeqCst);
                            unsafe {
                                crate::infrastructure::windows_api::win_clipboard::append_clipboard_text_and_html(content, &cf_html)
                                    .map_err(AppError::from)?;
                            }
                        } else {
                            unsafe {
                                crate::infrastructure::windows_api::win_clipboard::set_clipboard_text_and_html(content, &cf_html)
                                    .map_err(AppError::from)?;
                            }
                        }
                    } else {
                        unsafe {
                            crate::infrastructure::windows_api::win_clipboard::set_clipboard_text_and_html(content, &cf_html)
                                .map_err(AppError::from)?;
                        }
                    }
                } else {
                    copy_text_with_retry(content).await?;
                }
            } else {
                copy_text_with_retry(content).await?;
            }
        }
        _ => {
            copy_text_with_retry(content).await?;
        }
    }

    Ok(())
}

fn generate_cf_html(html: &str) -> String {
    static BODY_OPEN_RE: OnceLock<Regex> = OnceLock::new();
    static BODY_CLOSE_RE: OnceLock<Regex> = OnceLock::new();
    static HTML_TAG_RE: OnceLock<Regex> = OnceLock::new();

    let body_open_re = BODY_OPEN_RE.get_or_init(|| Regex::new(r"(?is)<body\b[^>]*>").unwrap());
    let body_close_re = BODY_CLOSE_RE.get_or_init(|| Regex::new(r"(?is)</body\s*>").unwrap());
    let html_tag_re = HTML_TAG_RE.get_or_init(|| Regex::new(r"(?is)<html\b").unwrap());

    let wrap_with_body = |fragment: &str| {
        format!(
            "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n</head>\n<body>\n<!--StartFragment-->{}<!--EndFragment-->\n</body>\n</html>",
            fragment
        )
    };

    let mut html_content = crate::services::clipboard::repair_html_fragment(html);
    let has_html_tag = html_tag_re.is_match(&html_content);
    let has_start = html_content.contains("<!--StartFragment-->");
    let has_end = html_content.contains("<!--EndFragment-->");

    if !has_html_tag {
        html_content = wrap_with_body(&html_content);
    } else if !(has_start && has_end) {
        if let Some(open_match) = body_open_re.find(&html_content) {
            let open_end = open_match.end();

            if !has_end {
                if let Some(close_match) = body_close_re.find(&html_content) {
                    if close_match.start() >= open_end {
                        html_content.insert_str(close_match.start(), "<!--EndFragment-->");
                    } else {
                        html_content.push_str("<!--EndFragment-->");
                    }
                } else {
                    html_content.push_str("<!--EndFragment-->");
                }
            }

            if !has_start {
                html_content.insert_str(open_end, "<!--StartFragment-->");
            }
        } else {
            html_content = wrap_with_body(&html_content);
        }
    }

    if !(html_content.contains("<!--StartFragment-->") && html_content.contains("<!--EndFragment-->")) {
        html_content = wrap_with_body(&html_content);
    }

    let header_placeholder = format!(
        "Version:0.9\r\nStartHTML:{:0>10}\r\nEndHTML:{:0>10}\r\nStartFragment:{:0>10}\r\nEndFragment:{:0>10}\r\n",
        0,
        0,
        0,
        0
    );
    let start_html = header_placeholder.len();
    let start_fragment = start_html + html_content.find("<!--StartFragment-->").unwrap() + "<!--StartFragment-->".len();
    let end_fragment = start_html + html_content.find("<!--EndFragment-->").unwrap();
    let end_html = start_html + html_content.len();

    let header = format!(
        "Version:0.9\r\nStartHTML:{:0>10}\r\nEndHTML:{:0>10}\r\nStartFragment:{:0>10}\r\nEndFragment:{:0>10}\r\n",
        start_html,
        end_html,
        start_fragment,
        end_fragment
    );
    format!("{}{}", header, html_content)
}
fn copy_image_bytes_to_clipboard(
    bytes: Vec<u8>,
    current_time: u64,
) -> AppResult<(u64, u64)> {
    // Check if it's a GIF by magic number
    let is_gif = bytes.len() > 3 && &bytes[0..3] == b"GIF";

    // Decode ONCE — the same decoded image feeds both the PNG payload and the
    // pixel hash. Previously the bytes were decoded twice, which made large
    // images slow to paste.
    let img = image::load_from_memory(&bytes)
        .map_err(|e| AppError::Internal(format!("加载图像失败: {}", e)))?;

    // Prepare PNG data for better compatibility. Encoded first so the output
    // keeps the source color mode — byte-for-byte identical to before.
    // Fast PNG encoding — default compression made large screenshots delay
    // capture (same fix as clipboard/mod.rs).
    let mut png_buf: Vec<u8> = Vec::new();
    {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        let mut cursor = std::io::Cursor::new(&mut png_buf);
        let encoder = PngEncoder::new_with_quality(
            &mut cursor,
            CompressionType::Fast,
            FilterType::NoFilter,
        );
        img.write_with_encoder(encoder)
            .map_err(|e| AppError::Internal(format!("编码 PNG 失败: {}", e)))?;
    }

    let (width, height, raw_bytes) = {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        (w, h, rgba.into_raw())
    };

    crate::LAST_APP_SET_TIMESTAMP.store(current_time, Ordering::SeqCst);

    let (primary_hash, secondary_hash) = if is_gif {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        let byte_hash = hasher.finish();

        // Calculate pixel hash of the first frame as a secondary fingerprint
        let pixel_count = (width as u64) * (height as u64);
        let mut h = pixel_count;
        if !raw_bytes.is_empty() {
            h = h.wrapping_add(raw_bytes[0] as u64)
                .wrapping_add(raw_bytes[raw_bytes.len() / 2] as u64)
                .wrapping_add(raw_bytes[raw_bytes.len() - 1] as u64);
        }
        (byte_hash, h)
    } else {
        // Hash full pixel bytes so the monitor can skip our own image copy
        let mut hasher = DefaultHasher::new();
        raw_bytes.hash(&mut hasher);
        let byte_hash = hasher.finish();
        (byte_hash, 0)
    };

    let gif_temp_path = unsafe {
        crate::infrastructure::windows_api::win_clipboard::set_clipboard_image_with_formats(
            crate::infrastructure::windows_api::win_clipboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: raw_bytes,
            },
            if is_gif { Some(&bytes) } else { None },
            Some(&png_buf),
        ).map_err(AppError::from)?
    };

    if let Some(path) = gif_temp_path {
        // Also hash the temp path to prevent echo on CF_HDROP
        let normalized = path.trim().replace("\r\n", "\n");
        let mut hasher = DefaultHasher::new();
        normalized.hash(&mut hasher);
        let path_hash = hasher.finish();
        crate::LAST_APP_SET_HASH.store(path_hash, Ordering::SeqCst);
    }

    Ok((primary_hash, secondary_hash))
}

async fn copy_text_with_retry(
    content: &str,
) -> AppResult<()> {
    crate::info!("[DEBUG] Copying text to clipboard: {} chars", content.len());
    let mut retries = 3;
    while retries > 0 {
        let res = {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(content.to_string())
        };

        match res {
            Ok(_) => {
                crate::info!("[DEBUG] Text copied to clipboard successfully");
                return Ok(());
            }
            Err(_e) if retries > 1 => {
                retries -= 1;
                crate::info!("[DEBUG] Clipboard set failed, retrying... ({} left)", retries);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(AppError::Internal(format!("Clipboard error: {}", e))),
        }
    }
    Ok(())
}

async fn perform_paste_action(
    app_handle: &tauri::AppHandle,
    state: &State<'_, DbState>,
    id: i64,
    delete_after_use: bool,
    content: Option<&str>,
    content_type: &str,
    move_to_top: Option<bool>,
) -> AppResult<()> {
    crate::info!("[DEBUG] perform_paste_action: pinned={}", crate::WINDOW_PINNED.load(Ordering::Relaxed));
    
    // Settling time is now mostly handled in handle_window_focus_for_paste
    // But we add a small extra buffer here to be absolutely sure the focus is solid
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    
    // Verify foreground window is not our window before pasting
    let mut stole_focus = false;
    #[cfg(target_os = "windows")]
    unsafe {
        let foreground = GetForegroundWindow();
        if let Some(window) = app_handle.get_webview_window("main") {
            if let Ok(hwnd_raw) = window.hwnd() {
                if foreground.0 == hwnd_raw.0 {
                    stole_focus = true;
                }
            }
        }
    }

    if stole_focus {
        crate::info!("[WARN] Clipboard window STOLE focus back, attempting one last restore...");
        let _ = restore_focus_before_paste(app_handle).await;
    }

    #[cfg(target_os = "windows")]
    unsafe {
        let fg_before_paste = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        crate::info!("[DEBUG] Right before sending paste keystroke, Foreground Window is {:?}", fg_before_paste.0 as usize);
    }

    // Get paste method from settings
    let paste_method = state.settings_repo.get("app.paste_method").ok().flatten().unwrap_or_else(|| "shift_insert".to_string());

    // Send paste keystroke
    crate::info!("[DEBUG] Calling send_paste_keystroke...");
    send_paste_keystroke(&paste_method, content, Some(content_type));
    crate::info!("[DEBUG] Finished sending keystrokes.");

    // Hide after paste if not pinned
    hide_window_after_paste(app_handle).await;

    // Handle post-paste actions
    handle_post_paste_actions(app_handle, state, id, delete_after_use, move_to_top)?;

    // Play sound if enabled
    play_paste_sound_if_enabled(app_handle);

    Ok(())
}

async fn hide_window_after_paste(app_handle: &tauri::AppHandle) {
    if crate::WINDOW_PINNED.load(Ordering::Relaxed) {
        // 在置顶模式下，焦点已经在粘贴前完美归还了，在此处坚决不应再做任何焦点操作，否则会打断目标窗口的粘贴处理
        return;
    }

    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.set_focusable(false);
        let _ = window.hide();
        let _ = app_handle.emit("window-hidden", ());
        crate::IS_HIDDEN.store(false, std::sync::atomic::Ordering::Relaxed);
        crate::NAVIGATION_ENABLED.store(false, Ordering::Relaxed); // Disable navigation like hide_window_cmd does
        crate::app::window_manager::release_win_keys();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

pub fn send_paste_keystroke(method: &str, content: Option<&str>, content_type: Option<&str>) {
    crate::info!("[DEBUG] Sending paste keystroke using method: {}", method);
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_INSERT, VK_CONTROL, VK_V, KEYEVENTF_EXTENDEDKEY,
            MapVirtualKeyW, MAPVK_VK_TO_VSC, KEYEVENTF_SCANCODE, VK_RETURN,
        };

        // 1. Ensure all modifiers are released (including SHIFT, WIN, ALT, CTRL)
        let release_modifiers = [
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_LWIN, dwFlags: KEYEVENTF_KEYUP, ..Default::default() } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_RWIN, dwFlags: KEYEVENTF_KEYUP, ..Default::default() } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_MENU, dwFlags: KEYEVENTF_KEYUP, ..Default::default() } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_SHIFT, dwFlags: KEYEVENTF_KEYUP, ..Default::default() } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_CONTROL, dwFlags: KEYEVENTF_KEYUP, ..Default::default() } } },
        ];
        SendInput(&release_modifiers, std::mem::size_of::<INPUT>() as i32);
        
        std::thread::sleep(std::time::Duration::from_millis(50));

        let can_type =
            matches!(content_type, Some("text" | "code" | "url" | "rich_text"));
        // Images/videos are always pasted with Ctrl+V: Shift+Insert is
        // unreliable in chat/graphics apps for bitmap clipboard content.
        // Files keep the user's setting (Shift+Insert is often the only way
        // to paste file paths into old terminals like CMD).
        let effective_method = if matches!(content_type, Some("image" | "video")) {
            "ctrl_v"
        } else if method == "game_mode" && !can_type {
            "ctrl_v"
        } else {
            method
        };

        if effective_method == "ctrl_v" {
            let v_scan = MapVirtualKeyW(VK_V.0 as u32, MAPVK_VK_TO_VSC) as u16;
            let ctrl_scan = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;

            let inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: ctrl_scan,
                            dwFlags: KEYEVENTF_SCANCODE,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: v_scan,
                            dwFlags: KEYEVENTF_SCANCODE,
                            ..Default::default()
                        },
                    },
                },
            ];
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(std::time::Duration::from_millis(50));

            let inputs_up = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: v_scan,
                            dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: ctrl_scan,
                            dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                            ..Default::default()
                        },
                    },
                },
            ];
            SendInput(&inputs_up, std::mem::size_of::<INPUT>() as i32);
        } else if effective_method == "game_mode" {
            if let Some(text) = content {
                std::thread::sleep(std::time::Duration::from_millis(250));
                
                let target_hwnd = GetForegroundWindow();
                let target_thread = GetWindowThreadProcessId(target_hwnd, None);
                let current_thread = windows::Win32::System::Threading::GetCurrentThreadId();
                let mut attached = false;

                if target_thread != 0 && target_thread != current_thread {
                    if AttachThreadInput(current_thread, target_thread, true).as_bool() {
                        attached = true;
                    }
                }

                use windows::Win32::UI::Input::Ime::{
                    ImmGetContext, ImmGetOpenStatus, ImmSetOpenStatus, ImmReleaseContext,
                    ImmSetConversionStatus, ImmGetConversionStatus, IME_CMODE_ALPHANUMERIC, IME_SMODE_NONE,
                    IME_CONVERSION_MODE, IME_SENTENCE_MODE
                };
                
                let himc = ImmGetContext(target_hwnd);
                let mut ime_open = false;
                let mut ime_conv = IME_CONVERSION_MODE(0);
                let mut ime_sentence = IME_SENTENCE_MODE(0);
                let mut has_himc = false;

                if !himc.0.is_null() {
                    has_himc = true;
                    ime_open = ImmGetOpenStatus(himc).as_bool();
                    let _ = ImmGetConversionStatus(himc, Some(&mut ime_conv), Some(&mut ime_sentence));

                    if ime_open {
                        let _ = ImmSetOpenStatus(himc, false);
                    }
                    let _ = ImmSetConversionStatus(himc, IME_CMODE_ALPHANUMERIC, IME_SMODE_NONE);
                }

                let total_len = text.chars().count();
                let (down_delay_ms, up_delay_ms, check_interval) = if total_len > 800 {
                    (2u64, 2u64, 40usize)
                } else if total_len > 200 {
                    (4u64, 4u64, 30usize)
                } else {
                    (10u64, 10u64, 20usize)
                };

                let mut idx = 0usize;
                for c in text.encode_utf16() {
                    if idx % check_interval == 0 {
                        let current_hwnd = GetForegroundWindow();
                        if current_hwnd.0 != target_hwnd.0 {
                            crate::info!("[WARN] Game mode paste aborted: foreground window changed");
                            break;
                        }
                    }
                    if c == '\r' as u16 {
                        idx += 1;
                        continue;
                    }
                    if c == '\n' as u16 {
                        let enter_scan = MapVirtualKeyW(VK_RETURN.0 as u32, MAPVK_VK_TO_VSC) as u16;
                        let enter_down = INPUT {
                            r#type: INPUT_KEYBOARD,
                            Anonymous: INPUT_0 {
                                ki: KEYBDINPUT {
                                    wVk: VK_RETURN,
                                    wScan: enter_scan,
                                    dwFlags: KEYEVENTF_SCANCODE,
                                    ..Default::default()
                                },
                            },
                        };
                        let enter_up = INPUT {
                            r#type: INPUT_KEYBOARD,
                            Anonymous: INPUT_0 {
                                ki: KEYBDINPUT {
                                    wVk: VK_RETURN,
                                    wScan: enter_scan,
                                    dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                                    ..Default::default()
                                },
                            },
                        };
                        SendInput(&[enter_down], std::mem::size_of::<INPUT>() as i32);
                        std::thread::sleep(std::time::Duration::from_millis(down_delay_ms));
                        SendInput(&[enter_up], std::mem::size_of::<INPUT>() as i32);
                        std::thread::sleep(std::time::Duration::from_millis(up_delay_ms));
                        idx += 1;
                        continue;
                    }
                    let mut input = INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                                wScan: c,
                                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(4), // KEYEVENTF_UNICODE
                                ..Default::default()
                            },
                        },
                    };
                    SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                    std::thread::sleep(std::time::Duration::from_millis(down_delay_ms));
                    input.Anonymous.ki.dwFlags |= windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP;
                    SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                    std::thread::sleep(std::time::Duration::from_millis(up_delay_ms));
                    idx += 1;
                }

                if has_himc {
                    let _ = ImmSetConversionStatus(himc, ime_conv, ime_sentence);
                    if ime_open {
                        let _ = ImmSetOpenStatus(himc, true);
                    }
                    let _ = ImmReleaseContext(target_hwnd, himc);
                }

                if attached {
                    let _ = AttachThreadInput(current_thread, target_thread, false);
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let ctrl_scan = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16;
                let v_scan = MapVirtualKeyW(VK_V.0 as u32, MAPVK_VK_TO_VSC) as u16;
                
                let mut input = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                            wScan: ctrl_scan,
                            dwFlags: KEYEVENTF_SCANCODE,
                            ..Default::default()
                        },
                    },
                };

                let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                std::thread::sleep(std::time::Duration::from_millis(80));
                input.Anonymous.ki.wScan = v_scan;
                let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                std::thread::sleep(std::time::Duration::from_millis(120));
                input.Anonymous.ki.dwFlags |= KEYEVENTF_KEYUP;
                let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
                std::thread::sleep(std::time::Duration::from_millis(80));
                input.Anonymous.ki.wScan = ctrl_scan;
                input.Anonymous.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
                let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            }
        } else {
            let shift_scan = MapVirtualKeyW(VK_SHIFT.0 as u32, MAPVK_VK_TO_VSC) as u16;
            let insert_scan = MapVirtualKeyW(VK_INSERT.0 as u32, MAPVK_VK_TO_VSC) as u16;
            
            let shift_down = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_SHIFT,
                        wScan: shift_scan,
                        dwFlags: KEYEVENTF_SCANCODE,
                        ..Default::default()
                    },
                },
            };
            SendInput(&[shift_down], std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(std::time::Duration::from_millis(10));

            let insert_down = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_INSERT,
                        wScan: insert_scan,
                        dwFlags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE,
                        ..Default::default()
                    },
                },
            };
            SendInput(&[insert_down], std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(std::time::Duration::from_millis(10));

            let insert_up = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_INSERT,
                        wScan: insert_scan,
                        dwFlags: KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE,
                        ..Default::default()
                    },
                },
            };
            SendInput(&[insert_up], std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(std::time::Duration::from_millis(10));

            let shift_up = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_SHIFT,
                        wScan: shift_scan,
                        dwFlags: KEYEVENTF_KEYUP | KEYEVENTF_SCANCODE,
                        ..Default::default()
                    },
                },
            };
            SendInput(&[shift_up], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
            .spawn()
            .ok();
    }
}

fn handle_post_paste_actions(
    app_handle: &tauri::AppHandle,
    state: &State<'_, DbState>,
    id: i64,
    delete_after_use: bool,
    move_to_top: Option<bool>,
) -> AppResult<()> {
    if delete_after_use {
        // Cleanup file if needed
        let app_data = app_handle.state::<crate::app_state::AppDataDir>();
        let data_dir = app_data.0.lock().unwrap();
        
        if state.repo.delete(id, Some(&data_dir)).is_ok() {
            let _ = app_handle.emit("clipboard-removed", id);
        }
    } else if id > 0 {
        let _ = state.repo.increment_use_count(id);

        let should_move_to_top = match move_to_top {
            Some(val) => val,
            None => state
                .settings_repo
                .get("app.move_to_top_after_paste")
                .ok()
                .flatten()
                .map(|v| v != "false")
                .unwrap_or(true),
        };

        if should_move_to_top {
            let should_promote = state
                .repo
                .get_entry_by_id(id)
                .ok()
                .flatten()
                .map(|entry| !entry.is_pinned)
                .unwrap_or(true);
            if should_promote {
                let _ = state.repo.touch_entry(id, Utc::now().timestamp_millis());
            }
        }
    }

    Ok(())
}

fn play_paste_sound_if_enabled(app_handle: &tauri::AppHandle) {
    let settings = app_handle.state::<SettingsState>();
    if settings.sound_enabled.load(Ordering::Relaxed) {
        let _ = app_handle.emit("play-sound", "paste");
    }
}

#[tauri::command]
pub fn paste_latest_rich(app_handle: tauri::AppHandle) {
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let delete_after = {
            let settings = app_handle_clone.state::<SettingsState>();
            settings.delete_after_paste.load(Ordering::Relaxed)
        };

        let history = crate::app::commands::history_cmd::get_clipboard_history(
            app_handle_clone.state::<DbState>(),
            app_handle_clone.state::<SessionHistory>(),
            1,
            0,  // offset
            None,
        );

        if let Ok(items) = history {
            if let Some(item) = items.first() {
                let _ = copy_to_clipboard(
                    app_handle_clone.clone(),
                    app_handle_clone.state::<DbState>(),
                    app_handle_clone.state::<SessionHistory>(),
                    item.content.clone(),
                    item.content_type.clone(),
                    true,        // paste
                    item.id,
                    delete_after,       // delete_after_use
                    Some(true),  // paste_with_format
                    None,
                ).await;
            }
        }
    });
}
