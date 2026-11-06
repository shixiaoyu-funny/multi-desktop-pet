//! role2 透明 WebM 桌宠 —— Tauri 2 主逻辑
//!
//! 与 Electron 版的差别只在"谁来驱动窗口"：
//!  · 透明窗口固定 1024×1024，永不 resize；大小档位靠窗口内 CSS 缩放视频实现
//!  · 拖拽 / 点击穿透 / 边界夹紧 全部搬到 Rust 侧，拖拽/下落 16ms、其余 80ms 轮询光标
//!  · 命中判定用前端算好的 192×192 alpha 掩膜（DPI 无关，按窗口比例采样）
//!
//! 为什么不用 WebView 自己判断 hover：
//! Tauri/Windows 的 `set_ignore_cursor_events(true)` 没有 Electron 的 forward 参数，
//! 穿透之后 WebView 收不到 mousemove。所以只能由 Rust 用全局光标位置反推。
//!
//! 姿态与"坐边边"：
//!  窗口永远是 1024×1024，但角色只占其中 68% 高、接地线在 86.1%。
//!  所以真正要对齐到窗口边缘的不是窗口矩形，而是**接触点**：
//!      contactY = winTop + (C·(1-s))/2 + 0.861·C·s
//!  s 是当前动作的显示缩放（站姿 1、坐姿 0.88）。前端在切动作时把这个 s
//!  和接地线比例通过 `set_contact` 告诉 Rust，Rust 才知道该把哪儿贴到边上。

pub mod win;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewWindow};

const CONTAINER_PX: f64 = 1024.0; // 容器边长（物理像素！），窗口永远按这个算
const MASK_N: usize = 192; // 前端掩膜分辨率
/// 拖拽 / 重力下落 / 宿主移动时的轮询间隔：要平滑，保持 60Hz
const DRAG_TICK_MS: u64 = 16;
/// 自由停留 / 宿主静止时的轮询间隔：12.5Hz 足够
const IDLE_TICK_MS: u64 = 80;
/// 宿主连续多少轮位置不变，才把"坐在边上"的轮询降到空闲档。
/// 10 轮 ≈ 160ms：既能扛过慢拖时的短暂停顿，又不会在拖影之后还空转太久。
const PERCH_STILL_TICKS: u32 = 10;
/// 宿主查询连续失败多少轮才判定"真的没了"。单轮读不到（DWM 瞬时抖动、
/// 窗口正处于移动/重绘）不算，避免坐在边上时莫名掉下去。
const PERCH_LOST_TICKS: u32 = 4;

/// 吸附半径（逻辑像素，运行时乘 DPI 缩放）。
/// 80 是实测比较舒服的"随手一放就贴上"的范围：太小要精准对准，太大会把
/// 还没想放的地方也吸住。
const SNAP_PX: f64 = 80.0;
/// 视频里角色的接地线位置（三个动作实测都是 86.1%）
const GROUND_RATIO: f64 = 0.861;
/// 视频里角色占画面的高度比例（站姿 68%，坐姿略小，这里取站姿值做估算）
const CHAR_H_RATIO: f64 = 0.68;
/// 像素/米：容器 1024 像素对应角色 68%（约 1.6m 的人），约 435 px/m
const PX_PER_M: f64 = 435.0;
const GRAVITY: f64 = 9.8 * PX_PER_M;
const MAX_FALL_SPEED: f64 = 4200.0;
const RESTITUTION: f64 = 0.22;
/// 落地反弹的最低速度，低于它就停住
const BOUNCE_MIN: f64 = 260.0;

// ————————————————————————— 配置 —————————————————————————

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cfg {
    pub size: String,
    pub cx: Option<f64>,
    pub cy: Option<f64>,
    pub always_on_top: bool,
    pub random: bool,
    pub interval: u32,
    pub action: String,
    /// 坐在窗口边缘 / 任务栏上
    #[serde(default)]
    pub snap: bool,
    /// 重力掉落（snap 开启时强制关闭）
    #[serde(default)]
    pub gravity: bool,
}

impl Default for Cfg {
    fn default() -> Self {
        Self {
            size: "medium".into(),
            cx: None,
            cy: None,
            always_on_top: true,
            random: false,
            interval: 20,
            action: "stand_idle".into(),
            snap: false,
            gravity: false,
        }
    }
}

// ————————————————————————— 姿态 / 物理状态 —————————————————————————

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    /// 自由停留（不在拖、不在坐、不在掉）
    Free,
    /// 鼠标拖拽中
    Drag,
    /// 坐在窗口边缘或任务栏上
    Perched,
    /// 重力下落中
    Falling,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum PerchKind {
    Window,
    Taskbar,
}

#[derive(Clone, Debug)]
struct Perch {
    hwnd: isize,
    kind: PerchKind,
    /// 接触点相对宿主窗口左边缘的偏移，用来实现"窗口拖动时跟着平移"
    offset_x: f64,
}

/// 下落途中可坐上去的窗口上边缘（已过滤最大化、水平范围、头顶空间）。
/// 与任务栏上沿一起构成"落地候选边"，下落时谁先被碰到就坐谁。
#[derive(Clone, Debug)]
struct WinTop {
    hwnd: isize,
    /// 上边缘的屏幕 y（物理像素）
    top: f64,
    /// 窗口左边缘（算 offset_x 用）
    left: f64,
}

// ————————————————————————— 掩膜 —————————————————————————

struct Mask {
    w: usize,
    h: usize,
    data: Vec<u8>,
}

impl Mask {
    /// 归一化坐标（0..1）是否命中角色像素；四周放宽 1 格，好抓
    fn hit(&self, rx: f64, ry: f64) -> bool {
        if rx < 0.0 || rx >= 1.0 || ry < 0.0 || ry >= 1.0 {
            return false;
        }
        let gx = (rx * self.w as f64) as isize;
        let gy = (ry * self.h as f64) as isize;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let x = gx + dx;
                let y = gy + dy;
                if x < 0 || y < 0 || x >= self.w as isize || y >= self.h as isize {
                    continue;
                }
                if self.data[y as usize * self.w + x as usize] != 0 {
                    return true;
                }
            }
        }
        false
    }
}

