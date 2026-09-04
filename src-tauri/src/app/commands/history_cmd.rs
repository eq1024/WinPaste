use tauri::{Emitter, State};
use crate::app_state::{SessionHistory, AppDataDir};
use crate::database::DbState;
use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;
use crate::infrastructure::repository::tag_repo::TagRepository;
use crate::domain::models::{ClipboardEntry, starts_with_ci};
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

/// Per-session cache of generated list thumbnails (`entry_id -> data URL`).
static IMAGE_THUMB_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<i64, String>>> =
    std::sync::OnceLock::new();
/// Upper bound on the bytes held by the pending thumbnail backlog.
///
/// Each queued job owns a full (multi-MB) base64 payload, so an unbounded queue
/// over a few pages of screenshots reproduces the very memory blowup this
/// module exists to prevent. The oldest jobs are evicted first: they came from
/// an earlier page load and get re-queued on the next one, so a tile never
/// stays empty permanently — it just waits for the backlog to drain.
const IMAGE_THUMB_QUEUE_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Queue + bounded worker pool for background thumbnail decoding (multi-MB
/// images). Results are streamed back via `clipboard-thumbnail`, so list and
/// search responses never wait for the image decode.
struct ThumbQueue {
    items: std::collections::VecDeque<(i64, String)>,
    /// Mirrors `items` so de-duping is O(1) instead of a linear scan.
    ids: std::collections::HashSet<i64>,
    bytes: usize,
}

static IMAGE_THUMB_QUEUE: std::sync::OnceLock<std::sync::Mutex<ThumbQueue>> =
    std::sync::OnceLock::new();
static IMAGE_THUMB_WORKERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const IMAGE_THUMB_MAX_WORKERS: usize = 3;

fn thumb_queue() -> &'static std::sync::Mutex<ThumbQueue> {
    IMAGE_THUMB_QUEUE.get_or_init(|| {
        std::sync::Mutex::new(ThumbQueue {
            items: std::collections::VecDeque::new(),
            ids: std::collections::HashSet::new(),
            bytes: 0,
        })
    })
}

fn read_cached_thumbnail(entry_id: i64) -> Option<String> {
    let cache = IMAGE_THUMB_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    cache.lock().unwrap().get(&entry_id).cloned()
}

fn store_cached_thumbnail(entry_id: i64, thumb: String) -> String {
    let cache = IMAGE_THUMB_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = cache.lock().unwrap();
    if guard.len() > 512 {
        guard.clear();
    }
    guard.insert(entry_id, thumb.clone());
    thumb
}

/// Per-session cache of resized hover-preview images (`entry_id -> data URL`).
/// The thumbnail worker pre-generates these while the image decode is already
/// warm; `get_hover_preview_image` falls back to on-demand generation, so the
/// first hover is a one-time cost and repeats are instant.
static IMAGE_HOVER_PREVIEW_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<i64, String>>> =
    std::sync::OnceLock::new();

/// Longest edge of the hover-preview image (physical px). The compact preview
/// displays media at up to ~520 CSS px, so 1024 stays sharp on 2x displays.
pub const HOVER_PREVIEW_MAX_DIM: u32 = 1024;
/// Content below this size is returned as-is: the renderer decodes it fast
/// enough, and passthrough preserves animated GIFs. Anything larger gets the
/// (static, resized) WebP preview instead.
const HOVER_PREVIEW_ORIGINAL_MAX_CHARS: usize = 1_500_000;

fn read_cached_hover_preview(entry_id: i64) -> Option<String> {
    let cache = IMAGE_HOVER_PREVIEW_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    cache.lock().unwrap().get(&entry_id).cloned()
}

fn store_cached_hover_preview(entry_id: i64, preview: String) -> String {
    let cache = IMAGE_HOVER_PREVIEW_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = cache.lock().unwrap();
    // ~100KB-300KB per lossless WebP entry: keep the set bounded.
    if guard.len() > 96 {
        guard.clear();
    }
    guard.insert(entry_id, preview.clone());
    preview
}

pub fn invalidate_hover_preview(entry_id: i64) {
    let cache = IMAGE_HOVER_PREVIEW_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    cache.lock().unwrap().remove(&entry_id);
}

fn clear_hover_preview_cache() {
    let cache = IMAGE_HOVER_PREVIEW_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    cache.lock().unwrap().clear();
}

