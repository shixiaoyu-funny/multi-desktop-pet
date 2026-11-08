//! Win32 侧窗口探测：枚举可见的顶层窗口、读任务栏位置。
//!
//! 只做两件事：
//!  1. `list_windows` —— 拿到当前屏幕上"能被坐上去"的窗口列表（按 Z 序，最上层在前）
//!  2. `taskbar_top`  —— 拿到任务栏顶边的屏幕 y 坐标
//!
//! 判定口径（宁可漏，不可误）：
//!  · 必须可见、未最小化
//!  · 排除工具窗口（WS_EX_TOOLWINDOW）和 DWM 已 cloaked 的幽灵窗口
//!  · 排除桌面 / 任务栏 / 外壳自身的窗口类
//!  · 必须有标题（空标题的多是内部辅助窗口）
//!  · 尺寸至少 120×90，太小没法坐
//!
//! 坐标一律是**物理像素**的屏幕坐标，与 Tauri 的 PhysicalPosition 同一套。

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITOR_DEFAULTTONEAREST, MONITORINFO,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClassNameW, GetCursorPos, GetWindowLongW, GetWindowPlacement,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed,
    GWL_EXSTYLE, GWL_STYLE, SW_SHOWMAXIMIZED, WINDOWPLACEMENT, WS_EX_TOOLWINDOW, WS_MAXIMIZE,
};

/// 一个可被坐上去的顶层窗口
#[derive(Clone, Debug)]
pub struct WinRect {
    pub hwnd: isize,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    /// Z 序，0 表示最上层
    pub z: usize,
    /// 窗口标题（仅调试用，window_rect 里为空）
    pub title: String,
}

impl WinRect {
    pub fn width(&self) -> f64 {
        self.right - self.left
    }
    pub fn height(&self) -> f64 {
        self.bottom - self.top
    }
}

/// 这些窗口类不是"应用窗口"，坐上去会很怪，直接排除。
const SKIP_CLASSES: &[&str] = &[
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "TaskListThumbnailWnd",
    "ForegroundStaging",
    "MultitaskingViewFrame",
    "XamlExplorerHostIslandWindow",
    "Windows.Internal.Shell.TabProxyWindow",
];

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 窗口是否处于最大化状态。
///
/// 为什么必须排除最大化窗口：它的上沿就是屏幕顶部（Win10 的隐形边框还会把
/// 扩展边框顶到屏幕外一两像素）。桌宠坐上去后整个身子会跑到屏幕上方之外，
/// 视觉上等于"凭空消失"，所以最大化窗口一律不作为吸附目标。
unsafe fn is_maximized(hwnd: HWND) -> bool {
    max_probe(hwnd).0
}

/// 返回 (是否最大化, 诊断串)。诊断串只在调试/拒绝路径上用，正常路径不分配。
unsafe fn max_probe(hwnd: HWND) -> (bool, String) {
    // IsZoomed 是语义上的"是否最大化"，能正确处理 Electron / 自定义标题栏
    // 这类自己管理窗口状态的程序
    let zoomed = IsZoomed(hwnd) != 0;
    let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
    let style_bit = style & WS_MAXIMIZE != 0;
    // 有些无边框 / UWP 全屏窗口不带 WS_MAXIMIZE，再问 placement 兜底
    let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
    wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    let ok = GetWindowPlacement(hwnd, &mut wp);
    let show_cmd = if ok != 0 { wp.showCmd } else { u32::MAX };
    let placement_bit = ok != 0 && wp.showCmd == SW_SHOWMAXIMIZED as u32;
    (
        zoomed || style_bit || placement_bit,
        format!(
            "maximized(zoomed={},style={:#010x},styleBit={},showCmd={})",
            zoomed,
            style,
            style_bit,
            if show_cmd == u32::MAX {
                -1
            } else {
                show_cmd as i32
            }
        ),
    )
}

/// 枚举当前所有可坐的窗口，按 Z 序返回（最上层在前）。
///
/// `self_pid` 用来排除桌宠自己的进程；`self_hwnd` 排除自己的窗口。
pub fn list_windows(self_pid: u32, self_hwnd: isize) -> Vec<WinRect> {
    let mut out: Vec<WinRect> = Vec::new();
    let ctx = Ctx {
        pid: self_pid,
        hwnd: self_hwnd,
        out: &mut out as *mut Vec<WinRect>,
    };
    unsafe {
        EnumWindows(Some(enum_proc), &ctx as *const Ctx as LPARAM);
    }
    out
}