// ————————————————————————— 共享状态 —————————————————————————

struct Pet {
    cfg: Cfg,
    cfg_path: PathBuf,
    mask: Option<Mask>,
    dragging: bool,
    drag_off: (f64, f64), // 光标相对窗口左上角的偏移（物理像素）
    menu_open: bool,
    ignoring: bool, // 当前是否处于"穿透"状态

    mode: Mode,
    vy: f64,
    perch: Option<Perch>,
    /// 接触点距窗口顶部的**物理像素**偏移，以及角色在屏幕上的实际高度。
    /// 这两个值由前端按视频元素真实布局算好送过来 —— 因为显示尺寸随档位变化，
    /// Rust 这边自己按容器 1024 推会算错（512 档位下能差 185px）。
    contact_off: f64,
    char_h: f64,
    /// 当前 DPI 缩放，用于把 SNAP_PX 换成本地像素
    dpi: f64,
    last_tick: Instant,
    /// 上次发给前端的姿态，避免重复 emit
    last_sit: Option<bool>,
    /// 上次真正 SetWindowPos 的窗口左上角，位置没变就不再重复设置
    applied: Option<(f64, f64)>,
    /// 上次看到的宿主接触点，用来判断宿主是否在移动（决定"坐在边上"时的轮询档位）
    perch_last: Option<(f64, f64)>,
    /// 宿主连续位置不变的轮数，攒够 PERCH_STILL_TICKS 就降到空闲档
    perch_still: u32,
    /// 宿主连续查询失败（关闭/最小化/最大化/短暂读不到）的轮数。
    /// 单轮失败不立刻掉落，攒够 PERCH_LOST_TICKS 才认为宿主真的没了 ——
    /// 否则 DWM/窗口状态瞬时抖动会让桌宠"坐 0.2 秒又掉下去"。
    perch_lost: u32,
    /// 「支撑被抽走」导致的下落：`(宿主 hwnd, 接触点相对左边缘的偏移)`。
    /// 有它时下落过程仍然跟着宿主横向平移（人是踩着边掉下去的，不是原地直坠）；
    /// 真正的自由落体（窗口被关掉、支撑范围不在了）这里为 None。
    fall_follow: Option<(isize, f64)>,
}

/// 默认档位（medium 512）、站姿缩放下的默认接触点（前端还没同步过时用）
const DEFAULT_OFF_Y: f64 = (CONTAINER_PX - 512.0) / 2.0 + GROUND_RATIO * 512.0;
const DEFAULT_CHAR_H: f64 = CHAR_H_RATIO * 512.0;

impl Pet {
    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.cfg) {
            let _ = fs::write(&self.cfg_path, s);
        }
    }

    /// 接触点距窗口顶部的偏移
    fn contact_off_y(&self) -> f64 {
        self.contact_off
    }

    /// 角色在屏幕上的实际高度（用于判断"头顶会不会出屏幕"）
    fn char_px(&self) -> f64 {
        self.char_h
    }

    /// 记位置。配置里的 cx/cy 语义是**窗口中心**，而吸附算出来的是接触点，
    /// 两者差一个 off_y，不换算的话下次启动会按接触点当中心摆，位置就偏了。
    fn store_center(&mut self, cx: f64, cy_contact: f64) {
        self.cfg.cx = Some(cx);
        self.cfg.cy = Some(cy_contact - self.contact_off_y() + CONTAINER_PX / 2.0);
    }

    fn snap_radius(&self) -> f64 {
        SNAP_PX * self.dpi
    }
}

type Shared = Arc<Mutex<Pet>>;

/// 只在姿态真正变化时返回要广播的姿态。**不发事件**——事件必须在锁外发。
fn take_posture(pet: &mut Pet, sit: bool) -> Option<bool> {
    if pet.last_sit == Some(sit) {
        return None;
    }
    pet.last_sit = Some(sit);
    Some(sit)
}

/// 用当前光标 + 掩膜决定窗口是否该穿透。**只在锁内调用，纯内存运算。**
///
/// 这是"能否抓住桌宠"的唯一边界：光标落在角色像素上 → 窗口可交互（可拖拽），
/// 否则穿透。所有模式（Free / Perched）都必须走这里，否则就会像"坐在任务栏上
/// 却整窗可点"那样，把 1024×1024 的透明容器整个变成可点击区域。
fn update_ignore(
    pet: &mut Pet,
    cursor: (f64, f64),
    wpos: (f64, f64),
    wsize: (f64, f64),
    plan: &mut Plan,
) {
    let rx = (cursor.0 - wpos.0) / wsize.0;
    let ry = (cursor.1 - wpos.1) / wsize.1;
    let on_pet = match &pet.mask {
        Some(m) => m.hit(rx, ry),
        // 掩膜未就绪（视频还没解码出来）→ 宁可穿透，也不把整窗当可点击陷阱
        None => false,
    };
    let want_ignore = !(on_pet || pet.menu_open);
    if want_ignore != pet.ignoring {
        pet.ignoring = want_ignore;
        plan.ignore = Some(want_ignore);
    }
}

// ————————————————————————— 显示器工具 —————————————————————————

/// 点所在的显示器边界（物理像素）。直接问 Win32，不走 Tauri 主线程。
fn monitor_bounds(x: f64, y: f64) -> (f64, f64, f64, f64) {
    win::monitor_bounds(x, y)
}

/// 容器中心点夹进屏幕四边之内 —— 允许半个桌宠探出屏幕外
fn clamp_center(cx: f64, cy: f64) -> (f64, f64) {
    let (x0, y0, x1, y1) = monitor_bounds(cx, cy);
    (cx.clamp(x0, x1), cy.clamp(y0, y1))
}

fn container_px(_win: &WebviewWindow) -> f64 {
    // 容器恒为 1024 物理像素，与系统缩放解耦
    CONTAINER_PX
}

/// 按容器中心摆窗口
fn place(win: &WebviewWindow, cx: f64, cy: f64) {
    let (cx, cy) = clamp_center(cx, cy);
    let half = container_px(win) / 2.0;
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(
        (cx - half).round() as i32,
        (cy - half).round() as i32,
    )));
}

// ————————————————————————— 吸附目标 —————————————————————————

