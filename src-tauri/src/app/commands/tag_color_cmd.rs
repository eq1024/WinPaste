use tauri::State;
use crate::database::DbState;
use std::collections::HashMap;
use crate::error::{AppResult, AppError};
use crate::infrastructure::repository::tag_repo::TagRepository;

#[tauri::command]
pub fn set_tag_color(state: State<'_, DbState>, name: String, color: Option<String>) -> AppResult<()> {
    state.tag_repo.set_color(&name, color).map_err(AppError::from)
}

#[tauri::command]
pub fn get_tag_colors(state: State<'_, DbState>) -> AppResult<HashMap<String, String>> {
    state.tag_repo.get_colors().map_err(AppError::from)
}
