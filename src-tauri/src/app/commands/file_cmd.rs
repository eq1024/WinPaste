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