/// 松开鼠标时找一个可以坐上去的边。
///
/// 规则：
///  · 任务栏上沿永远可坐
///  · 应用窗口看它的上边缘，接触点落在窗口水平范围内、垂直差 ≤ 吸附半径
///  · **头顶必须留得下**：如果坐上去角色脑袋会跑出屏幕顶部，就跳过这个目标
///    （容器有 18% 的头顶留白，但角色本体 68% 高，屏幕靠上的窄窗口坐不下就是坐不下）
fn find_snap(cx: f64, cy: f64, radius: f64, char_h: f64) -> Option<Perch> {
    let r = radius;
    let (_, mon_top, _, _) = monitor_bounds(cx, cy);
    // 坐上去之后她的头顶在 contactY - charH。头顶出屏幕就是被切掉，
    // 这种目标直接跳过，宁可这次不吸附，也不坐上去半个脑袋没了。
    let headroom = char_h + 4.0;

    let mut best: Option<(f64, Perch)> = None;

    // 任务栏
    if let Some(tb) = win::taskbar_top() {
        let d = (cy - tb).abs();
        if d <= r {
            best = Some((
                d,
                Perch {
                    hwnd: 0,
                    kind: PerchKind::Taskbar,
                    offset_x: cx,
                },
            ));
        }
    }

    // 应用窗口（枚举顺序就是 Z 序，最上层在前）
    let wins = win::list_windows(win::current_pid(), 0);
    for w in wins {
        if cx < w.left + 8.0 || cx > w.right - 8.0 {
            continue;
        }
        let d = (cy - w.top).abs();
        if d > r {
            continue;
        }
        // 头顶空间不够就别坐
        if w.top < mon_top + headroom {
            continue;
        }
        let better = match &best {
            None => true,
            Some((bd, bp)) => {
                // 距离优先；距离相同则偏好窗口（可以跟着窗口一起拖）
                d < *bd - 0.5 || ((d - *bd).abs() <= 0.5 && bp.kind == PerchKind::Taskbar)
            }
        };
        if better {
            best = Some((
                d,
                Perch {
                    hwnd: w.hwnd,
                    kind: PerchKind::Window,
                    offset_x: cx - w.left,
                },
            ));
        }
    }

    best.map(|(_, p)| p)
}

// ————————————————————————— 命令 —————————————————————————

#[tauri::command]
fn bootstrap(state: tauri::State<'_, Shared>) -> serde_json::Value {
    let pet = state.lock().unwrap();
    serde_json::json!({
        "cfg": pet.cfg,
        "container": CONTAINER_PX,
        "maskN": MASK_N,
        "groundRatio": GROUND_RATIO,
        "ground": GROUND_RATIO,
    })
}

#[tauri::command]
fn save_cfg(patch: serde_json::Value, state: tauri::State<'_, Shared>) -> serde_json::Value {
    let mut pet = state.lock().unwrap();
    if let Some(o) = patch.as_object() {
        if let Some(v) = o.get("size").and_then(|v| v.as_str()) {
            pet.cfg.size = v.to_string();
        }
        if let Some(v) = o.get("action").and_then(|v| v.as_str()) {
            pet.cfg.action = v.to_string();
        }
        if let Some(v) = o.get("alwaysOnTop").and_then(|v| v.as_bool()) {
            pet.cfg.always_on_top = v;
        }
        if let Some(v) = o.get("random").and_then(|v| v.as_bool()) {
            pet.cfg.random = v;
        }
        if let Some(v) = o.get("interval").and_then(|v| v.as_u64()) {
            pet.cfg.interval = v as u32;
        }
        if let Some(v) = o.get("snap").and_then(|v| v.as_bool()) {
            pet.cfg.snap = v;
            // 吸附和重力互斥：开吸附就关重力
            if v {
                pet.cfg.gravity = false;
            }
            // 注意：这里**不能**把 Perched 直接改成 Free。Free 模式下轮询只做命中判定，
            // 不再跟宿主，位置就永久冻住了（表现为"坐在窗口上却怎么拖窗口都不动"）。
            // 关掉吸附只影响下一次松手，已经坐着的继续坐着。
        }
        if let Some(v) = o.get("gravity").and_then(|v| v.as_bool()) {
            // 吸附开着时不允许开重力
            pet.cfg.gravity = if pet.cfg.snap { false } else { v };
        }
    }
    pet.save();
    serde_json::to_value(&pet.cfg).unwrap_or(serde_json::Value::Null)
}

/// 前端算好的 alpha 掩膜（0/1，长度 = w*h）
#[tauri::command]
fn set_mask(w: usize, h: usize, data: Vec<u8>, state: tauri::State<'_, Shared>) {
    let mut pet = state.lock().unwrap();
    if w == 0 || h == 0 || data.len() != w * h {
        pet.mask = None;
        return;
    }
    pet.mask = Some(Mask { w, h, data });
}

/// 前端切动作 / 改档位 / 调缩放 / 换坐姿时同步接触点几何。
///
/// `off_y`  = 视频里角色的接地线距窗口顶部的物理像素距离
/// `char_h` = 角色在屏幕上的实际高度（物理像素）
///
/// 由前端用 getBoundingClientRect() 直接量，最可靠：
/// 显示尺寸 = 档位物理像素 × 动作缩放，Rust 侧无法独立推出。
#[tauri::command]
fn set_contact(off_y: f64, char_h: f64, state: tauri::State<'_, Shared>) {
    let mut pet = state.lock().unwrap();
    pet.contact_off = off_y.clamp(0.0, CONTAINER_PX * 2.0);
    pet.char_h = char_h.clamp(16.0, CONTAINER_PX * 2.0);
}

#[tauri::command]
fn set_menu_open(open: bool, state: tauri::State<'_, Shared>) {
    let mut pet = state.lock().unwrap();
    pet.menu_open = open;
}

