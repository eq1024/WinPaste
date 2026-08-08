<p align="center">
  <img src="landing/logo.png" alt="WinPaste" width="64" height="64">
</p>

<h1 align="center">WinPaste</h1>

<p align="center">
  一款快速、轻量的 Windows 剪贴板增强工具，完美替代 <kbd>Win+V</kbd>。<br>
  面板跟随光标弹出，绝不抢夺焦点，用完即走。
</p>

<p align="center">
  <a href="https://github.com/eq1024/WinPaste/blob/main/LICENSE"><img src="https://img.shields.io/badge/协议-GNU-orange" alt="License"></a>
  <img src="https://img.shields.io/badge/平台-Windows%2010%20%7C%2011-blue" alt="Platform">
</p>

<p align="center">
  <a href="https://eq1024.github.io/WinPaste/">官网</a> ·
  <a href="https://github.com/eq1024/WinPaste/releases/latest">下载</a> ·
  <a href="#-功能特性">功能</a> ·
  <a href="#-开发">开发</a>
</p>

---

## ✨ 功能特性

**极速搜索。** 按 <kbd>Ctrl+F</kbd> 或 <kbd>/</kbd> 聚焦搜索框。支持按内容、类型、标签筛选。输入即搜，零延迟。

**智能光标追踪。** 通过 Windows UIAutomation 接口精准获取光标位置，即使在 Chrome、VS Code、Electron 等传统 API 失效的自绘引擎应用中也准确定位。面板始终出现在你需要的地方。

**多格式捕获。** 纯文本、富文本 HTML、图片、文件路径、GIF 动图——全部捕获并标注来源应用。

**隐私保护。** 自动检测并脱敏手机号、身份证、邮箱和密码。支持自定义正则规则。敏感数据 AES 加密存储。

**全键盘操作。** 方向键导航，<kbd>回车</kbd> 粘贴，<kbd>Ctrl+Shift+0-9</kbd> 快速粘贴最近 10 条——无需鼠标。

**顺序粘贴模式。** 多条内容加入队列，一键逐条粘贴。适合填表、批量结构化数据场景。

**置顶与贴图。** 常用条目一键置顶。可将任意内容独立悬浮，切换应用时始终可见。

**Fluent Design 主题。** 深色、浅色或跟随系统。Windows 11 Mica 毛玻璃、Win10 亚克力效果。字体大小、紧凑模式、边框均可自定义。

**多语言。** 简体中文 · English · 繁體中文

## 🎯 使用方式

1. **复制** — WinPaste 在后台静默记录每次剪贴板变化。
2. **呼出** — 按 <kbd>Win+V</kbd>（或自定义快捷键），面板跟随光标弹出，不抢焦点。
3. **粘贴** — 方向键导航，输入即搜，<kbd>回车</kbd> 粘贴。

## 📦 安装

从 [Releases](https://github.com/eq1024/WinPaste/releases/latest) 下载最新版本：

> 需要 Windows 10 或 11，x64。

## 🛠 开发

```bash
# 前置：Node.js 18+、Rust、Tauri CLI

npm install
npm run tauri:dev      # 开发模式，热重载 (Vite 端口 1422)
npm run tauri:build    # 生产构建 (NSIS 安装包)
npm run build:portable # 便携版构建

# 仅检查
npx tsc --noEmit       # TypeScript 类型检查
cargo check            # Rust 检查 (在 src-tauri/ 下)
npm run test:e2e       # Playwright e2e 测试
```

## 🏗 架构

| 层 | 技术栈 |
|-------|-------|
| 前端 | React 19 + TypeScript + Vite |
| 状态管理 | Zustand（3 个 Store：history、settings、UI） |
| 样式 | Tailwind CSS + 自定义 Fluent 主题 |
| 后端 | Tauri v2（Rust） |
| 数据库 | SQLite（WAL 模式） |
| 加密 | Windows DPAPI + AES |
| 输入 | `WH_KEYBOARD_LL` / `WH_MOUSE_LL` 底层钩子 |
| 光标定位 | UIAutomation 接口（兼容 Chrome、VSCode、Electron） |
| 打包 | NSIS 安装包、便携版 zip |

**关键架构决策：**
- **`WS_EX_NOACTIVATE`** 窗口样式——面板弹出不抢焦点
- **SSOT 单一事实源状态机**（Rust）——彻底消除竞态，不再有修饰键卡死
- **非阻塞钩子**——回调即发即忘，繁重任务移交异步 Tokio Worker
- 零遥测、零注册、零冗余

## 📄 协议

GNU General Public License。灵感来源于 [Tiez](https://github.com/jimuzhe/tiez-clipboard)。

---

<p align="center">
  <sub>以 Rust、Tauri 和对细节的关注构建。</sub>
</p>
