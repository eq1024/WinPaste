# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

WinPaste 是一个 Windows 剪贴板增强工具，基于 **Tauri v2**（Rust 后端 + React/TypeScript 前端）。它替代系统自带的 `Win+V` 剪贴板历史，在光标位置弹出一个轻量、不抢焦点的面板。

## 构建与运行

```bash
npm run tauri:dev      # 开发模式，热重载 (Vite 端口 1422)
npm run tauri:build    # 一键构建：安装版 + 单文件版 (artifacts/release/)
npm run build:installer # 仅构建 NSIS 安装包
npm run build:portable # 仅构建便携单文件 exe (zip + exe)
npm run test:e2e       # 运行 Playwright e2e 测试
```

仅 Rust 检查：在 `src-tauri/` 目录下运行 `cargo check` / `cargo test`。
仅 TypeScript 检查：`npx tsc --noEmit`。

## 架构

### Rust 后端 (`src-tauri/src/`)

后端采用分层架构：

- **`main.rs`** — 入口。构建 Tauri 应用，注册所有插件和 `#[tauri::command]` 到 `invoke_handler`，设置 `on_window_event`，退出时清理 Win32 钩子。
- **`app/`** — 应用层
  - `setup.rs` — 完整启动流程：数据目录、数据库初始化、设置加载、状态管理、Win32 钩子、托盘图标、主题应用。
  - `window_manager.rs` — 窗口显示/隐藏/切换逻辑，含智能定位（光标/插入符跟随、多显示器比例保持重映射）。
  - `hooks/mod.rs` — `WH_KEYBOARD_LL` 和 `WH_MOUSE_LL` 底层钩子回调 + 异步输入处理。负责导航键拦截、输入法重播、快速粘贴 (Ctrl+Shift+0-9)、快捷键录制。这是"零焦点打断"的核心。
  - `commands/` — 所有暴露给前端的 Tauri 命令（clipboard_cmd, settings_cmd, system_cmd, hotkey_cmd, history_cmd 等）。
  - `system.rs` — 机器 ID、托盘子类化、管理员检测。
- **`services/`** — 业务逻辑层
  - `clipboard/mod.rs` — 剪贴板监控器（轮询序列号，检测文本/图片/文件/富文本/GIF，去重，执行处理管线）。
  - `clipboard/pipeline.rs` — 处理管线：隐私脱敏、预览生成、富文本快照、数据库持久化、文件系统存储。
  - `clipboard_ops.rs` — 复制到剪贴板、粘贴操作。
  - `paste_queue.rs` — 顺序/队列粘贴模式。
  - `clipboard_listener.rs` — Windows 原生剪贴板监听器 (AddClipboardFormatListener)。
  - `content_handler.rs` — 用默认应用打开内容。
  - `encryption_queue.rs` / `sensitive_align.rs` — 隐私/加密后台任务。
- **`infrastructure/`** — 基础设施层
  - `repository/` — SQLite 仓库 (clipboard_repo, settings_repo, tag_repo) + 数据库迁移。
  - `windows_api/` — Win32 API 封装：剪贴板格式、窗口跟踪、应用扫描、拖放。
  - `windows_ext.rs` — WindowExt trait，封装 Win32 窗口操作（无焦点显示、释放按键、强制聚焦、通过 UIA 获取光标位置）。
  - `encryption.rs` — 敏感条目的 AES 加密。
- **`domain/models.rs`** — `ClipboardEntry` 数据结构。
- **`database.rs`** — 数据库初始化、迁移、Pragma 配置、默认设置写入。
- **`global_state.rs`** — 全局原子变量（钩子句柄、导航状态、置顶状态、边缘停靠位置、剪贴板监控暂停标志等）。
- **`app_state.rs`** — Tauri 托管状态结构体（SettingsState, PasteQueue, SessionHistory, AppDataDir）。

核心架构模式：
- **SSOT（单一事实源）**：键盘/鼠标状态统一收敛到 Rust 原子变量（`NAVIGATION_ENABLED`、`IS_MAIN_WINDOW_FOCUSED` 等），避免竞态。
- **非阻塞钩子**：Win32 钩子回调极其精简——仅通过 `mpsc` 通道将事件发送到异步 Tokio Worker，立即返回。
- **`WS_EX_NOACTIVATE`**：主窗口使用此扩展样式实现显示时不抢焦点，模拟原生 `Win+V` 行为。
- 所有 Tauri 命令返回 `Result<T, String>`。

### 前端 (`src/`)

- **入口**：`main.tsx` 根据 URL 查询参数 `window=compact-preview` 渲染 `<App />` 或 `<CompactPreviewWindow />`。
- **状态管理**：三个 Zustand Store — `historyStore`（剪贴板条目、搜索、选中项、分页）、`settingsStore`（所有用户偏好）、`uiStore`（面板可见性、录制状态、折叠分组）。
- **`App.tsx`** — 编排所有 hooks。这些 hooks 负责数据获取、剪贴板事件、键盘导航、搜索、设置同步和音效。每个 hook 位于 `shared/hooks/`。
- **`features/`** — 按功能组织的 UI 组件：`clipboard/`（ClipboardItem, VirtualClipboardList, CompactPreviewWindow）、`settings/`（可折叠分组的设置面板）、`tag/`（标签管理器）、`app/`（AppHeader, AppMainContent）。
- **样式**：Tailwind CSS + `src/styles/` 目录下的 CSS 文件按用途组织（base, components, themes）。主题在 `src/styles/themes/load` 中加载。

### 数据流

1. Windows 剪贴板变化 → 原生监听器 (`clipboard_listener.rs`) → 剪贴板监控器 (`clipboard/mod.rs`)
2. 监控器读取剪贴板格式，去重，创建 `ClipboardData` → 管线处理（隐私、预览、保存）→ 向前端发送 `clipboard-changed` 事件
3. 前端通过 `useClipboardEvents` 监听并更新 Zustand historyStore
4. 用户操作（复制、粘贴、删除、切换置顶）调用 Tauri `invoke()` 命令 → Rust 执行并回发事件

### 快捷键系统

- 主切换快捷键通过 `tauri-plugin-global-shortcut` 注册（默认：`Win+V` 或 `Alt+C`）。
- 在快捷键录制模式下，所有 `Win+*` 组合键被临时注册以阻止系统处理，从而捕获用户按下的精确组合。
- 键盘钩子在窗口可见时拦截方向键、Enter、Escape 和字母数字键，将其作为导航事件分发。

### 数据库

SQLite 数据库位于 `{app_data_dir}/clipboard.db`，WAL 模式。表结构定义在 `infrastructure/repository/migrations.rs`。设置以键值对形式存储在 `settings` 表中。敏感值（密码、API 密钥）使用前缀 `ENC::` 进行 AES 加密。

## 重要约束

- **仅限 Windows**：大量使用 `windows-rs` crate 和 Win32 API（`WH_KEYBOARD_LL`、`WS_EX_NOACTIVATE`、UIAutomation 等）。非 Windows 平台仅有编译桩代码。
- 应用数据目录可通过 `datapath.txt` 或 exe 同级 `data/` 目录重定向（便携模式）。
- `portable` Cargo feature 启用便携模式。`npm run build:portable` 使用 `--features portable`。
- Release 构建使用 `lto = true`、`codegen-units = 1`、`opt-level = "s"`、`strip = true`、`panic = "abort"` 以最小化二进制体积。
- 未配置 pre-commit hooks — 提交信息遵循格式：`type: description`（feat, fix, adjust 等）。