#[tauri::command]
fn get_debug(state: tauri::State<'_, Shared>) -> serde_json::Value {
    let snap = {
        let pet = match state.lock() {
            Ok(g) => g,
            Err(_) => return serde_json::Value::Null,
        };
        serde_json::json!({
            "mode": format!("{:?}", pet.mode),
            "snap": pet.cfg.snap,
            "gravity": pet.cfg.gravity,
            "snapRadius": pet.snap_radius(),
            "contact": { "offY": pet.contact_off, "charH": pet.char_h },
            "perch": pet.perch.as_ref().map(|p| serde_json::json!({
                "hwnd": p.hwnd,
                "kind": format!("{:?}", p.kind),
                "offsetX": p.offset_x,
            })),
        })
    };

    let mut out = snap;
    if let Some(o) = out.as_object_mut() {
        o.insert("taskbarTop".into(), serde_json::json!(win::taskbar_top()));
        o.insert(
            "windows".into(),
            serde_json::json!(win::list_windows(win::current_pid(), 0)
                .into_iter()
                .take(12)
                .map(|w| serde_json::json!({
                    "hwnd": w.hwnd, "z": w.z, "top": w.top, "left": w.left,
                    "right": w.right, "bottom": w.bottom, "title": w.title,
                }))
                .collect::<Vec<_>>()),
        );
        // 每个候选窗口被接受/拒绝的原因，排查吸附失效用
        o.insert(
            "probe".into(),
            serde_json::json!(win::list_windows_debug(win::current_pid(), 0)
                .into_iter()
                .map(|(title, ok, reason)| serde_json::json!({
                    "title": title, "ok": ok, "reason": reason,
                }))
                .collect::<Vec<_>>()),
        );
    }
    out
}

#[tauri::command]
fn start_drag(win: WebviewWindow, state: tauri::State<'_, Shared>) {
    // 窗口 API 必须在锁外调用，否则会和主线程上的其他 command 互锁
    let Some(cursor) = win.cursor_position().ok() else {
        return;
    };
    let Some(pos) = win.outer_position().ok() else {
        return;
    };
    let mut pet = state.lock().unwrap();
    pet.dragging = true;
    pet.mode = Mode::Drag;
    pet.perch = None;
    pet.vy = 0.0;
    pet.drag_off = (cursor.x - pos.x as f64, cursor.y - pos.y as f64);
    // 被拎起来 = 站起来
    pet.last_sit = None;
}

#[tauri::command]
fn end_drag(win: WebviewWindow, app: AppHandle, state: tauri::State<'_, Shared>) {
    // ——— 锁外：先把需要的窗口几何拿到 ———
    let outer = win.outer_position().ok();

    // ——— 锁内：只更新状态，不碰窗口 ———
    let (off_y, cx, cy, snap_on, gravity_on) = {
        let mut pet = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if !pet.dragging {
            return;
        }
        pet.dragging = false;
        pet.save();
        let off_y = pet.contact_off_y();
        let Some(p) = outer else {
            pet.mode = Mode::Free;
            pet.last_sit = None;
            return;
        };
        (
            off_y,
            p.x as f64 + CONTAINER_PX / 2.0,
            p.y as f64 + off_y,
            pet.cfg.snap,
            pet.cfg.gravity,
        )
    }; // ← 锁在这里释放

    // ——— 锁外：找吸附目标（EnumWindows 属于窗口 API，不能持锁） ———
    let perch = if snap_on {
        let (radius, char_h) = {
            let pet = match state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            (pet.snap_radius(), pet.char_px())
        };
        find_snap(cx, cy, radius, char_h)
    } else {
        None
    };

    // 目标矩形也在锁外查
    let target = perch.as_ref().and_then(|p| match p.kind {
        PerchKind::Taskbar => win::taskbar_top().map(|t| (p.offset_x, t)),
        PerchKind::Window => {
            win::window_rect(p.hwnd).map(|r| (r.left + p.offset_x, r.top))
        }
    });

    let sit: Option<bool>;

    if let (Some(p), Some((tx, ty))) = (perch, target) {
        // 立刻贴上去，别等下一帧 —— set_position 在锁外
        let left = tx - CONTAINER_PX / 2.0;
        let top = ty - off_y;
        let _ = win.set_position(Position::Physical(PhysicalPosition::new(
            left.round() as i32,
            top.round() as i32,
        )));
        let mut pet = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        pet.store_center(tx, ty);
        pet.applied = Some((left, top));
        pet.perch = Some(p);
        pet.perch_last = None;
        pet.perch_still = 0;
        pet.mode = Mode::Perched;
        pet.vy = 0.0;
        sit = take_posture(&mut pet, true);
    } else if gravity_on {
        // 从松手这一刻就开始掉，并且立刻切成坐姿
        let mut pet = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        pet.mode = Mode::Falling;
        pet.perch = None;
        pet.vy = 0.0;
        pet.applied = None;
        sit = take_posture(&mut pet, true);
    } else {
        let mut pet = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        pet.mode = Mode::Free;
        pet.applied = None;
        sit = take_posture(&mut pet, false);
    }

    // 锁外发事件
    if let Some(s) = sit {
        let _ = app.emit("pet:posture", serde_json::json!({ "sit": s }));
    }
}

#[tauri::command]
fn set_always_on_top(on: bool, win: WebviewWindow, state: tauri::State<'_, Shared>) {
    let _ = win.set_always_on_top(on);
    let mut pet = state.lock().unwrap();
    pet.cfg.always_on_top = on;
    pet.save();
}

#[tauri::command]
fn quit_app(app: AppHandle, state: tauri::State<'_, Shared>) {
    state.lock().unwrap().save();
    app.exit(0);
}

// ————————————————————————— 工具箱窗口 / 托盘 —————————————————————————

const TOOLBOX_LABEL: &str = "toolbox";
const TOOLBOX_W: f64 = 600.0;
const TOOLBOX_H: f64 = 400.0;

