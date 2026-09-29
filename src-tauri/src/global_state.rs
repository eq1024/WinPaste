// Global state module
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, AtomicPtr, AtomicI32};

#[derive(Debug, Clone)]
pub enum InputEvent {
    Keyboard {
        vk_code: u32,
        is_down: bool,
    },
    Mouse {
        msg: u32,
        pt: windows::Win32::Foundation::POINT,
    },
    /// 热键在钩子回调里(按键发生的那一刻)完成判定后直接下发的动作。
    /// worker 不允许再用 GetAsyncKeyState 复检:事件排到 worker 时用户可能已经松手,
    /// 复检失败会出现"按键被吞掉但什么也没发生"的经典竞态。
    ToggleWindow {
        source: &'static str,
    },
}

pub static INPUT_SENDER: std::sync::OnceLock<tokio::sync::mpsc::UnboundedSender<InputEvent>> = std::sync::OnceLock::new();

pub static GLOBAL_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
pub static HOOK_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(null_mut());
pub static HOOK_MOUSE_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(null_mut());
/// 底层键盘/鼠标钩子最近一次收到事件的时间(GetTickCount 毫秒)。
/// 看门狗用它判断钩子是否被系统静默摘除(回调超时/休眠恢复/会话切换)。
pub static HOOK_LAST_EVENT_TICK: AtomicU32 = AtomicU32::new(0);
/// 由钩子事件流自己维护的修饰键位掩码(见 `app::hooks::MODBIT_*`)。
/// Win+V 的判定必须用"按键发生时刻"的状态,而不是异步 worker 处理时的实时状态。
pub static MODIFIER_STATE: AtomicI32 = AtomicI32::new(0);
/// V 键当前是否处于按下状态,用于区分"按下沿"与键盘自动重复。
pub static V_KEY_DOWN: AtomicBool = AtomicBool::new(false);
pub static HOTKEY_STRING: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[derive(Clone, Debug)]
pub struct HookHotkey {
    pub vk: u32,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
}

pub static TARGET_HOTKEY: std::sync::Mutex<Option<HookHotkey>> = std::sync::Mutex::new(None);

// Win+ hotkeys are now handled via tauri-plugin-global-shortcut.


pub static IS_RECORDING: AtomicBool = AtomicBool::new(false);
pub static IGNORE_BLUR: AtomicBool = AtomicBool::new(false);
pub static WINDOW_PINNED: AtomicBool = AtomicBool::new(false);
/// Set right before an explicit `app.exit(0)` (tray quit / quit command) so the
/// `ExitRequested` handler in `main.rs` lets the app actually quit instead of
/// preventing exit for last-window-closed (which keeps lightweight record-only mode alive).
pub static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
pub static CLIPBOARD_MONITOR_PAUSED: AtomicBool = AtomicBool::new(false);
pub static LAST_ACTIVE_HWND: AtomicUsize = AtomicUsize::new(0);

/// 最近前台窗口环形快照（按时间从新到旧回放，容量 8）。
/// 粘贴前若 LAST_ACTIVE_HWND 已失效（目标窗口被关闭/最小化），按新旧顺序
/// 回退到最近一个仍然可见的前台窗口 —— 否则焦点恢复失败后 Ctrl+V 会发给
/// 面板自己，表现为"搜索后第一次点击粘贴不上，第二次才成功"。
pub static RECENT_FOREGROUND_RING: [AtomicUsize; 8] = [
    AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0),
    AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0),
];
/// 环形队列当前有效元素个数（0..=8）。
pub static RECENT_FOREGROUND_LEN: AtomicUsize = AtomicUsize::new(0);
/// 环形队列写入口（最旧元素的下标）。
pub static RECENT_FOREGROUND_HEAD: AtomicUsize = AtomicUsize::new(0);
pub static LAST_APP_SET_HASH: AtomicU64 = AtomicU64::new(0);
pub static LAST_APP_SET_HASH_ALT: AtomicU64 = AtomicU64::new(0);
pub static LAST_APP_SET_TIMESTAMP: AtomicU64 = AtomicU64::new(0);
pub static LAST_TOGGLE_TIMESTAMP: AtomicU64 = AtomicU64::new(0);
pub static LAST_SHOW_TIMESTAMP: AtomicU64 = AtomicU64::new(0);
/// 粘贴流程进行中标记：值为流程开始时的毫秒时间戳，0 = 空闲。
/// copy_to_clipboard 全程互斥 —— 一次粘贴要经历"隐藏窗口→焦点归还→写剪贴
/// 板→发按键"数百毫秒的管线，期间连点/连按 Enter 会并发再入，每次各自
/// SendInput 一遍 Ctrl+V，阻塞解除后表现为"一口气粘贴很多遍"。超过 10 秒
/// 视为上一次流程异常挂死，允许抢占重置。
pub static PASTE_IN_FLIGHT_SINCE: AtomicU64 = AtomicU64::new(0);
pub static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
pub static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DockPosition {
    None,
    Top,
    Left,
    Right,
}

pub static CURRENT_DOCK: AtomicI32 = AtomicI32::new(0); // 0: None, 1: Top, 2: Left, 3: Right
pub static IS_HIDDEN: AtomicBool = AtomicBool::new(false);
pub static IS_MOUSE_BUTTON_DOWN: AtomicBool = AtomicBool::new(false);
pub static NAVIGATION_ENABLED: AtomicBool = AtomicBool::new(false);
pub static NAVIGATION_MODE_ACTIVE: AtomicBool = AtomicBool::new(false);
pub static IS_MAIN_WINDOW_FOCUSED: AtomicBool = AtomicBool::new(false);
pub static IS_SEARCH_FOCUSED: AtomicBool = AtomicBool::new(false);
pub static LAST_GLOBAL_HOTKEY_TIMESTAMP: AtomicU64 = AtomicU64::new(0);