fn ensure_thumbnail_workers() {
    let Some(app) = crate::GLOBAL_APP_HANDLE.get().cloned() else { return };
    if thumb_queue().lock().unwrap().items.is_empty() {
        return;
    }
    let mut spawned = 0;
    while spawned < IMAGE_THUMB_MAX_WORKERS {
        if IMAGE_THUMB_WORKERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= IMAGE_THUMB_MAX_WORKERS {
            IMAGE_THUMB_WORKERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            break;
        }
        spawned += 1;
        let app = app.clone();
        std::thread::spawn(move || thumbnail_worker_loop(app));
    }
}

fn thumbnail_worker_loop(app: tauri::AppHandle) {
    loop {
        let Some((entry_id, content)) = dequeue_thumbnail() else { break };
        if let Some(thumb) = crate::services::clipboard::build_image_thumbnail_data_url(&content, 160) {
            let thumb = store_cached_thumbnail(entry_id, thumb);
            let _ = app.emit("clipboard-thumbnail", (entry_id, thumb));
        }
        // Pre-generate the hover preview while the image decode is still warm,
        // so the first hover on a large screenshot is already cached. Small
        // payloads pass through as-is (keeps animated GIFs) and are cheap
        // enough to generate on demand.
        if content.len() > HOVER_PREVIEW_ORIGINAL_MAX_CHARS
            && read_cached_hover_preview(entry_id).is_none()
        {
            if let Some(preview) =
                crate::services::clipboard::build_image_preview_data_url(&content, HOVER_PREVIEW_MAX_DIM)
            {
                store_cached_hover_preview(entry_id, preview);
            }
        }
    }
    IMAGE_THUMB_WORKERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    // Lost-wakeup guard: items may have been queued while we were draining.
    ensure_thumbnail_workers();
}

/// Take the next pending job, keeping the byte/id bookkeeping in sync.
fn dequeue_thumbnail() -> Option<(i64, String)> {
    let mut q = thumb_queue().lock().unwrap();
    let item = q.items.pop_front()?;
    q.ids.remove(&item.0);
    q.bytes = q.bytes.saturating_sub(item.1.len());
    Some(item)
}

/// Push a job, evicting the oldest backlog entries until the queue is back
/// under `max_bytes`. Split out from [`enqueue_thumbnail`] so the eviction
/// policy is testable without mutating global state.
fn push_thumbnail_job(q: &mut ThumbQueue, entry_id: i64, content: String, max_bytes: usize) {
    // Dedupe: the same entry may appear in two overlapping list loads.
    if !q.ids.insert(entry_id) {
        return;
    }
    q.bytes += content.len();
    q.items.push_back((entry_id, content));

    while q.bytes > max_bytes {
        match q.items.pop_front() {
            Some((id, payload)) => {
                q.ids.remove(&id);
                q.bytes = q.bytes.saturating_sub(payload.len());
            }
            None => {
                q.bytes = 0;
                break;
            }
        }
    }
}

/// Queue a thumbnail generation. The worker pool streams results via the
/// `clipboard-thumbnail` event, so list/search responses never wait for the
/// (multi-MB) image decode.
fn enqueue_thumbnail(entry_id: i64, content: String) {
    {
        let mut q = thumb_queue().lock().unwrap();
        push_thumbnail_job(&mut q, entry_id, content, IMAGE_THUMB_QUEUE_MAX_BYTES);
    }
    ensure_thumbnail_workers();
}

/// Trim an entry for list display.
///
/// `data:` image payloads are multi-MB base64 — shipping a full default page
/// over IPC made "clear the search box" freeze the panel (a 201-item page with
/// a few screenshots is 20+ MB). The list only needs the thumbnail, which is
/// served via `preview` (from the session cache, or generated in the background
/// and streamed back); the full content is fetched lazily by id through
/// `get_clipboard_content` (copy/paste/open already resolve it server-side).
/// SVG data URLs are tiny and kept as-is (no decoder for them anyway).
fn list_ready_entry(mut entry: ClipboardEntry) -> ClipboardEntry {
    if entry.content_type == "image"
        && starts_with_ci(&entry.content, "data:")
        && !starts_with_ci(&entry.content, "data:image/svg")
    {
        if !entry.preview.starts_with("data:") {
            if let Some(thumb) = read_cached_thumbnail(entry.id) {
                entry.preview = thumb;
            } else {
                // Move the payload into a background task; the response uses
                // the placeholder and the tile fills in when the event lands.
                let content = std::mem::take(&mut entry.content);
                enqueue_thumbnail(entry.id, content);
            }
        }
        entry.content = String::new();
    }
    entry
}