/// 打开（或唤到前面）工具箱窗口。
/// 窗口关掉就是销毁，所以这里"有就显示、没有才创建"——不常驻，省一份 WebView2 内存。
fn show_toolbox(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(TOOLBOX_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let built = tauri::WebviewWindowBuilder::new(
        app,
        TOOLBOX_LABEL,
        tauri::WebviewUrl::App("toolbox.html".into()),
    )
    .title("role2 工具箱")
    .inner_size(TOOLBOX_W, TOOLBOX_H)
    .min_inner_size(480.0, 320.0)
    .resizable(true)
    .center()
    .focused(true)
    .build();

    if let Err(e) = built {
        eprintln!("[pet] 工具箱窗口创建失败: {e}");
    }
}

/// 右键桌宠时调用：打开工具箱。
///
/// **必须是 async**：同步 command 跑在主线程上，而创建 webview 窗口需要主线程
/// 处理消息 —— 在主线程里同步等它，就是和自己互等，整个应用会卡死（连
/// assets 协议都跟着停摆）。async command 走 runtime 线程池，就不会自锁。
#[tauri::command]
async fn open_toolbox(app: AppHandle) {
    show_toolbox(&app);
}

/// 托盘图标：左/右键都能弹出菜单，只有「打开工具箱窗口」「退出」两项
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open_toolbox", "打开工具箱窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit_tray", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id("pet-tray")
        .tooltip("role2 桌宠")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_toolbox" => {
                // 托盘回调也在主线程上跑，同样不能同步建窗口：丢到独立线程去做
                let app = app.clone();
                std::thread::spawn(move || show_toolbox(&app));
            }
            "quit_tray" => {
                // 退出前尽量落盘一次；拿不到锁（轮询正在写）就直接退，不阻塞
                if let Some(st) = app.try_state::<Shared>() {
                    if let Ok(pet) = st.try_lock() {
                        pet.save();
                    }
                }
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ————————————————————————— 轮询线程 —————————————————————————

/// 一轮轮询要执行的动作。**锁内只填这个结构，锁外才真的动窗口。**
///
/// 为什么必须分开：Tauri 2 的同步 command 跑在主线程上，而 `set_position`
/// 会同步派发窗口消息、等主线程处理。如果持着锁去调窗口 API，就会和主线程上
/// 正在抢这把锁的 command（set_mask / set_contact 等）互相等待 —— 死锁，
/// 表现就是窗口"未响应"。
#[derive(Default)]
struct Plan {
    /// 要设置的窗口左上角（物理像素）
    pos: Option<(f64, f64)>,
    /// 要设置的穿盘状态
    ignore: Option<bool>,
    /// 要广播的姿态（true = 坐下）
    posture: Option<bool>,
    /// 重力掉落坐稳在**任务栏**上：通知前端播「正坐慌张挥手」落地反应
    panic: bool,
}

/// 轮询第一阶段（锁内）产出的"这轮要查什么"。
/// 只含纯数据，绝不携带任何系统/窗口调用。
enum PollNeed {
    /// 命中判定 / 空闲：纯内存，无需查询
    Idle,
    /// 拖拽：需要把中心点夹进当前显示器
    Drag { cx: f64, cy: f64 },
    /// 坐在边上：需要查宿主矩形 / 任务栏上沿
    Perch {
        hwnd: isize,
        kind: PerchKind,
        offset_x: f64,
    },
    /// 重力下落：需要显示器四边 + 任务栏上沿 + 可坐的窗口上边缘
    Fall {
        cx: f64,
        cy: f64,
        char_h: f64,
        /// 支撑被抽走时仍要跟着宿主横向平移（踩着边往下掉），`(hwnd, offset_x)`
        follow: Option<(isize, f64)>,
    },
}

/// 轮询第二阶段（锁外）查到的系统信息，供第三阶段（锁内）决策。
enum PollSys {
    None,
    /// 夹点后的窗口中心
    Center((f64, f64)),
    /// 宿主接触点 + 可夹的水平范围（任务栏无范围）
    PerchPos {
        tx: f64,
        ty: f64,
        span: Option<(f64, f64)>,
    },
    /// 宿主被关掉或最小化
    PerchGone,
    /// 下落边界 + 可落窗口上边缘
    FallBounds {
        lx: f64,
        rx: f64,
        ground_y: f64,
        win_tops: Vec<WinTop>,
    },
}

/// 第一阶段锁内的状态快照，第三阶段用它在决策前校验"期间状态没被 command 改过"。
struct PollSnap {
    mode: Mode,
    dragging: bool,
    perch_hwnd: Option<isize>,
    need: PollNeed,
}

fn spawn_poller(app: AppHandle, shared: Shared, self_hwnd: isize) {
    std::thread::spawn(move || {
        let mut tick = IDLE_TICK_MS;
        loop {
            std::thread::sleep(Duration::from_millis(tick));

            let Some(win) = app.get_webview_window("pet") else {
                tick = IDLE_TICK_MS;
                continue;
            };
            // 锁外：窗口几何。直接 Win32，不走 Tauri 主线程 —— 原来的三个
            // cursor_position / outer_position / outer_size 都是 send_user_message 后
            // 同步等主线程消息循环，每 tick 白等三轮；GetCursorPos / GetWindowRect
            // 是纯 user32 调用，微秒级返回。
            let (Some(cursor), Some((wx, wy, ww, wh))) =
                (win::cursor_pos(), win::raw_rect(self_hwnd))
            else {
                tick = IDLE_TICK_MS;
                continue;
            };
            let wpos = (wx, wy);
            let wsize = (ww, wh);

            // ——— 阶段1：锁内只读快照，产出"要查什么"（纯内存，无任何系统/窗口调用） ———
            let (snap, dt) = {
                let mut pet = match shared.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        tick = IDLE_TICK_MS;
                        continue;
                    }
                };
                let now = Instant::now();
                let dt = now
                    .duration_since(pet.last_tick)
                    .as_secs_f64()
                    // 空闲节拍 80ms 下单步会更大，上限放宽到 0.09，否则下落积分被截断
                    .clamp(0.001, 0.09);
                pet.last_tick = now;

                let need = if pet.dragging {
                    let (ox, oy) = pet.drag_off;
                    PollNeed::Drag {
                        cx: cursor.0 - ox + wsize.0 / 2.0,
                        cy: cursor.1 - oy + wsize.1 / 2.0,
                    }
                } else if pet.mode == Mode::Perched {
                    match pet.perch.clone() {
                        Some(p) => PollNeed::Perch {
                            hwnd: p.hwnd,
                            kind: p.kind,
                            offset_x: p.offset_x,
                        },
                        None => PollNeed::Idle,
                    }
                } else if pet.mode == Mode::Falling {
                    PollNeed::Fall {
                        cx: wpos.0 + CONTAINER_PX / 2.0,
                        cy: wpos.1 + pet.contact_off_y(),
                        char_h: pet.char_h,
                        follow: pet.fall_follow,
                    }
                } else {
                    PollNeed::Idle
                };

                let snap = PollSnap {
                    mode: pet.mode,
                    dragging: pet.dragging,
                    perch_hwnd: pet.perch.as_ref().map(|p| p.hwnd),
                    need,
                };
                (snap, dt)
            }; // ← 锁释放

            // ——— 阶段2：锁外查系统信息 ———
            let sys = match snap.need {
                PollNeed::Idle => PollSys::None,
                PollNeed::Drag { cx, cy } => PollSys::Center(clamp_center(cx, cy)),
                PollNeed::Perch {
                    hwnd,
                    kind,
                    offset_x,
                } => {
                    let pos = match kind {
                        PerchKind::Taskbar => win::taskbar_top().map(|t| (offset_x, t, None)),
                        PerchKind::Window => win::window_rect(hwnd)
                            .map(|r| (r.left + offset_x, r.top, Some((r.left, r.right)))),
                    };
                    match pos {
                        Some((tx, ty, span)) => PollSys::PerchPos { tx, ty, span },
                        None => PollSys::PerchGone,
                    }
                }
                PollNeed::Fall {
                    cx,
                    cy,
                    char_h,
                    follow,
                } => {
                    let (lx, mon_top, rx, lb) = monitor_bounds(cx, cy);
                    let ground_y = win::taskbar_top().unwrap_or(lb);
                    // 支撑被抽走的那种下落：横向继续跟着宿主，别原地直坠
                    // （人是从平台上滑下去的，不是脱钩自由落体）
                    let cx = match follow {
                        Some((hwnd, off)) => match win::window_rect(hwnd) {
                            Some(r) => {
                                let lo = r.left + 8.0;
                                let hi = (r.right - 8.0).max(lo);
                                (r.left + off).max(lo).min(hi)
                            }
                            None => cx,
                        },
                        None => cx,
                    };
                    // 可落窗口上边缘：接触点落在窗口水平范围内、头顶留得下才算。
                    // 头顶空间不够（坐上去脑袋出屏幕顶）就跳过，宁可落到任务栏。
                    let headroom = char_h + 4.0;
                    let mut win_tops: Vec<WinTop> = Vec::new();
                    for w in win::list_windows(win::current_pid(), 0) {
                        if cx < w.left + 8.0 || cx > w.right - 8.0 {
                            continue;
                        }
                        if w.top < mon_top + headroom {
                            continue;
                        }
                        win_tops.push(WinTop {
                            hwnd: w.hwnd,
                            top: w.top,
                            left: w.left,
                        });
                    }
                    // 按上边缘 y 升序：下落时先碰到最靠上的那条边
                    win_tops.sort_by(|a, b| a.top.partial_cmp(&b.top).unwrap_or(std::cmp::Ordering::Equal));
                    PollSys::FallBounds {
                        lx,
                        rx,
                        ground_y,
                        win_tops,
                    }
                }
            };

            // ——— 阶段3：锁内决策（仍无任何系统/窗口调用），生成 Plan ———
            let decided = {
                let mut pet = match shared.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        tick = IDLE_TICK_MS;
                        continue;
                    }
                };

                // 快照校验：阶段1→3 之间 mode/dragging/perch 若被 command 改过
                // （松手、切配置等），基于旧快照的查询结果已失效，丢弃本轮，下轮再来。
                if pet.mode != snap.mode || pet.dragging != snap.dragging {
                    None
                } else if snap.perch_hwnd != pet.perch.as_ref().map(|p| p.hwnd) {
                    None
                } else {
                    let mut plan = Plan::default();
                    let mut acted = false;

                    match sys {
                        // 拖拽：窗口跟随光标
                        PollSys::Center((cx, cy)) if pet.dragging => {
                            pet.cfg.cx = Some(cx);
                            pet.cfg.cy = Some(cy);
                            plan.pos = Some((
                                (cx - wsize.0 / 2.0).round(),
                                (cy - wsize.1 / 2.0).round(),
                            ));
                            if pet.ignoring {
                                pet.ignoring = false;
                                plan.ignore = Some(false);
                            }
                            acted = true;
                        }
                        // 坐在边上：跟随宿主矩形 + 命中判定（坐着的桌宠也要能被抓走）
                        PollSys::PerchPos { tx, ty, span } if pet.mode == Mode::Perched => {
                            // 本轮宿主读到了，失败计数清零
                            pet.perch_lost = 0;
                            let off_y = pet.contact_off_y();

                            // 支撑判定 —— 坐在窗口上沿，支撑就是"上沿还在脚底下"：
                            //  · 上沿往下走了 → 平台从脚底抽走，开始跟着掉（不是黏在一起）
                            //  · 上沿往上顶    → 把桌宠跟着顶上去
                            //  · 窗口横向缩到装不下接触点 → 能坐的地方没有了，直接往下掉
                            //
                            // 只和"上一轮记下的上沿 y"比，不看回读的接触点 —— 因为接触点
                            // `off_y` 是前端异步同步过来的，切换姿态那一帧会让
                            // 回读接触点整体位移 20+px，拿它判"平台下沉"必然误判成脱手。
                            let dropped = match pet.perch_last {
                                // 2px 容差：set_position 取整写回，上沿读数会有零点几像素抖动
                                Some((_, py)) => ty > py + 2.0,
                                None => false,
                            };
                            let horiz_gone = match (&pet.perch, span) {
                                (Some(p), Some((l, r))) => {
                                    l + p.offset_x > r - 8.0 || l + p.offset_x < l + 4.0
                                }
                                // 任务栏没有 span，永远坐得下
                                _ => false,
                            };

                            // 只有开了重力才"脱手"：吸附模式下本来就该黏着宿主一起动。
                            if pet.cfg.gravity && (dropped || horiz_gone) {
                                let hwnd = pet.perch.as_ref().map(|p| p.hwnd).unwrap_or(0);
                                let off = pet.perch.as_ref().map(|p| p.offset_x).unwrap_or(0.0);
                                pet.perch = None;
                                pet.perch_last = None;
                                pet.perch_still = 0;
                                // 掉了之后位置接着由下落积分算，别留旧的去重值
                                pet.applied = None;
                                pet.mode = Mode::Falling;
                                pet.vy = 0.0;
                                // 平台被抽走：下落时继续跟着宿主横移（同一竖列往下掉）
                                // 支撑范围没了：真自由落体，让她掉到下面那个窗口/任务栏
                                pet.fall_follow = if !horiz_gone && hwnd != 0 {
                                    Some((hwnd, off))
                                } else {
                                    None
                                };
                                plan.posture = take_posture(&mut pet, true);
                                acted = true;
                            } else {
                                // 宿主是否在移动：拿夹紧前的原始接触点和上一轮比，决定下轮档位
                                let moved = match pet.perch_last {
                                    Some((px, py)) => (px - tx).abs() > 0.5 || (py - ty).abs() > 0.5,
                                    None => true,
                                };
                                if moved {
                                    pet.perch_last = Some((tx, ty));
                                    pet.perch_still = 0;
                                } else {
                                    pet.perch_still += 1;
                                }
                                let mut tx = tx;
                                if let Some((l, r)) = span {
                                    // 注意 clamp 在 min > max 时会 panic（窗口被拖得极窄），
                                    // 这里用 max/min 自己夹，绝不炸轮询线程。
                                    let lo = l + 8.0;
                                    let hi = (r - 8.0).max(lo);
                                    tx = tx.max(lo).min(hi);
                                }
                                let left = tx - CONTAINER_PX / 2.0;
                                let top = ty - off_y;
                                if pet
                                    .applied
                                    .map(|(x, y)| (x - left).abs() > 0.5 || (y - top).abs() > 0.5)
                                    .unwrap_or(true)
                                {
                                    plan.pos = Some((left.round(), top.round()));
                                    pet.applied = Some((left, top));
                                }
                                pet.store_center(tx, ty);
                                // 关键：坐姿态也必须按掩膜判定穿透，否则整个透明容器都可点
                                update_ignore(
                                    &mut pet,
                                    (cursor.0, cursor.1),
                                    (wpos.0, wpos.1),
                                    (wsize.0, wsize.1),
                                    &mut plan,
                                );
                                acted = true;
                            }
                        }
                        // 宿主被关掉 / 最小化 / 最大化：单轮读不到不算，攒够再掉
                        PollSys::PerchGone if pet.mode == Mode::Perched => {
                            pet.perch_lost += 1;
                            // 计数期间保持 60Hz，别在 80ms 档上慢慢数
                            pet.perch_still = 0;
                            if pet.perch_lost >= PERCH_LOST_TICKS {
                                pet.perch = None;
                                pet.perch_lost = 0;
                                pet.perch_last = None;
                                pet.perch_still = 0;
                                pet.applied = None;
                                pet.fall_follow = None;
                                let fall = pet.cfg.gravity;
                                pet.mode = if fall { Mode::Falling } else { Mode::Free };
                                pet.vy = 0.0;
                                plan.posture = take_posture(&mut pet, fall);
                            }
                            acted = true;
                        }
                        // 重力下落
                        PollSys::FallBounds {
                            lx,
                            rx,
                            ground_y,
                            win_tops,
                        } if pet.mode == Mode::Falling => {
                            let off_y = pet.contact_off_y();
                            // 先按显示器夹紧再算任何相对量：offset_x 必须是"夹紧后"的
                            // 接触点相对窗口左沿的偏移，否则窗口贴着屏幕边时 offset_x 会
                            // 落到窗口范围之外，坐下第一帧就被判成"支撑没了"又掉下去。
                            let cx = (wpos.0 + CONTAINER_PX / 2.0).clamp(lx, rx);
                            let mut cy = wpos.1 + off_y;
                            let prev_cy = cy;
                            pet.vy = (pet.vy + GRAVITY * dt).min(MAX_FALL_SPEED);
                            cy += pet.vy * dt;

                            // 这一帧穿越的可落边：任务栏地面 + 窗口上边缘，取 y 最小的
                            // （最靠上、最先碰到的）。落上去就和坐在任务栏上效果一致。
                            let mut land_y: Option<f64> = None;
                            let mut land_perch: Option<Perch> = None;

                            // 任务栏：脚底越过即触地
                            if cy >= ground_y {
                                land_y = Some(ground_y);
                                land_perch = Some(Perch {
                                    hwnd: 0,
                                    kind: PerchKind::Taskbar,
                                    offset_x: cx,
                                });
                            }

                            // 窗口上边缘：只认"这一帧真正穿越"的边（prev_cy..=cy），
                            // 外加 2px 容差。窗口位置是按整数像素写回去的，回读的接触点
                            // 有 ±0.5px 量化误差 —— 弹跳之后接触点可能刚好落在边上沿下方
                            // 零点几像素，没有容差的话这条边就永远"跨不过去"，表现为
                            // 「在上沿弹一下，然后穿过去掉到任务栏」。
                            const EDGE_TOL: f64 = 2.0;
                            if pet.vy > 0.0 {
                                for wt in &win_tops {
                                    if wt.top < prev_cy - EDGE_TOL {
                                        continue;
                                    }
                                    if wt.top > cy {
                                        break; // 升序，后面的更靠下，这帧到不了
                                    }
                                    if land_y.map_or(true, |ly| wt.top < ly) {
                                        land_y = Some(wt.top);
                                        land_perch = Some(Perch {
                                            hwnd: wt.hwnd,
                                            kind: PerchKind::Window,
                                            offset_x: cx - wt.left,
                                        });
                                    }
                                    break; // 第一条穿越的就是最高的窗口边
                                }
                            }

                            if let (Some(ly), Some(lp)) = (land_y, land_perch) {
                                cy = ly;
                                // 弹起来的高度看得见才弹；剩下的能量已经不足 BOUNCE_MIN
                                // 就直接坐稳，避免"抖一下"的假弹跳。
                                let up = pet.vy.max(0.0) * RESTITUTION;
                                if up > BOUNCE_MIN {
                                    pet.vy = -up;
                                } else {
                                    pet.vy = 0.0;
                                    pet.mode = Mode::Perched;
                                    // 只有落到**任务栏**才触发落地慌张反应；窗口上沿落座不触发
                                    if lp.kind == PerchKind::Taskbar {
                                        plan.panic = true;
                                    }
                                    pet.perch = Some(lp);
                                    pet.perch_last = None;
                                    pet.perch_still = 0;
                                    pet.perch_lost = 0;
                                    pet.fall_follow = None;
                                    plan.posture = take_posture(&mut pet, true);
                                }
                            }

                            let left = cx - CONTAINER_PX / 2.0;
                            let top = cy - off_y;
                            plan.pos = Some((left.round(), top.round()));
                            pet.applied = Some((left, top));
                            pet.store_center(cx, cy);
                            if pet.ignoring {
                                pet.ignoring = false;
                                plan.ignore = Some(false);
                            }
                            acted = true;
                        }
                        // 命中判定 → 穿透开关；顺带修复 Perched 却无宿主的异常态
                        PollSys::None => {
                            update_ignore(
                                &mut pet,
                                (cursor.0, cursor.1),
                                (wpos.0, wpos.1),
                                (wsize.0, wsize.1),
                                &mut plan,
                            );
                            if pet.mode == Mode::Perched {
                                pet.mode = Mode::Free;
                                plan.posture = take_posture(&mut pet, false);
                            }
                            acted = true;
                        }
                        _ => {}
                    }

                    if !acted {
                        None
                    } else {
                        let next = match pet.mode {
                            Mode::Drag | Mode::Falling => DRAG_TICK_MS,
                            // 坐在边上：宿主在动就 60Hz 跟手，静止就降到空闲档省电
                            Mode::Perched => {
                                if pet.perch_still >= PERCH_STILL_TICKS {
                                    IDLE_TICK_MS
                                } else {
                                    DRAG_TICK_MS
                                }
                            }
                            Mode::Free => IDLE_TICK_MS,
                        };
                        Some((plan, next))
                    }
                }
            }; // ← 锁释放

            // ——— 阶段4：锁外才动窗口 API / 发事件 ———
            if let Some((plan, next)) = decided {
                if let Some((x, y)) = plan.pos {
                    let _ = win.set_position(Position::Physical(PhysicalPosition::new(
                        x as i32, y as i32,
                    )));
                }
                if let Some(v) = plan.ignore {
                    let _ = win.set_ignore_cursor_events(v);
                    let _ = app.emit("pet:interactive", !v);
                }
                if let Some(sit) = plan.posture {
                    let _ = app.emit("pet:posture", serde_json::json!({ "sit": sit }));
                }
                if plan.panic {
                    let _ = app.emit("pet:panic", ());
                }
                tick = next;
            } else {
                tick = IDLE_TICK_MS;
            }
        }
    });
}

