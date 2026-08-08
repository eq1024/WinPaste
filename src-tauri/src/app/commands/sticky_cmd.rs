use std::io::Read;
use tauri::{AppHandle, Manager, State};
use crate::database::DbState;
use crate::domain::sticky::StickyEntry;
use crate::infrastructure::repository::sticky_repo::StickyRepository;

/// If content is an image file path, read it and convert to base64 data URL.
fn ensure_self_contained(content: &str, content_type: &str) -> String {
    if content_type != "image" || content.starts_with("data:") {
        return content.to_string();
    }
    let path_str = if content.starts_with("file://") {
        content.strip_prefix("file://").unwrap_or(content)
    } else {
        content
    };
    let path = std::path::Path::new(path_str);
    if !path.exists() {
        return content.to_string();
    }
    if let Ok(mut file) = std::fs::File::open(path) {
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_ok() {
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            let mime = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            return format!("data:{};base64,{}", mime, b64);
        }
    }
    content.to_string()
}

#[tauri::command]
pub fn create_sticky(
    state: State<'_, DbState>,
    content: String,
    content_type: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<StickyEntry, String> {
    let safe_content = ensure_self_contained(&content, &content_type);
    let entry = StickyEntry {
        id: 0,
        content: safe_content,
        content_type,
        x,
        y,
        width,
        height,
        // New stickies are always-on-top by default so they're not hidden
        // behind the main window (which is pinned); users can toggle via 📌
        always_on_top: true,
        created_at: 0,
    };
    let id = state.sticky_repo.create(&entry)?;
    state.sticky_repo.get_by_id(id)?.ok_or("Failed to retrieve created sticky".into())
}

#[tauri::command]
pub fn get_sticky(state: State<'_, DbState>, id: i64) -> Result<Option<StickyEntry>, String> {
    state.sticky_repo.get_by_id(id)
}

#[tauri::command]
pub fn get_all_stickies(state: State<'_, DbState>) -> Result<Vec<StickyEntry>, String> {
    state.sticky_repo.get_all()
}

#[tauri::command]
pub fn delete_sticky(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    state.sticky_repo.delete(id)
}

#[tauri::command]
pub fn update_sticky_position(state: State<'_, DbState>, id: i64, x: i32, y: i32) -> Result<(), String> {
    state.sticky_repo.update_position(id, x, y)
}

#[tauri::command]
pub fn update_sticky_size(state: State<'_, DbState>, id: i64, width: i32, height: i32) -> Result<(), String> {
    state.sticky_repo.update_size(id, width, height)
}

#[tauri::command]
pub fn update_sticky_content(state: State<'_, DbState>, id: i64, content: String) -> Result<(), String> {
    state.sticky_repo.update_content(id, &content)
}

#[tauri::command]
pub fn update_sticky_always_on_top(state: State<'_, DbState>, id: i64, enabled: bool) -> Result<(), String> {
    state.sticky_repo.update_always_on_top(id, enabled)
}

#[tauri::command]
pub fn close_sticky_window(app: AppHandle, id: i64) -> Result<(), String> {
    let label = format!("sticky-{}", id);
    // Silently succeed if window doesn't exist (already closed or stale entry)
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    Ok(())
}


#[tauri::command]
pub async fn paste_sticky_content(app: AppHandle, id: i64) -> Result<(), String> {
    let label = format!("sticky-{}", id);

    // 1. Hide the sticky window so focus returns to the previous app
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
    }

    // 2. Wait for the previous window to receive focus
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    // 3. Simulate paste keystroke (the content should already be on clipboard)
    crate::services::clipboard_ops::send_paste_keystroke(
        "ctrl_v",
        None,            // content already on clipboard
        None,
    );

    // 4. Show the sticky window again without stealing focus
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
    }

    Ok(())
}