#[tauri::command]
// async: the response carries up to PAGE pages of entries; serde JSON +
// thumbnail generation must not run on the main thread (it used to freeze the
// panel on every default-list load, i.e. whenever the search box was cleared).
pub async fn get_clipboard_history(
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

    // Serve list-safe entries (thumbnails only for base64 images).
    let history = history.into_iter().map(list_ready_entry).collect();

    Ok(history)
}

// async: a LIKE '%..%' search is a full table scan. As a non-async command it
// ran on the main thread and froze the whole app (tray included) on large DBs.
// Matching semantics live in ClipboardEntry::searchable_text(): base64 `data:`
// images never match, local file origins (source_file_path) do, and oversized
// content is capped so a keystroke never lowercases/copies hundreds of MB.
#[tauri::command]
pub async fn search_clipboard_history(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    search_term: String,
    limit: i32,
) -> AppResult<Vec<ClipboardEntry>> {
    let mut history = state.repo.search(&search_term, limit)?;

    let term = search_term.to_lowercase();
    let session_items = session.inner().0.lock().unwrap();
    for item in session_items.iter().rev() {
        let matches = item.searchable_text().to_lowercase().contains(&term) ||
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

    // Serve list-safe entries (thumbnails only for base64 images).
    let history = history.into_iter().map(list_ready_entry).collect();

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
    // SQLite rowids are reused after delete; drop the stale preview so a new
    // entry that takes over this id never shows the old image.
    invalidate_hover_preview(id);

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
    clear_hover_preview_cache();
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
pub async fn get_tag_items(state: State<'_, DbState>, tag: String) -> AppResult<Vec<ClipboardEntry>> {
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
    
    let history = history.into_iter().map(list_ready_entry).collect();

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

/// Resized hover-preview image for an image entry (`data:` payload or a local
/// file path).
///
/// The list carries thumbnails only, and `get_clipboard_content` would ship
/// the multi-MB full base64 over IPC — twice (invoke result + preview event) —
/// before the preview webview decodes the full-size image. That is what made
/// hover on large screenshots feel slow. Here the image is decoded and
/// downscaled once (cached per session; the thumbnail worker pre-generates
/// it), so the preview window only receives a ~100-300KB WebP.
///
/// Small embedded payloads (and GIFs, to keep their animation) are returned
/// unchanged — the renderer decodes them fast enough. Returns an empty string
/// for non-image entries; callers then fall back to the original content src.
#[tauri::command]
pub async fn get_hover_preview_image(
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    id: i64,
) -> AppResult<String> {
    if let Some(cached) = read_cached_hover_preview(id) {
        return Ok(cached);
    }

    let content = {
        let session_items = session.inner().0.lock().unwrap();
        session_items
            .iter()
            .find(|i| i.id == id)
            .map(|i| i.content.clone())
    };
    let content = match content {
        Some(c) => c,
        None => match state.repo.get_entry_content_with_html(id).map_err(AppError::from)? {
            Some((c, content_type, _)) if content_type == "image" => c,
            Some(_) => return Ok(String::new()),
            None => return Err(AppError::Validation("Entry not found".to_string())),
        },
    };

    // Small embedded payloads pass through unchanged (fast enough, and it keeps
    // animated GIFs exact). Local file paths are almost always resized: the
    // underlying file can be arbitrarily large and the preview webview would
    // otherwise decode it whole. Small GIF files keep their animation too.
    let is_gif = if content.starts_with("data:") {
        content.starts_with("data:image/gif")
    } else {
        // Local path: ASCII lowercasing on a short string is cheap.
        content.to_ascii_lowercase().ends_with(".gif")
    };
    if content.len() <= HOVER_PREVIEW_ORIGINAL_MAX_CHARS && (content.starts_with("data:") || is_gif) {
        return Ok(content);
    }

    // Decode + downscale + encode is CPU heavy; do it off the async runtime so
    // scheduled tasks (events, other commands) are not stalled. On decode
    // failure (SVG, corrupt file) the original src is returned so the preview
    // webview can still try to render it.
    let (preview, original) = tauri::async_runtime::spawn_blocking(move || {
        let preview =
            crate::services::clipboard::build_image_preview_data_url(&content, HOVER_PREVIEW_MAX_DIM);
        (preview, content)
    })
    .await
    .map_err(|err| AppError::Internal(err.to_string()))?;

    Ok(match preview {
        Some(url) => store_cached_hover_preview(id, url),
        None => original,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn png_data_url() -> String {
        use base64::Engine;
        let mut png_bytes = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]))
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
        }
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png_bytes)
        )
    }

    fn image_entry(id: i64, content: String) -> ClipboardEntry {
        ClipboardEntry {
            id,
            content_type: "image".to_string(),
            content,
            html_content: None,
            source_app: "Test".to_string(),
            source_app_path: None,
            source_file_path: None,
            timestamp: 0,
            preview: "[Image Content]".to_string(),
            is_pinned: false,
            tags: vec![],
            use_count: 0,
            is_external: false,
            pinned_order: 0,
            file_preview_exists: true,
        }
    }

    /// The list payload must swap multi-MB base64 for an empty content field
    /// (thumbnail served from cache when present, else streamed in background).
    #[test]
    fn list_ready_replaces_base64_image_with_thumbnail() {
        let data_url = png_data_url();
        let entry = image_entry(1, data_url.clone());

        // Cold cache: content is emptied right away; preview stays a
        // placeholder until the background task emits the thumbnail.
        let out = list_ready_entry(entry);
        assert_eq!(out.content, "");
        assert!(!out.preview.starts_with("data:image/png;base64,"));

        // Warm cache (as after the background task lands): preview is served.
        let thumb = crate::services::clipboard::build_image_thumbnail_data_url(&data_url, 160).expect("thumb");
        store_cached_thumbnail(1, thumb.clone());
        let out = list_ready_entry(image_entry(1, data_url));
        assert_eq!(out.content, "");
        assert_eq!(out.preview, thumb);
    }

    #[test]
    fn list_ready_keeps_svg_and_external_path_images() {
        let svg = image_entry(2, "data:image/svg+xml;base64,PHN2Zy8+".to_string());
        let out = list_ready_entry(svg.clone());
        assert_eq!(out.content, svg.content); // tiny, kept as-is

        let mut ext = image_entry(3, "C:\\Users\\me\\xx1\\photo.png".to_string());
        ext.is_external = true;
        let out = list_ready_entry(ext.clone());
        assert_eq!(out.content, ext.content); // path content stays
    }

    /// The pending backlog owns full base64 payloads, so it must stay under a
    /// byte cap — several pages of screenshots would otherwise pin hundreds of
    /// MB (the original freeze symptom). Oldest jobs are the ones evicted.
    #[test]
    fn thumbnail_backlog_is_capped_by_evicting_oldest() {
        let mut q = ThumbQueue {
            items: std::collections::VecDeque::new(),
            ids: std::collections::HashSet::new(),
            bytes: 0,
        };
        let payload = "x".repeat(1024);
        for id in 1..=10 {
            push_thumbnail_job(&mut q, id, payload.clone(), 4 * 1024);
        }

        assert_eq!(q.bytes, 4 * 1024);
        assert_eq!(q.items.len(), 4);
        // The newest jobs survive; the ones queued first were dropped.
        assert_eq!(
            q.items.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![7, 8, 9, 10]
        );
        assert!(q.ids.contains(&10));
        assert!(!q.ids.contains(&1));
    }

    /// Re-queueing the same entry must not double-count its bytes, and an entry
    /// evicted from a full backlog must be accepted again afterwards.
    #[test]
    fn thumbnail_backlog_dedupes_and_reaccepts_evicted_ids() {
        let mut q = ThumbQueue {
            items: std::collections::VecDeque::new(),
            ids: std::collections::HashSet::new(),
            bytes: 0,
        };
        let payload = "x".repeat(1024);
        push_thumbnail_job(&mut q, 1, payload.clone(), 4 * 1024);
        push_thumbnail_job(&mut q, 1, payload.clone(), 4 * 1024);
        assert_eq!(q.bytes, 1024);
        assert_eq!(q.items.len(), 1);

        for id in 2..=10 {
            push_thumbnail_job(&mut q, id, payload.clone(), 4 * 1024);
        }
        assert!(!q.ids.contains(&1)); // evicted once the cap was reached

        push_thumbnail_job(&mut q, 1, payload, 4 * 1024);
        assert!(q.ids.contains(&1));
        assert!(q.bytes <= 4 * 1024);
    }
}