// ————————————————————————— 入口 —————————————————————————

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // 配置目录
            let dir = handle
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = fs::create_dir_all(&dir);
            let cfg_path = dir.join("config.json");

            let mut cfg: Cfg = fs::read_to_string(&cfg_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            // 老配置里可能两个都开着（规则上互斥），这里纠正一次
            if cfg.snap {
                cfg.gravity = false;
            }

            let pet = Pet {
                cfg: cfg.clone(),
                cfg_path,
                mask: None,
                dragging: false,
                drag_off: (0.0, 0.0),
                menu_open: false,
                ignoring: false,
                mode: Mode::Free,
                vy: 0.0,
                perch: None,
                contact_off: DEFAULT_OFF_Y,
                char_h: DEFAULT_CHAR_H,
                dpi: 1.0,
                last_tick: Instant::now(),
                last_sit: None,
                applied: None,
                perch_last: None,
                perch_still: 0,
                perch_lost: 0,
                fall_follow: None,
            };
            let shared: Shared = Arc::new(Mutex::new(pet));
            app.manage(shared.clone());

            // 摆位：有记忆就复原，没有就落在主屏右下角
            if let Some(win) = app.get_webview_window("pet") {
                let sf = win.scale_factor().unwrap_or(1.0);
                shared.lock().unwrap().dpi = sf;

                // 关键：窗口尺寸按「物理像素」定，再换算成逻辑像素交给 Tauri。
                // 否则 125% 缩放下 1024 逻辑会变成 1280 物理，撑出 1080p 屏幕。
                let logical = CONTAINER_PX / sf;
                let _ = win.set_size(tauri::LogicalSize::new(logical, logical));

                let pet_px = match cfg.size.as_str() {
                    "large" => 768.0,
                    "small" => 384.0,
                    _ => 512.0,
                };

                let (cx, cy) = match (cfg.cx, cfg.cy) {
                    (Some(x), Some(y)) => clamp_center(x, y),
                    _ => {
                        let m = handle.primary_monitor().ok().flatten();
                        if let Some(m) = m {
                            let p = m.position();
                            let s = m.size();
                            (
                                p.x as f64 + s.width as f64 - pet_px / 2.0 - 60.0,
                                p.y as f64 + s.height as f64 - pet_px / 2.0 - 40.0,
                            )
                        } else {
                            (600.0, 400.0)
                        }
                    }
                };

                cfg.cx = Some(cx);
                cfg.cy = Some(cy);
                {
                    let mut g = shared.lock().unwrap();
                    g.cfg.cx = Some(cx);
                    g.cfg.cy = Some(cy);
                }

                place(&win, cx, cy);
                let _ = win.set_always_on_top(cfg.always_on_top);
                let _ = win.set_ignore_cursor_events(true);
                shared.lock().unwrap().ignoring = true;
                let _ = win.show();
            }

            // 桌宠自己窗口的句柄：轮询线程用 Win32 直接读几何，省掉每 tick 三次
            // 主线程往返。这里在主线程上拿一次（window_handle 是 send_user_message +
            // recv 的阻塞往返，不能在轮询线程里每轮调）。
            let self_hwnd: isize = app
                .get_webview_window("pet")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);

            spawn_poller(handle, shared, self_hwnd);

            // 托盘图标：右键出「打开工具箱窗口」「退出」
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("[pet] 托盘图标创建失败: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_cfg,
            set_mask,
            set_contact,
            set_menu_open,
            get_debug,
            start_drag,
            end_drag,
            set_always_on_top,
            quit_app,
            open_toolbox
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
