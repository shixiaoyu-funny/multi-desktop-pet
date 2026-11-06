//! 开发用小工具：打印当前可被坐上去的窗口列表和任务栏位置。
//!
//! 只用来验证 `win` 模块的 Win32 探测是否正常，不参与桌宠运行。
//!
//!   cargo run --bin winscan
//!
//! 注意：这里必须先把进程 DPI 感知设成和 Tauri 一致（per-monitor v2），
//! 否则 Windows 会把坐标虚拟化，量出来的数字和桌宠里的对不上。

use role2_pet_lib::win;
use windows_sys::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

fn main() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    println!("--- 任务栏 ---");
    match win::taskbar_rect() {
        Some(r) => println!(
            "rect = left {:.0} top {:.0} right {:.0} bottom {:.0}  (高 {:.0})",
            r.left,
            r.top,
            r.right,
            r.bottom,
            r.height()
        ),
        None => println!("没找到任务栏 (Shell_TrayWnd)"),
    }
    println!("taskbar_top() = {:?}", win::taskbar_top());

    println!();
    println!("--- 可坐窗口（Z 序，最上层在前） ---");
    let wins = win::list_windows(win::current_pid(), 0);
    println!("共 {} 个", wins.len());
    for w in &wins {
        println!(
            "z={:<2} hwnd={:<10} top={:<8.0} left={:<8.0} size={:.0}x{:.0}  {}",
            w.z,
            w.hwnd,
            w.top,
            w.left,
            w.width(),
            w.height(),
            w.title
        );
    }
}