struct Ctx {
    pid: u32,
    hwnd: isize,
    out: *mut Vec<WinRect>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &*(lparam as *const Ctx);
    let out = &mut *ctx.out;
    if let Some(r) = probe(hwnd, out.len(), ctx.pid, ctx.hwnd) {
        out.push(r);
    }
    1
}

unsafe fn probe(hwnd: HWND, z: usize, self_pid: u32, self_hwnd: isize) -> Option<WinRect> {
    probe_inner(hwnd, z, self_pid, self_hwnd).ok()
}

/// 诊断用：返回 (标题, 是否通过, 拒绝原因)。用来排查"窗口列表为什么是空的"。
pub fn list_windows_debug(self_pid: u32, self_hwnd: isize) -> Vec<(String, bool, String)> {
    let mut out: Vec<(String, bool, String)> = Vec::new();
    let ctx = DebugCtx {
        pid: self_pid,
        hwnd: self_hwnd,
        out: &mut out as *mut Vec<(String, bool, String)>,
    };
    unsafe {
        EnumWindows(Some(enum_proc_debug), &ctx as *const DebugCtx as LPARAM);
    }
    out
}

struct DebugCtx {
    pid: u32,
    hwnd: isize,
    out: *mut Vec<(String, bool, String)>,
}

unsafe extern "system" fn enum_proc_debug(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &*(lparam as *const DebugCtx);
    let out = &mut *ctx.out;

    // 标题先取出来，任何过滤路径都能报出"是哪个窗口"
    let mut tbuf = [0u16; 512];
    let tn = GetWindowTextW(hwnd, tbuf.as_mut_ptr(), tbuf.len() as i32);
    let title = if tn > 0 {
        String::from_utf16_lossy(&tbuf[..tn as usize])
    } else {
        String::new()
    };

    match probe_inner(hwnd, out.len(), ctx.pid, ctx.hwnd) {
        Ok(_) => out.push((title, true, "通过".into())),
        Err(reason) => {
            // 没标题的内部窗口太多，只报有标题的，免得刷屏
            if !title.is_empty() {
                out.push((title, false, reason));
            }
        }
    }
    1
}

unsafe fn probe_inner(
    hwnd: HWND,
    z: usize,
    self_pid: u32,
    self_hwnd: isize,
) -> Result<WinRect, String> {
    if hwnd as isize == self_hwnd {
        return Err("is_self_hwnd".into());
    }
    if IsWindowVisible(hwnd) == 0 {
        return Err("not_visible".into());
    }
    if IsIconic(hwnd) != 0 {
        return Err("minimized".into());
    }
    let (maxed, max_detail) = max_probe(hwnd);
    if maxed {
        return Err(max_detail);
    }

    // 排除工具窗口
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW != 0 {
        return Err("tool_window".into());
    }

    // 排除自己的进程（多窗口时也能挡住）
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != 0 && pid == self_pid {
        return Err("self_pid".into());
    }

    // DWM cloaked：这些窗口虽然"可见"，实际并不显示（UWP 后台页常见）
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED as u32,
        &mut cloaked as *mut u32 as *mut core::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    ) == 0
        && cloaked != 0
    {
        return Err("dwm_cloaked".into());
    }

    // 窗口类过滤
    let mut cbuf = [0u16; 256];
    let cn = GetClassNameW(hwnd, cbuf.as_mut_ptr(), cbuf.len() as i32);
    if cn > 0 {
        let class = String::from_utf16_lossy(&cbuf[..cn as usize]);
        if SKIP_CLASSES.iter().any(|c| *c == class) {
            return Err("skip_class".into());
        }
    }

    // 必须有标题
    let mut tbuf = [0u16; 512];
    let tn = GetWindowTextW(hwnd, tbuf.as_mut_ptr(), tbuf.len() as i32);
    if tn <= 0 {
        return Err("no_title".into());
    }
    let title = String::from_utf16_lossy(&tbuf[..tn as usize]);
    // 两个桌宠窗口不能互相当作“可坐边”，否则移动一只会让另一只跟着掉。
    const PET_WINDOW_TITLES: &[&str] = &[
        "Raven pet",
        "Suki pet",
        "Raven 工具箱",
        "Suki 工具箱",
        "Raven · AI 聊天",
        "Suki · AI 聊天",
        "Raven · 配置 API Key",
        "Suki · 配置 API Key",
    ];
    if PET_WINDOW_TITLES.iter().any(|pet| *pet == title) {
        return Err("pet_window".into());
    }

    // 取可见边界：DWM 的 EXTENDED_FRAME_BOUNDS 不受 Win10 的隐形边框影响
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let dwm_ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS as u32,
        &mut r as *mut RECT as *mut core::ffi::c_void,
        std::mem::size_of::<RECT>() as u32,
    ) == 0;
    if !dwm_ok && GetWindowRect(hwnd, &mut r) == 0 {
        return Err("no_rect".into());
    }

    let w = (r.right - r.left) as f64;
    let h = (r.bottom - r.top) as f64;
    if w < 120.0 || h < 90.0 {
        return Err(format!("too_small({}x{})", w as i32, h as i32));
    }

    Ok(WinRect {
        hwnd: hwnd as isize,
        left: r.left as f64,
        top: r.top as f64,
        right: r.right as f64,
        bottom: r.bottom as f64,
        z,
        title,
    })
}

