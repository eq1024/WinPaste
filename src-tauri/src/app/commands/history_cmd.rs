use tauri::State;
use crate::app_state::{SessionHistory, AppDataDir};
use crate::database::DbState;
use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;
use crate::infrastructure::repository::tag_repo::TagRepository;
use crate::domain::models::ClipboardEntry;
use crate::error::{AppResult, AppError};
use crate::services::clipboard::{build_entry_preview, derive_rich_text_content, truncate_html_for_preview};

fn normalize_rich_text_item_content(item: &mut ClipboardEntry) {
    if item.content_type != "rich_text" {
        return;
    }

    let normalized = derive_rich_text_content(&item.content, item.html_content.as_deref());
    if !normalized.trim().is_empty() {
        item.content = normalized;
    }
}

#[tauri::command]
pub fn get_clipboard_history(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    limit: i32,
    offset: i32,
    content_type: Option<String>,
) -> AppResult<Vec<ClipboardEntry>> {
    // 1. Get history from repository
    let mut history = state
        .repo
        .get_history(limit, offset, content_type.as_deref())?;
    
    // 2. Add session history items (non-persisted) ONLY on the first page
    if offset == 0 {
        let session_items = session.inner().0.lock().unwrap();
        for item in session_items.iter().rev() {
            if let Some(ct) = content_type.as_deref() {
                if item.content_type != ct {
                    continue;
                }
            }
            // Avoid duplicates: if item is already in DB, it will have id > 0
            if !history.iter().any(|h| h.id == item.id && item.id != 0) {
                history.push(item.clone());
            }
        }
    }
    
    // 3. Apply stable sorting: Pinned -> Pinned Order -> Timestamp -> ID
    // This MUST match the repository's logic to maintain pagination stability
    history.sort_by(|a, b| {
        b.is_pinned.cmp(&a.is_pinned)
            .then_with(|| b.pinned_order.cmp(&a.pinned_order))
            .then_with(|| b.timestamp.cmp(&a.timestamp))
            .then_with(|| b.id.cmp(&a.id))
    });
    
    // 4. Truncate to limit
    if history.len() > limit as usize {
        history.truncate(limit as usize);
    }
    
    // 5. Truncate content for UI performance
    for item in &mut history {
        normalize_rich_text_item_content(item);

        if (item.content_type == "text" || item.content_type == "code" || item.content_type == "url" || item.content_type == "rich_text") 
           && item.content.chars().count() > 2000 
        {
            item.content = format!("{}... [Truncated for speed]", item.content.chars().take(2000).collect::<String>());
        }

        if let Some(ref html) = item.html_content {
            if html.chars().count() > 5000 {
                item.html_content = truncate_html_for_preview(html);
            }
        }

        if item.content_type == "text" || item.content_type == "code" || item.content_type == "url" || item.content_type == "rich_text" {
            item.preview = build_entry_preview(&item.content_type, &item.content, item.html_content.as_deref());
        }
    }
    
    Ok(history)
}

#[tauri::command]
pub fn search_clipboard_history(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    search_term: String,
    limit: i32,
) -> AppResult<Vec<ClipboardEntry>> {
    let mut history = state.repo.search(&search_term, limit)?;

    let term = search_term.to_lowercase();
    let session_items = session.inner().0.lock().unwrap();
    for item in session_items.iter().rev() {
        let matches = item.content.to_lowercase().contains(&term) || 
                      item.source_app.to_lowercase().contains(&term) ||
                      item.tags.iter().any(|t| t.to_lowercase().contains(&term));
        
        if matches {
            if !history.iter().any(|h| h.id == item.id && item.id != 0) {
                history.push(item.clone());
            }
        }
    }

    history.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id)));
    if history.len() > limit as usize {
        history.truncate(limit as usize);
    }

    for item in &mut history {
        normalize_rich_text_item_content(item);

        if (item.content_type == "text" || item.content_type == "code" || item.content_type == "url" || item.content_type == "rich_text") 
           && item.content.chars().count() > 2000 
        {
            item.content = format!("{}... [Truncated for speed]", item.content.chars().take(2000).collect::<String>());
        }

        if let Some(ref html) = item.html_content {
            if html.chars().count() > 5000 {
                item.html_content = truncate_html_for_preview(html);
            }
        }

        if item.content_type == "text" || item.content_type == "code" || item.content_type == "url" || item.content_type == "rich_text" {
            item.preview = build_entry_preview(&item.content_type, &item.content, item.html_content.as_deref());
        }
    }

    Ok(history)
}

