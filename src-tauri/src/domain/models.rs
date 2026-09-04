use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClipboardEntry {
    pub id: i64,
    pub content_type: String, // 'text', 'image', 'code', 'file', 'video'
    pub content: String,
    #[serde(default)]
    pub html_content: Option<String>,
    pub source_app: String,
    #[serde(default)]
    pub source_app_path: Option<String>,
    /// Original local file path when an image/video entry was copied from a
    /// file on disk (even when the content is embedded as a `data:` URL).
    /// `None` for screenshots/browser copies — those have no local address.
    #[serde(default)]
    pub source_file_path: Option<String>,
    pub timestamp: i64,
    pub preview: String,
    pub is_pinned: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub use_count: i32,
    #[serde(default)]
    pub is_external: bool, // New field to track if content is a file path
    #[serde(default)]
    pub pinned_order: i64,  // For manual sorting of pinned items
    #[serde(default = "default_true")]
    pub file_preview_exists: bool, // Transient field: does the file exist on disk?
}

fn default_true() -> bool {
    true
}

/// Case-insensitive prefix check (ASCII only — `data:` and its MIME subforms
/// are always ASCII). `data:` URLs are produced lowercase in this codebase, but
/// clipboard payloads from external sources aren't guaranteed to be; matching
/// SQLite's case-insensitive `NOT LIKE 'data:%'` keeps strip/search consistent
/// so a `DATA:...` payload can never slip through and re-trigger the memory
/// blowup the list/search stripping is meant to prevent.
pub(crate) fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .map(|p| p.eq_ignore_ascii_case(prefix))
        .unwrap_or(false)
}

impl ClipboardEntry {
    /// The slice of this entry that is meaningful to search.
    ///
    /// Base64 images (`data:` URLs) must NEVER match a search: their payload is
    /// multi-MB and lowercasing it on every keystroke caused the freeze / 2GB
    /// memory spike. Only entries with a local address source participate
    /// through that address: an image copied from a folder matches by its
    /// `source_file_path` (e.g. searching "xx" finds an image from "xx1"),
    /// while screenshots (no path) are unsearchable. Other content is capped
    /// so a search never lowercases hundreds of MB.
    pub fn searchable_text(&self) -> String {
        // SQLite's `substr(ch.content, 1, 100000)` counts CHARACTERS, but this
        // slice is taken in BYTES. One UTF-8 character is at most 4 bytes, so
        // 400_000 bytes always covers the 100_000 characters the SQL side
        // inspects. Staying >= 4x the SQL cap is what keeps the in-Rust pass a
        // superset of the SQL match — otherwise the second-pass filter could
        // silently drop an entry the query legitimately returned.
        const MAX_SEARCHABLE_BYTES: usize = 400_000;

        if starts_with_ci(&self.content, "data:") {
            return self.source_file_path.clone().unwrap_or_default();
        }
        if self.content.len() > MAX_SEARCHABLE_BYTES {
            let mut end = MAX_SEARCHABLE_BYTES;
            while end > 0 && !self.content.is_char_boundary(end) {
                end -= 1;
            }
            return self.content[..end].to_string();
        }
        self.content.clone()
    }
}