/// 单个窗口的当前矩形（坐上去之后每帧跟随用，比整轮枚举便宜得多）。
///
/// 宿主被最大化时返回 `None`：上沿已跑到屏幕顶之外，继续跟随只会让桌宠
/// 消失在屏幕上方。调用方会把它当作"宿主没了"，自然掉回任务栏。
pub fn window_rect(hwnd: isize) -> Option<WinRect> {
    unsafe {
        let h = hwnd as HWND;
        if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
            return None;
        }
        if is_maximized(h) {
            return None;
        }
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let dwm_ok = DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut r as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        ) == 0;
        if !dwm_ok && GetWindowRect(h, &mut r) == 0 {
            return None;
        }
        Some(WinRect {
            hwnd,
            left: r.left as f64,
            top: r.top as f64,
            right: r.right as f64,
            bottom: r.bottom as f64,
            z: 0,
            title: String::new(),
        })
    }
}

/// 任务栏顶边的屏幕 y 坐标（物理像素）。任务栏不在底部时返回靠近屏幕底部的边。
pub fn taskbar_top() -> Option<f64> {
    taskbar_rect().map(|r| r.top)
}

/// 当前光标位置（物理像素屏幕坐标）。
///
/// 轮询线程用它替代 Tauri 的 `cursor_position()`：后者会 `send_user_message` 后
/// 同步等主线程消息循环，每 tick 白等一轮；`GetCursorPos` 是纯 user32 调用，
/// 微秒级返回，不经过主线程。
pub fn cursor_pos() -> Option<(f64, f64)> {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut p) == 0 {
            return None;
        }
        Some((p.x as f64, p.y as f64))
    }
}

/// 某窗口的原始外接矩形 `(left, top, width, height)`（物理像素）。
///
/// 比 `window_rect` 轻得多：不查可见/最小化/最大化/cloaked，不分配标题字符串，
/// 专供轮询线程高频读**自己窗口**的几何（它永远可见、永不最大化）。
pub fn raw_rect(hwnd: isize) -> Option<(f64, f64, f64, f64)> {
    unsafe {
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(hwnd as HWND, &mut r) == 0 {
            return None;
        }
        Some((
            r.left as f64,
            r.top as f64,
            (r.right - r.left) as f64,
            (r.bottom - r.top) as f64,
        ))
    }
}


/// 某点所在显示器的 `(left, top, right, bottom)`（物理像素）。
///
/// 直接走 `MonitorFromPoint`：Tauri 的 `available_monitors()` 会
/// `send_user_message` 到主线程同步等消息循环，在 60Hz 的轮询里等于每帧白等一次，
/// 拖拽时会明显发涩。
pub fn monitor_bounds(x: f64, y: f64) -> (f64, f64, f64, f64) {
    unsafe {
        let pt = POINT {
            x: x.round() as i32,
            y: y.round() as i32,
        };
        // 点落在显示器外时给"最近的显示器"，和 Tauri 的语义一致
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if !hmon.is_null() {
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(hmon, &mut mi) != 0 {
                let r = mi.rcMonitor;
                return (
                    r.left as f64,
                    r.top as f64,
                    r.right as f64,
                    r.bottom as f64,
                );
            }
        }
        (0.0, 0.0, 1920.0, 1080.0)
    }
}

/// 任务栏的完整矩形（调试用）
pub fn taskbar_rect() -> Option<WinRect> {
    let cls = wide("Shell_TrayWnd");
    unsafe {
        let h = FindWindowW(cls.as_ptr(), std::ptr::null());
        if h.is_null() {
            return None;
        }
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(h, &mut r) == 0 {
            return None;
        }
        Some(WinRect {
            hwnd: h as isize,
            left: r.left as f64,
            top: r.top as f64,
            right: r.right as f64,
            bottom: r.bottom as f64,
            z: 0,
            title: "taskbar".into(),
        })
    }
}

/// 当前进程 id
pub fn current_pid() -> u32 {
    std::process::id()
}