#[tauri::command]
pub fn delete_clipboard_entry(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    app_data: State<'_, AppDataDir>,
    id: i64,
) -> AppResult<()> {
    {
        let mut session_items = session.inner().0.lock().unwrap();
        session_items.retain(|item| item.id != id);
    }
    
    if id > 0 {
        let data_dir = app_data.0.lock().unwrap();
        state.repo.delete(id, Some(&data_dir))?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_clipboard_history(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    app_data: State<'_, AppDataDir>
) -> AppResult<()> {
    {
        let mut session_items = session.inner().0.lock().unwrap();
        session_items.retain(|item| item.is_pinned || !item.tags.is_empty());
    }
    let data_dir = app_data.0.lock().unwrap();
    state.repo.clear(Some(&data_dir)).map_err(AppError::from)
}

/// 判断外部条目（文件/视频/图片路径）的源文件是否已丢失。
/// 多路径条目中任意一个源文件不存在即视为失效（粘贴时会出错或静默丢文件）。
fn external_entry_paths_missing(content: &str) -> bool {
    let paths: Vec<&str> = content
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    if paths.is_empty() {
        return false;
    }
    paths.iter().any(|raw| !external_path_exists(raw))
}

fn external_path_exists(raw: &str) -> bool {
    // data: URL（内嵌内容）不是外部路径，视为有效
    if raw.starts_with("data:") {
        return true;
    }
    let stripped = raw.strip_prefix("file://").unwrap_or(raw);
    let stripped = if stripped.starts_with('/') && stripped.chars().nth(2) == Some(':') {
        &stripped[1..]
    } else {
        stripped
    };
    match urlencoding::decode(stripped) {
        Ok(decoded) => std::path::Path::new(decoded.as_ref()).exists(),
        Err(_) => std::path::Path::new(stripped).exists(),
    }
}

#[tauri::command]
pub fn clear_invalid_file_entries(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    app_data: State<'_, AppDataDir>,
) -> AppResult<usize> {
    let mut removed = 0usize;

    // 1. 清理会话内（未持久化）的失效条目
    {
        let mut session_items = session.inner().0.lock().unwrap();
        let before = session_items.len();
        session_items.retain(|item| !item.is_external || !external_entry_paths_missing(&item.content));
        removed += before - session_items.len();
    }

    // 2. 清理数据库中的失效条目
    let data_dir = app_data.0.lock().unwrap().clone();
    let conn = state.conn.lock().unwrap();
    let candidate_ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id, content FROM clipboard_history WHERE is_external = 1")
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let content: String = row.get(1)?;
                Ok((id, content))
            })
            .map_err(AppError::from)?;
        let mut ids = Vec::new();
        for row in rows {
            let (id, content) = row.map_err(AppError::from)?;
            if external_entry_paths_missing(&content) {
                ids.push(id);
            }
        }
        ids
    };

    for id in candidate_ids {
        if state.repo.delete_with_conn(&conn, id, Some(&data_dir)).is_ok() {
            removed += 1;
        }
    }

    Ok(removed)
}

#[tauri::command]
pub fn get_tag_items(state: State<'_, DbState>, tag: String) -> AppResult<Vec<ClipboardEntry>> {
    let mut history = state.tag_repo.get_entries_by_tag(&tag).map_err(AppError::from)?;
    
    for item in &mut history {
        normalize_rich_text_item_content(item);

        if (item.content_type == "text" || item.content_type == "code" || item.content_type == "url" || item.content_type == "rich_text") 
           && item.content.chars().count() > 50000 
        {
            item.content = format!("{}... [Content Truncated]", item.content.chars().take(50000).collect::<String>());
        }

        if item.content_type == "text" || item.content_type == "code" || item.content_type == "url" || item.content_type == "rich_text" {
            item.preview = build_entry_preview(&item.content_type, &item.content, item.html_content.as_deref());
        }
    }
    
    Ok(history)
}

#[tauri::command]
pub fn get_all_tags_info(state: State<'_, DbState>) -> AppResult<std::collections::HashMap<String, i32>> {
    state.tag_repo.get_all_with_counts().map_err(AppError::from)
}

#[tauri::command]
pub fn rename_tag_globally(state: State<'_, DbState>, session: State<'_, SessionHistory>, old_name: String, new_name: String) -> AppResult<()> {
    {
        let mut session_items = session.inner().0.lock().unwrap();
        for item in session_items.iter_mut() {
            for tag in item.tags.iter_mut() {
                if *tag == old_name {
                    *tag = new_name.clone();
                }
            }
            item.tags.sort();
            item.tags.dedup();
        }
    }
    
    state.tag_repo.rename(&old_name, &new_name).map_err(AppError::from)
}

#[tauri::command]
pub fn delete_tag_from_all(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    app_data: State<'_, AppDataDir>,
    tag_name: String,
) -> AppResult<()> {
    {
        let mut session_items = session.inner().0.lock().unwrap();
        session_items.retain(|item| !item.tags.contains(&tag_name));
    }
    
    let data_dir = app_data.0.lock().unwrap();
    state.tag_repo.delete_globally(&tag_name, Some(&data_dir)).map_err(AppError::from)
}

#[tauri::command]
pub fn create_new_tag(state: State<'_, DbState>, tag_name: String) -> AppResult<()> {
    state.tag_repo.create(&tag_name).map_err(AppError::from)
}

#[tauri::command]
pub fn get_clipboard_content(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    id: i64,
) -> AppResult<String> {
    {
        let session_items = session.inner().0.lock().unwrap();
        if let Some(item) = session_items.iter().find(|i| i.id == id) {
            if item.content_type == "rich_text" {
                let normalized = derive_rich_text_content(&item.content, item.html_content.as_deref());
                if !normalized.trim().is_empty() {
                    return Ok(normalized);
                }
            }
            return Ok(item.content.clone());
        }
    }

    if let Some((content, content_type, html_content)) =
        state.repo.get_entry_content_with_html(id).map_err(AppError::from)?
    {
        if content_type == "rich_text" {
            let normalized = derive_rich_text_content(&content, html_content.as_deref());
            if !normalized.trim().is_empty() {
                return Ok(normalized);
            }
        }
        return Ok(content);
    }

    Err(AppError::Validation("Entry not found".to_string()))
}

#[tauri::command]
pub fn update_pinned_order(
    state: State<'_, DbState>,
    orders: Vec<(i64, i64)>,
) -> AppResult<()> {
    state.repo.update_pinned_order(orders).map_err(AppError::from)
}

#[tauri::command]
pub fn get_db_count(state: State<'_, DbState>) -> AppResult<i64> {
    state.repo.get_count().map_err(AppError::from)
}
