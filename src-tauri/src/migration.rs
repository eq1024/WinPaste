use std::path::PathBuf;

/// 移除旧版本的迁移逻辑，因为这是一个独立的二次开发项目
pub fn perform_legacy_migration(_default_app_dir: &PathBuf) {
    // 如果不需要迁移数据，这里可以保持为空
}
