use crate::error::{AppResult, AppError};
use serde::Serialize;
use image::ImageFormat;

#[derive(Serialize)]
pub struct FileSize {
    pub size: u64,
}

#[tauri::command]
pub fn get_file_size(path: String) -> AppResult<FileSize> {
    use std::fs;
    let metadata = fs::metadata(&path).map_err(AppError::from)?;
    Ok(FileSize {
        size: metadata.len(),
    })
}

#[tauri::command]
pub fn check_external_file_exists(content: String) -> bool {
    let first_file = content.lines().next().unwrap_or(&content).trim();
    let raw_path = if first_file.starts_with("file://") {
        first_file.strip_prefix("file://").unwrap_or(first_file)
    } else {
        first_file
    };
    let raw_path = if raw_path.starts_with('/') && raw_path.chars().nth(2) == Some(':') {
        &raw_path[1..]
    } else {
        raw_path
    };

    let decoded = urlencoding::decode(raw_path).ok();
    match decoded {
        Some(path) => std::path::Path::new(path.as_ref()).exists(),
        None => std::path::Path::new(raw_path).exists(),
    }
}

#[tauri::command]
pub async fn save_file_copy(source_path: String, target_path: String) -> AppResult<()> {
    std::fs::copy(source_path, target_path).map_err(AppError::from)?;
    Ok(())
}

pub(crate) fn image_ext_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    let format = image::guess_format(bytes).ok()?;
    match format {
        ImageFormat::Png => Some("png"),
        ImageFormat::Jpeg => Some("jpg"),
        ImageFormat::Gif => Some("gif"),
        ImageFormat::WebP => Some("webp"),
        _ => None,
    }
}

