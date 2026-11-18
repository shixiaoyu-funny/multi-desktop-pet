//! Multi_Pet（Tauri 2 主逻辑）
//!
//! 单窗口承载 角色切换 / 待机切换 / AI 聊天 / 设置 / 养成面板，
//! 另有一个 340×340 的全透明桌面角色窗口（pet）浮在桌面上。
//!
//! 桌面角色的物理（拖拽 / 吸附 / 重力下落 / 点击穿透）全部在 Rust 侧：
//!  · 拖拽由轮询线程按全局光标驱动，不走 JS 每帧 IPC，所以跟手
//!  · 吸附是“松手时坐到窗口上沿或任务栏上沿”，不是贴屏幕四角
//!  · 重力是真的积分下落，会落在最先碰到的窗口上沿或任务栏上，并带轻微回弹
//!  · 命中判定用前端算好的 alpha 掩膜，掩膜外整窗穿透，不挡住底下的桌面

pub mod affection;
pub mod apps;
pub mod chat;
pub mod interactions;
pub mod milk_tea;
pub mod tools;
pub mod tts;
pub mod win;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
    WebviewWindowBuilder,
};

// ————————————————————————— 角色元数据 —————————————————————————

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterMeta {
    pub id: &'static str,
    pub name: &'static str,
    pub display: &'static str,
    pub avatar: &'static str,
    pub tagline: &'static str,
    /// 姿态列表（与 manifest 一致）
    pub postures: &'static [&'static str],
    /// 是否有官方可用声线。为 false 时后端不会合成语音，设置里也不显示语音开关。
    pub voice: bool,
    /// 饮品互动的名称（按钮文案、台词提示词都用它）。
    /// 蕾文 / Suki 喝的是奶茶，林德维恩喝的是「茶饮」——不能一律叫奶茶。
    pub drink_label: &'static str,
    /// 该角色的饮品动作 id（与 manifest 的 items[].id 对齐），随机取一个播。
    /// 为空表示这个角色没有饮品动作，前端不显示按钮。
    pub drink_actions: &'static [&'static str],
}

const CHARACTERS: &[CharacterMeta] = &[
    CharacterMeta {
        id: "raven",
        name: "Raven",
        display: "蕾文",
        avatar: "assets/avatars/raven.png",
        tagline: "傲娇 · 黑红",
        postures: &["stand", "sit_upright", "sit_side"],
        voice: true,
        drink_label: "奶茶",
        drink_actions: &["milk_tea_2003", "milk_tea_c"],
    },
    CharacterMeta {
        id: "suki",
        name: "Suki",
        display: "Suki",
        avatar: "assets/avatars/suki.png",
        tagline: "元气 · 粉蓝",
        postures: &["stand", "sit_upright", "sit_duck"],
        voice: true,
        drink_label: "奶茶",
        drink_actions: &["drink_milk_tea_a", "drink_milk_tea_b"],
    },
    CharacterMeta {
        id: "lindverne",
        name: "Lindverne",
        display: "林德维恩",
        avatar: "assets/avatars/lindverne.png",
        tagline: "挽昼 · 白灰蓝",
        postures: &["stand", "sit_upright"],
        // 林德维恩的原声属于官方版权素材，不能合成、也不能用别的声线冒充，因此只出文字。
        voice: false,
        // 她的动作叫「喝茶饮」，别写成奶茶
        drink_label: "茶饮",
        drink_actions: &["stand_tea_drink"],
    },
    CharacterMeta {
        id: "aha",
        name: "Aha",
        display: "阿哈",
        avatar: "assets/avatars/aha.png",
        tagline: "欢愉 · 白红",
        postures: &["stand", "sit_upright"],
        // 阿哈没有可用的官方声线，也只出文字（和"不用假声线冒充"同一条原则）
        voice: false,
        // 祂喝的是「气泡饮料」
        drink_label: "气泡饮料",
        drink_actions: &["stand_drink"],
    },
];

/// 角色表（只读），供其它模块按 id 查询能力（例如是否有语音）。
pub fn characters() -> &'static [CharacterMeta] {
    CHARACTERS
}

/// 角色元数据；未知 id 退回第一条，避免调用方到处判空。
pub fn character_of(id: &str) -> &'static CharacterMeta {
    CHARACTERS.iter().find(|c| c.id == id).unwrap_or(&CHARACTERS[0])
}

// ————————————————————————— 配置 —————————————————————————

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cfg {
    #[serde(default)]
    pub version: u32,
    /// 当前角色：raven / suki / lindverne
    #[serde(default = "default_char")]
    pub active_char: String,
    /// 开机自启
    #[serde(default)]
    pub autostart: bool,
    /// 重力掉落（开吸附时强制关闭）
    #[serde(default)]
    pub gravity: bool,
    /// 窗口吸附：松手时坐到最近的窗口上沿 / 任务栏上沿
    #[serde(default)]
    pub snap: bool,
    /// 语音播报开关
    #[serde(default = "default_tts")]
    pub tts: bool,
    /// 允许 AI 联网搜索
    #[serde(default)]
    pub web_search: bool,
    /// 桌面窗尺寸档：small / medium / large（物理像素 256 / 384 / 512）
    #[serde(default = "default_size")]
    pub size: String,
    /// 全屏（游戏 / 视频 / 演示）时静默隐藏桌宠并释放视频解码
    #[serde(default = "default_true")]
    pub fullscreen_hide: bool,
    /// 坐姿吸附的接触点微调：角色 → 坐姿 → 三个尺寸档（逻辑像素，正数往下）
    #[serde(default = "default_snap_offsets")]
    pub snap_offsets: HashMap<String, SnapOffsets>,
}

/// 三个尺寸档的吸附落脚点微调，下标顺序固定为 小 / 中 / 大
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SnapOffsets {
    /// 站姿（也是所有"没坐下"的动作）
    pub stand: [f64; 3],
    /// 正坐
    pub upright: [f64; 3],
    /// 侧坐
    pub side: [f64; 3],
    /// 鸭子坐（Suki）
    pub duck: [f64; 3],
}

impl Default for SnapOffsets {
    fn default() -> Self {
        Self {
            stand: [0.0; 3],
            upright: [0.0; 3],
            side: [0.0; 3],
            duck: [0.0; 3],
        }
    }
}

fn default_size() -> String {
    "medium".into()
}

fn default_true() -> bool {
    true
}

/// 出厂值：直接照搬两个单体桌宠调稳定稿的数字，林德维恩用用户人眼定稿值。
///  · role2(Raven)：正坐 20/27/40、侧坐 6/8/12
///  · role7(Suki) ：正坐 61/79/120、鸭子坐 20/27/40
///  · 林德维恩   ：只有正坐（manifest 里没有 side/duck），正坐 37/49/73
///  · 阿哈       ：还没人眼调过，全 0，等用户在开发者面板里现场调
///
/// 站姿（`stand`）一律 0：它能被调，但出厂就当"已经坐准了"，
/// 只有用户人眼看出脚悬空/陷进去时才会在面板里给某个角色写非 0。
fn default_snap_offsets() -> HashMap<String, SnapOffsets> {
    let mut map = HashMap::new();
    map.insert(
        "raven".to_string(),
        SnapOffsets {
            stand: [0.0; 3],
            upright: [20.0, 27.0, 40.0],
            side: [6.0, 8.0, 12.0],
            duck: [0.0; 3],
        },
    );
    map.insert(
        "suki".to_string(),
        SnapOffsets {
            stand: [0.0; 3],
            upright: [61.0, 79.0, 120.0],
            side: [0.0; 3],
            duck: [20.0, 27.0, 40.0],
        },
    );
    map.insert(
        "lindverne".to_string(),
        SnapOffsets {
            stand: [0.0; 3],
            upright: [37.0, 49.0, 73.0],
            side: [0.0; 3],
            duck: [0.0; 3],
        },
    );
    // 阿哈：还没有人眼调过的坐姿落点，先给 0（开发者面板可以现场调）
    map.insert("aha".to_string(), SnapOffsets::default());
    map
}

/// 配置结构版本。加字段/改出厂值时要 +1，并在 `migrate_cfg` 里补一次性迁移。
const CFG_VERSION: u32 = 3;

/// 老配置的一次性迁移（只在启动时跑，跑完把 version 写成当前值）。
///
/// 刻意**不写**「全是 0 就当没调过」这种兜底：用户可能真的把某个角色调成 0，
/// 那样每次启动都会被打回出厂值。这里只认「存储值 == 上一版出厂值」这一种情形，
/// 精确命中才替换，之后用户怎么改都不会再被动。
fn migrate_cfg(cfg: &mut Cfg) {
    if cfg.version >= CFG_VERSION {
        return;
    }
    let new = default_snap_offsets();
    // 历届林德维恩正坐出厂值：v1 全 0 → v2 [33,49,73] → v3 [37,49,73]
    let legacy = [
        SnapOffsets::default(),
        SnapOffsets {
            stand: [0.0; 3],
            upright: [33.0, 49.0, 73.0],
            side: [0.0; 3],
            duck: [0.0; 3],
        },
    ];
    if let Some(set) = cfg.snap_offsets.get_mut("lindverne") {
        if legacy.contains(set) {
            if let Some(fixed) = new.get("lindverne") {
                *set = *fixed;
            }
        }
    }
    cfg.version = CFG_VERSION;
}

/// 尺寸档 → 窗口物理边长（与单体桌宠的 SIZES 一致）
/// shixiaoyu-funny
fn size_physical(size: &str) -> u32 {
    match size {
        "small" => 256,
        "medium" => 384,
        "large" => 512,
        _ => 384,
    }
}

/// 尺寸档 → 三个档位的下标（小 / 中 / 大）
fn size_index(size: &str) -> usize {
    match size {
        "small" => 0,
        "large" => 2,
        _ => 1,
    }
}

fn normalize_size(size: &str) -> String {
    match size {
        "small" | "medium" | "large" => size.to_string(),
        _ => default_size(),
    }
}

fn default_char() -> String {
    "raven".into()
}

fn default_tts() -> bool {
    true
}

impl Default for Cfg {
    fn default() -> Self {
        Self {
            version: 1,
            active_char: default_char(),
            autostart: false,
            gravity: true,
            snap: false,
            tts: true,
            web_search: false,
            size: default_size(),
            fullscreen_hide: true,
            snap_offsets: default_snap_offsets(),
        }
    }
}

// ————————————————————————— 物理常量 —————————————————————————

/// 拖拽 / 重力下落 / 宿主移动时的轮询间隔：要平滑，保持 60Hz
const DRAG_TICK_MS: u64 = 16;
/// 自由停留 / 宿主静止时的轮询间隔：12.5Hz 足够
const IDLE_TICK_MS: u64 = 80;
/// 宿主连续多少轮位置不变，才把“坐在边上”的轮询降到空闲档
const PERCH_STILL_TICKS: u32 = 10;
/// 宿主查询连续失败多少轮才判定“真的没了”，避免 DWM 瞬时抖动导致坐 0.2 秒就掉
const PERCH_LOST_TICKS: u32 = 4;

/// 吸附落脚点微调的上限（逻辑像素）。滑杆只给 ±150，输入框可以直接打字到 ±300。
const SNAP_LIMIT: f64 = 300.0;

/// 吸附半径（逻辑像素，运行时乘 DPI）。太小要精准对准，太大会把还没想放的地方吸住。
const SNAP_PX: f64 = 80.0;
/// 视频里角色的接地线比例（与 manifest.groundRatio 一致）
const GROUND_RATIO: f64 = 0.861;
/// 角色占画面高度比例（站姿）。只在前端同步 `set_pet_contact` 之前当默认值用。
const CHAR_H_RATIO: f64 = 0.68;

/// 下落超过“角色高度 × 这个比例”才触发落地慌张（单体版是 200px / 696px ≈ 0.29）
const PANIC_MIN_DROP_RATIO: f64 = 0.287;
/// 慌张动画提前量：接触点距任务栏 5px 时就触发
const PANIC_TRIGGER_AHEAD_PX: f64 = 5.0;
/// 落地回弹系数
const RESTITUTION: f64 = 0.22;
/// 最高下落速度 ≈ 6 倍角色高度/秒（单体版 4200px/s ÷ 696px ≈ 6.03）
const MAX_FALL_PER_H: f64 = 6.03;
/// 低于这个速度就停住不弹（0.374 × 角色高度）
const BOUNCE_MIN_PER_H: f64 = 0.374;

// ————————————————————————— 物理状态 —————————————————————————

/// 桌宠窗口当前处于哪种运动状态
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
    /// 接触点相对宿主窗口左边缘的偏移，用来实现“窗口拖动时跟着平移”
    offset_x: f64,
}

/// 下落途中可坐上去的窗口上边缘（已过滤最大化、水平范围、头顶空间）。
#[derive(Clone, Debug)]
struct WinTop {
    hwnd: isize,
    /// 上边缘的屏幕 y（物理像素）
    top: f64,
    /// 窗口左边缘（算 offset_x 用）
    left: f64,
}

/// 前端的 alpha 掩膜，用来判定光标是否真的落在角色像素上
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

struct PetState {
    mask: Option<Mask>,
    /// 是否收到过掩膜。没有掩膜时**不做**穿透切换，否则前端没送掩膜时桌宠会点不到。
    mask_seen: bool,
    dragging: bool,
    /// 光标相对窗口左上角的偏移（物理像素）
    drag_off: (f64, f64),
    ignoring: bool,

    mode: Mode,
    vy: f64,
    perch: Option<Perch>,
    /// 接触点距窗口顶部的**物理像素**偏移，以及角色在屏幕上的实际高度。
    /// 由前端用 getBoundingClientRect 量好送过来 —— 显示尺寸随窗口/动作变化，
    /// Rust 自己按窗口高度推会算错。
    contact_off: f64,
    char_h: f64,
    dpi: f64,
    last_tick: Instant,
    /// 上次真正 SetWindowPos 的窗口左上角，位置没变就不重复设置
    applied: Option<(f64, f64)>,
    /// 上次看到的宿主接触点，用来判断宿主是否在移动（决定轮询档位）
    perch_last: Option<(f64, f64)>,
    perch_still: u32,
    perch_lost: u32,
    /// 「支撑被抽走」导致的下落：`(宿主 hwnd, 接触点相对左边缘的偏移)`
    fall_follow: Option<(isize, f64)>,
    /// 本次下落开始时的接触点 y；落地时用它算下落高度，决定是否触发慌张
    fall_start_y: Option<f64>,
    panic_fired: bool,
    /// 轮询线程已跑过多少轮（诊断“线程是否还活着”）
    ticks: u64,
    /// 轮询线程最近读到的光标位置（诊断拖拽是否跟手）
    last_cursor: Option<(f64, f64)>,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            mask: None,
            mask_seen: false,
            dragging: false,
            drag_off: (0.0, 0.0),
            ignoring: false,
            mode: Mode::Free,
            vy: 0.0,
            perch: None,
            contact_off: 0.0,
            char_h: 0.0,
            dpi: 1.0,
            last_tick: Instant::now(),
            applied: None,
            perch_last: None,
            perch_still: 0,
            perch_lost: 0,
            fall_follow: None,
            fall_start_y: None,
            panic_fired: false,
            ticks: 0,
            last_cursor: None,
        }
    }
}

impl PetState {
    /// 接触点距窗口顶部的偏移。前端还没同步过、或者几何明显不合理时按窗口高度估算。
    fn contact_off_y(&self, win_h: f64) -> f64 {
        if self.contact_off > 4.0 && self.contact_off < win_h * 2.0 {
            self.contact_off
        } else {
            win_h * GROUND_RATIO
        }
    }

    /// 角色在屏幕上的实际高度（用于判断“头顶会不会出屏幕”）
    fn char_px(&self, win_h: f64) -> f64 {
        if self.char_h > 4.0 && self.char_h < win_h * 2.0 {
            self.char_h
        } else {
            win_h * CHAR_H_RATIO
        }
    }

    fn snap_radius(&self) -> f64 {
        SNAP_PX * self.dpi.max(0.5)
    }

    /// 吸附落脚点微调：按角色 × 姿态 × 尺寸档取，正数往下压（角色整体沉一点），负数往上抬。
    ///
    /// `stand` 也走这里：站姿站在任务栏/窗口上沿时同样会差几个像素，
    /// 只不过出厂值全是 0，所以默认行为和以前一样。
    fn snap_shift(&self, cfg: &Cfg, granular: &str) -> f64 {
        let idx = size_index(&cfg.size);
        let set = cfg.snap_offsets.get(&cfg.active_char).copied().unwrap_or_default();
        let logical = match granular {
            "sit_upright" => set.upright[idx],
            "sit_side" => set.side[idx],
            "sit_duck" => set.duck[idx],
            "stand" => set.stand[idx],
            _ => 0.0,
        };
        logical.clamp(-SNAP_LIMIT, SNAP_LIMIT) * self.dpi.max(0.5)
    }
}

// ————————————————————————— 共享状态 —————————————————————————

struct AppState {
    cfg: Cfg,
    cfg_path: PathBuf,
    pet: PetState,
    /// 当前细分姿态（stand / sit_upright / sit_duck / sit_side），前端切动作时同步
    granular: String,
    /// 全屏静默中：桌宠窗口已隐藏、前端已释放视频解码。
    /// 物理轮询线程看到它就整轮跳空，省电也避免去挪一个看不见的窗口。
    fullscreen_hidden: bool,
    /// 触发静默的前台窗口标题（诊断 + 托盘提示用）
    fullscreen_title: String,
    /// 静默前的窗口落点。独占全屏会切显示模式，系统会把桌面窗口挪到新模式的
    /// 坐标系里；恢复时先还原这个点，再夹进屏幕。
    fullscreen_saved_pos: Option<(f64, f64)>,
}

impl AppState {
    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.cfg) {
            let _ = fs::write(&self.cfg_path, s);
        }
    }
}

type Shared = Arc<Mutex<AppState>>;

/// 一次轮询要产出的动作
#[derive(Default)]
struct Plan {
    pos: Option<(f64, f64)>,
    ignore: Option<bool>,
    panic: bool,
}

// ————————————————————————— 命令 —————————————————————————

/// 点关闭只藏主窗口，不销毁。销毁之后托盘和右键都找不到它，只能重启。
/// https://space.bilibili.com/517323821?spm_id_from=333.1007.0.0
fn keep_main_alive(window: &WebviewWindow) {
    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let win = win.clone();
            // hide 不能写在这个回调里同步做：回调还压在消息循环上。
            std::thread::spawn(move || {
                let _ = win.hide();
            });
        }
    });
}

fn reopen_main(app: &AppHandle) -> Option<WebviewWindow> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")?
        .clone();
    let window = WebviewWindowBuilder::from_config(app, &cfg).ok()?.build().ok()?;
    keep_main_alive(&window);
    Some(window)
}

/// 把 show / set_focus 挪出当前调用栈。
///
/// 右键 IPC 和托盘菜单都在主线程的回调里。这里若直接 `show` + `set_focus`，
/// WebView2 还握着锁，ShowWindow / SetForegroundWindow 会重入消息循环，主线程卡死。
/// 卡死之后任务栏按钮、托盘「显示主窗口」都不再被处理。
/// 先丢到别的线程，再 `run_on_main_thread` 排进消息队列，等回调返回后才真正显示。
fn reveal_main(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if app.get_webview_window("main").is_none() {
            let _ = reopen_main(&app);
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = app2.get_webview_window("main") else {
                return;
            };
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            #[cfg(windows)]
            if let Ok(hwnd) = window.hwnd() {
                win32_raise(hwnd.0 as isize);
            }
        });
    });
}

#[cfg(windows)]
fn win32_raise(hwnd: isize) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };
    let hwnd = hwnd as HWND;
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }
        let _ = BringWindowToTop(hwnd);
        if SetForegroundWindow(hwnd) == 0 {
            // 右键发生在「不激活」的桌宠窗上，系统经常不给前台权。按一下 Alt 再抢。
            keybd_event(VK_MENU as u8, 0, 0, 0);
            let _ = SetForegroundWindow(hwnd);
            keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
        }
    }
}

#[tauri::command]
fn show_main(app_handle: AppHandle) {
    reveal_main(&app_handle);
}

#[tauri::command]
fn bootstrap(state: tauri::State<'_, Shared>) -> serde_json::Value {
    let app = state.lock().unwrap();
    serde_json::json!({
        "cfg": app.cfg,
        "characters": CHARACTERS,
    })
}

#[tauri::command]
fn save_cfg(
    patch: serde_json::Value,
    app_handle: AppHandle,
    state: tauri::State<'_, Shared>,
) -> serde_json::Value {
    let mut app = state.lock().unwrap();
    if let Some(o) = patch.as_object() {
        if let Some(v) = o.get("activeChar").and_then(|v| v.as_str()) {
            if CHARACTERS.iter().any(|c| c.id == v) {
                app.cfg.active_char = v.to_string();
            }
        }
        if let Some(v) = o.get("snap").and_then(|v| v.as_bool()) {
            app.cfg.snap = v;
        }
        if let Some(v) = o.get("gravity").and_then(|v| v.as_bool()) {
            app.cfg.gravity = v;
        }
        // 互斥检查必须放在**两个字段都写入之后**。
        // 否则同时提交 {snap:false, gravity:true} 时，重力那一步会读到旧的
        // snap=true，把自己又关掉 —— 表现为“点了重力没反应”。
        if app.cfg.snap {
            app.cfg.gravity = false;
        }
        if let Some(v) = o.get("tts").and_then(|v| v.as_bool()) {
            app.cfg.tts = v;
        }
        if let Some(v) = o.get("webSearch").and_then(|v| v.as_bool()) {
            app.cfg.web_search = v;
        }
        if let Some(v) = o.get("size").and_then(|v| v.as_str()) {
            app.cfg.size = normalize_size(v);
        }
        if let Some(v) = o.get("fullscreenHide").and_then(|v| v.as_bool()) {
            app.cfg.fullscreen_hide = v;
        }
    }
    app.save();
    let snapshot = app.cfg.clone();
    drop(app);

    // 同步给聊天状态：关掉时连 web_search 工具都不暴露
    if let Some(chat) = app_handle.try_state::<chat::ChatState>() {
        chat.set_web_search(snapshot.web_search);
    }

    serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
fn set_autostart(
    app: AppHandle,
    enabled: bool,
    state: tauri::State<'_, Shared>,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| format!("开启开机自启失败：{error}"))?;
    } else {
        manager.disable().map_err(|error| format!("关闭开机自启失败：{error}"))?;
    }
    let mut s = state.lock().map_err(|_| "配置锁不可用".to_string())?;
    s.cfg.autostart = enabled;
    s.save();
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle, state: tauri::State<'_, Shared>) {
    state.lock().unwrap().save();
    app.exit(0);
}

// ————————————————————————— 桌面角色窗口物理 —————————————————————————

/// 容器中心点夹进屏幕四边之内 —— 允许半个桌宠探出屏幕外
fn clamp_center(cx: f64, cy: f64) -> (f64, f64) {
    let (x0, y0, x1, y1) = win::monitor_bounds(cx, cy);
    (cx.clamp(x0, x1), cy.clamp(y0, y1))
}

/// 用当前光标 + 掩膜决定窗口是否该穿透。**只在锁内调用，纯内存运算。**
///
/// 这是“能否抓住桌宠”的唯一边界：光标落在角色像素上 → 窗口可交互（可拖拽），
/// 否则穿透，不挡住底下的桌面。所有模式（Free / Perched / Falling）都必须走这里。
fn update_ignore(
    pet: &mut PetState,
    cursor: (f64, f64),
    wpos: (f64, f64),
    wsize: (f64, f64),
    plan: &mut Plan,
) {
    // 还没收到过掩膜：保持现状，别把窗口变成一个点不到的透明块
    if !pet.mask_seen {
        return;
    }
    let rx = (cursor.0 - wpos.0) / wsize.0.max(1.0);
    let ry = (cursor.1 - wpos.1) / wsize.1.max(1.0);
    let on_pet = match &pet.mask {
        Some(m) => m.hit(rx, ry),
        None => false,
    };
    let want_ignore = !on_pet;
    if want_ignore != pet.ignoring {
        pet.ignoring = want_ignore;
        plan.ignore = Some(want_ignore);
    }
}

/// 松开鼠标时找一个可以坐上去的边。
///
/// 规则：
///  · 任务栏上沿永远可坐
///  · 应用窗口看它的上边缘，接触点落在窗口水平范围内、垂直差 ≤ 吸附半径
///  · **头顶必须留得下**：坐上去角色脑袋会跑出屏幕顶部就跳过这个目标
fn find_snap(cx: f64, cy: f64, radius: f64, char_h: f64) -> Option<Perch> {
    let r = radius;
    let (_, mon_top, _, _) = win::monitor_bounds(cx, cy);
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
    for w in win::list_windows(win::current_pid(), 0) {
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
                // 距离优先；距离相同时偏好窗口（可以跟着窗口一起拖）
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

/// 前端切动作 / 改窗口尺寸后同步接触点几何。
///
/// `off_y`  = 视频里角色的接地线距窗口顶部的物理像素距离
/// `char_h` = 角色在屏幕上的实际高度（物理像素）
/// `dpi`    = devicePixelRatio，用来换算吸附半径
#[tauri::command]
fn set_pet_contact(
    off_y: f64,
    char_h: f64,
    dpi: f64,
    granular: Option<String>,
    state: tauri::State<'_, Shared>,
) {
    let mut app = state.lock().unwrap();
    app.pet.contact_off = off_y.max(0.0);
    app.pet.char_h = char_h.max(0.0);
    app.pet.dpi = if dpi > 0.0 { dpi } else { 1.0 };
    if let Some(g) = granular {
        app.granular = g;
    }
}

/// 前端算好的 alpha 掩膜（MASK_N × MASK_N，1 = 角色像素）
#[tauri::command]
fn set_pet_mask(w: usize, h: usize, data: Vec<u8>, state: tauri::State<'_, Shared>) {
    let mut app = state.lock().unwrap();
    if w == 0 || h == 0 || data.len() != w * h {
        app.pet.mask = None;
        return;
    }
    app.pet.mask = Some(Mask { w, h, data });
    app.pet.mask_seen = true;
}

/// 开发者模式：写一个「坐姿 × 尺寸档」的吸附偏移（逻辑像素，正数往下压）。
///
/// 只作用在一个角色身上 —— Raven 和 Suki 的坐姿素材贴地线差得很多
/// （正坐 20/27/40 vs 61/79/120），放同一组数字里必然有一个是错的。
///
/// **`character` 必须由前端传**：面板里"切角色标签"和"拖滑杆"是两条并行的
/// invoke，`save_cfg(activeChar)` 可能比滑杆晚到，用 Rust 侧的 active_char
/// 就会把 A 角色的数值写进 B 角色（实测真的撞过一次，raven/suki 互串）。
#[tauri::command]
fn set_snap_offset(
    kind: String,
    size: String,
    value: f64,
    character: Option<String>,
    state: tauri::State<'_, Shared>,
) -> serde_json::Value {
    let mut app = state.lock().unwrap();
    let idx = size_index(&size);
    let active = match character {
        Some(c) if CHARACTERS.iter().any(|m| m.id == c) => c,
        _ => app.cfg.active_char.clone(),
    };
    let value = value.clamp(-SNAP_LIMIT, SNAP_LIMIT);
    {
        let set = app.cfg.snap_offsets.entry(active.clone()).or_default();
        match kind.as_str() {
            "side" => set.side[idx] = value,
            "duck" => set.duck[idx] = value,
            "stand" => set.stand[idx] = value,
            _ => set.upright[idx] = value,
        }
    }
    app.save();
    let set = app
        .cfg
        .snap_offsets
        .get(&active)
        .copied()
        .unwrap_or_default();
    serde_json::json!({
        "character": active,
        "size": app.cfg.size,
        "snapOffsets": set,
    })
}

/// 开发者模式：切换桌面窗尺寸档（物理像素 256 / 384 / 512，与单体桌宠一致）。
///
/// 窗口是"容器本身"而不是"1024 大画布"，所以换档等于换窗口大小。
/// 换完保持**接触点不动**（按新旧高度比例估一次），随后前端 resize 会回报真实
/// 接触线，轮询线程据此把窗口重新坐回原来的边。
#[tauri::command]
fn set_pet_size(
    size: String,
    app_handle: AppHandle,
    state: tauri::State<'_, Shared>,
) -> serde_json::Value {
    let size = normalize_size(&size);
    let px = size_physical(&size);
    let Some(win) = app_handle.get_webview_window("pet") else {
        return serde_json::json!({ "size": size, "px": px, "ok": false });
    };

    // ——— 锁外先量旧的几何 ———
    let old_pos = win.outer_position().ok();
    let old_h = win.outer_size().map(|s| s.height as f64).unwrap_or(px as f64);

    let (off_y, off_ratio) = {
        let mut app = match state.lock() {
            Ok(g) => g,
            Err(_) => return serde_json::json!({ "size": size, "px": px }),
        };
        app.cfg.size = size.clone();
        app.save();
        let off_y = app.pet.contact_off_y(old_h);
        let ratio = if old_h > 1.0 {
            (off_y / old_h).clamp(0.0, 1.5)
        } else {
            GROUND_RATIO
        };
        (off_y, ratio)
    };

    let _ = win.set_size(Size::Physical(PhysicalSize::new(px, px)));

    // 保持接触点：新窗口顶 = 旧接触点 − 新窗口的接触线高度
    if let Some(p) = old_pos {
        let contact_y = p.y as f64 + off_y;
        let new_off = (px as f64) * off_ratio;
        let top = (contact_y - new_off).round() as i32;
        // 水平保中心：窗口是以接触点为中心摆的，换档后左沿要跟着退
        let left = (p.x as f64 + old_h / 2.0 - px as f64 / 2.0).round() as i32;
        let _ = win.set_position(Position::Physical(PhysicalPosition::new(left, top)));
    }

    // 图层的尺寸由前端按 innerWidth 重算，这里只把状态清干净让轮询重新应用
    if let Ok(mut app) = state.lock() {
        app.pet.applied = None;
    }
    let _ = app_handle.emit("pet:size", serde_json::json!({ "size": size, "px": px }));

    serde_json::json!({ "size": size, "px": px })
}

/// 开始拖拽：记下“光标落在角色身上的哪个位置”，之后的位移由轮询线程算。
///
/// `off_x` / `off_y` 由前端按 pointerdown 时的窗口内坐标（× devicePixelRatio）给出。
/// **不要**用当前光标减窗口位置来推：这个命令是在指针移动超过阈值之后才调的，
/// 那一刻光标已经离开按下点了，算出来的偏移会永久带一个“阈值位移”，
/// 表现为拖拽全程慢半拍（松手后还差几十像素）。
#[tauri::command]
fn pet_drag_start(
    win: WebviewWindow,
    off_x: Option<f64>,
    off_y: Option<f64>,
    state: tauri::State<'_, Shared>,
) {
    // 窗口 API 必须在锁外调用，否则会和主线程上的其他 command 互锁
    let cursor = win.cursor_position().ok();
    let pos = win.outer_position().ok();

    let drag_off = match (off_x, off_y) {
        // 前端给的偏移最准，直接采用
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 => (x, y),
        // 兜底：光标减窗口左上角
        _ => match (cursor, pos) {
            (Some(c), Some(p)) => (c.x - p.x as f64, c.y - p.y as f64),
            _ => return,
        },
    };

    let mut app = state.lock().unwrap();
    let pet = &mut app.pet;
    pet.dragging = true;
    pet.mode = Mode::Drag;
    pet.perch = None;
    pet.vy = 0.0;
    pet.fall_start_y = None;
    pet.fall_follow = None;
    pet.drag_off = drag_off;
}

/// 松开鼠标：按设置吸附 / 开始下落 / 原地停住。
#[tauri::command]
fn pet_drag_end(
    win: WebviewWindow,
    app_handle: AppHandle,
    state: tauri::State<'_, Shared>,
) {
    // ——— 锁外：先把需要的窗口几何拿到 ———
    let outer = win.outer_position().ok();
    let size = win.outer_size().ok();
    // 松手这一刻的光标比窗口位置更准：轮询线程可能还差一帧才把窗口挪到位，
    // 直接读 outer_position 会让吸附点偏出十几到几十像素。
    let cursor = win.cursor_position().ok();
    let win_h = size.map(|s| s.height as f64).unwrap_or(340.0);
    let win_w = size.map(|s| s.width as f64).unwrap_or(340.0);

    // ——— 锁内：只更新状态，不碰窗口 ———
    let (off_y, cx, cy, snap_on, gravity_on, shift) = {
        let mut app = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if !app.pet.dragging {
            return;
        }
        app.pet.dragging = false;
        app.save();
        let off_y = app.pet.contact_off_y(win_h);
        let shift = app.pet.snap_shift(&app.cfg, &app.granular.clone());
        let Some(p) = outer else {
            app.pet.mode = Mode::Free;
            return;
        };
        // 优先用「松手时光标 − 抓取偏移」还原窗口左上角，其次退回窗口回读值
        let top_left_x = cursor.map(|c| c.x - app.pet.drag_off.0).unwrap_or(p.x as f64);
        let top_left_y = cursor.map(|c| c.y - app.pet.drag_off.1).unwrap_or(p.y as f64);
        (
            off_y,
            top_left_x + win_w / 2.0,
            top_left_y + off_y,
            app.cfg.snap,
            app.cfg.gravity,
            shift,
        )
    }; // ← 锁在这里释放

    // ——— 锁外：找吸附目标（EnumWindows 属于窗口 API，不能持锁） ———
    let perch = if snap_on {
        let (radius, char_h) = {
            let app = match state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            (app.pet.snap_radius(), app.pet.char_px(win_h))
        };
        find_snap(cx, cy, radius, char_h)
    } else {
        None
    };

    // 目标位置也在锁外查
    let target = perch.as_ref().and_then(|p| match p.kind {
        PerchKind::Taskbar => win::taskbar_top().map(|t| (p.offset_x, t)),
        PerchKind::Window => win::window_rect(p.hwnd).map(|r| (r.left + p.offset_x, r.top)),
    });

    if let (Some(p), Some((tx, ty))) = (perch, target) {
        // 立刻贴上去，别等下一帧
        let left = tx - win_w / 2.0;
        let top = ty - off_y + shift;
        let _ = win.set_position(Position::Physical(PhysicalPosition::new(
            left.round() as i32,
            top.round() as i32,
        )));
        if let Ok(mut app) = state.lock() {
            app.pet.applied = Some((left, top));
            app.pet.perch = Some(p);
            app.pet.perch_last = None;
            app.pet.perch_still = 0;
            app.pet.perch_lost = 0;
            app.pet.mode = Mode::Perched;
            app.pet.vy = 0.0;
            app.pet.fall_start_y = None;
            app.pet.fall_follow = None;
        }
    } else if gravity_on {
        // 从松手这一刻就开始掉
        if let Ok(mut app) = state.lock() {
            app.pet.mode = Mode::Falling;
            app.pet.perch = None;
            app.pet.vy = 0.0;
            app.pet.applied = None;
            app.pet.fall_start_y = Some(cy);
            app.pet.fall_follow = None;
            app.pet.panic_fired = false;
        }
    } else if let Ok(mut app) = state.lock() {
        app.pet.mode = Mode::Free;
        app.pet.applied = None;
        app.pet.fall_start_y = None;
        app.pet.fall_follow = None;
    }

    let _ = app_handle;
}

/// 切换「重力 / 吸附」后立刻重算一次当前状态。
///
/// 关闭两种设置 → 原地停住；开重力 → 从现在的位置开始掉；
/// 开吸附 → 先从当前位置试一次吸边，吸不上就按重力处理。
#[tauri::command]
fn pet_physics(
    app_handle: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<serde_json::Value, String> {
    let pet_win = app_handle
        .get_webview_window("pet")
        .ok_or_else(|| "未找到桌面角色窗口".to_string())?;
    let pos = pet_win.outer_position().map_err(|e| e.to_string())?;
    let size = pet_win.outer_size().map_err(|e| e.to_string())?;
    let win_h = size.height as f64;

    let (off_y, cx, cy, snap_on, gravity_on, shift, radius, char_h) = {
        let app = state.lock().map_err(|_| "配置锁不可用".to_string())?;
        let off_y = app.pet.contact_off_y(win_h);
        (
            off_y,
            pos.x as f64 + size.width as f64 / 2.0,
            pos.y as f64 + off_y,
            app.cfg.snap,
            app.cfg.gravity,
            app.pet.snap_shift(&app.cfg, &app.granular.clone()),
            app.pet.snap_radius(),
            app.pet.char_px(win_h),
        )
    };

    let perch = if snap_on {
        find_snap(cx, cy, radius, char_h)
    } else {
        None
    };
    let target = perch.as_ref().and_then(|p| match p.kind {
        PerchKind::Taskbar => win::taskbar_top().map(|t| (p.offset_x, t)),
        PerchKind::Window => win::window_rect(p.hwnd).map(|r| (r.left + p.offset_x, r.top)),
    });

    let mut moved = false;
    if let (Some(p), Some((tx, ty))) = (perch, target) {
        let left = tx - size.width as f64 / 2.0;
        let top = ty - off_y + shift;
        let _ = pet_win.set_position(Position::Physical(PhysicalPosition::new(
            left.round() as i32,
            top.round() as i32,
        )));
        let mut app = state.lock().map_err(|_| "配置锁不可用".to_string())?;
        app.pet.applied = Some((left, top));
        app.pet.perch = Some(p);
        app.pet.perch_last = None;
        app.pet.perch_still = 0;
        app.pet.perch_lost = 0;
        app.pet.mode = Mode::Perched;
        app.pet.vy = 0.0;
        app.pet.fall_start_y = None;
        app.pet.fall_follow = None;
        moved = true;
    } else {
        let mut app = state.lock().map_err(|_| "配置锁不可用".to_string())?;
        app.pet.perch = None;
        if gravity_on {
            app.pet.mode = Mode::Falling;
            app.pet.vy = 0.0;
            app.pet.applied = None;
            app.pet.fall_start_y = Some(cy);
            app.pet.fall_follow = None;
            app.pet.panic_fired = false;
            moved = true;
        } else {
            app.pet.mode = Mode::Free;
            app.pet.applied = None;
            app.pet.fall_start_y = None;
            app.pet.fall_follow = None;
        }
    }

    Ok(serde_json::json!({ "ok": true, "moved": moved }))
}

/// 诊断用：现在有没有检测到全屏、命中来源、是否已静默。
/// 不依赖物理轮询线程，随时可以单独调用。
#[tauri::command]
fn fullscreen_probe(state: tauri::State<'_, Shared>) -> serde_json::Value {
    let (enabled, hidden, title) = match state.lock() {
        Ok(s) => (
            s.cfg.fullscreen_hide,
            s.fullscreen_hidden,
            s.fullscreen_title.clone(),
        ),
        Err(_) => return serde_json::Value::Null,
    };
    let hit = win::foreground_fullscreen(win::current_pid());
    serde_json::json!({
        "enabled": enabled,
        "hidden": hidden,
        "title": title,
        "hit": hit.map(|h| serde_json::json!({
            "title": h.title,
            "source": h.source,
            "hwnd": h.hwnd,
        })),
    })
}

/// 诊断用：当前物理状态 + 可坐窗口列表 + 每个窗口被拒的原因
#[tauri::command]
fn pet_debug(state: tauri::State<'_, Shared>) -> serde_json::Value {
    let (mode, snap, gravity, radius, off_y, char_h, perch, mask_seen, ignored, dragging, applied, ticks, last_cursor, drag_off, granular, size, shift, fs_hidden) = {
        let app = match state.lock() {
            Ok(g) => g,
            Err(_) => return serde_json::Value::Null,
        };
        (
            format!("{:?}", app.pet.mode),
            app.cfg.snap,
            app.cfg.gravity,
            app.pet.snap_radius(),
            app.pet.contact_off,
            app.pet.char_h,
            app.pet.perch.as_ref().map(|p| {
                serde_json::json!({
                    "hwnd": p.hwnd,
                    "kind": format!("{:?}", p.kind),
                    "offsetX": p.offset_x,
                })
            }),
            app.pet.mask_seen,
            app.pet.ignoring,
            app.pet.dragging,
            app.pet.applied.map(|(x, y)| serde_json::json!({ "x": x, "y": y })),
            app.pet.ticks,
            app.pet.last_cursor.map(|(x, y)| serde_json::json!({ "x": x, "y": y })),
            serde_json::json!({ "x": app.pet.drag_off.0, "y": app.pet.drag_off.1 }),
            app.granular.clone(),
            app.cfg.size.clone(),
            app.pet.snap_shift(&app.cfg, &app.granular),
            app.fullscreen_hidden,
        )
    };

    serde_json::json!({
        "mode": mode,
        "snap": snap,
        "gravity": gravity,
        "snapRadius": radius,
        "contact": { "offY": off_y, "charH": char_h },
        "perch": perch,
        "maskSeen": mask_seen,
        "ignoring": ignored,
        "dragging": dragging,
        "applied": applied,
        "granular": granular,
        "size": size,
        "snapShift": shift,
        "fullscreenHidden": fs_hidden,
        "ticks": ticks,
        "lastCursor": last_cursor,
        "dragOff": drag_off,
        "cursorNow": win::cursor_pos().map(|(x, y)| serde_json::json!({ "x": x, "y": y })),
        "taskbarTop": win::taskbar_top(),
        "windows": win::list_windows(win::current_pid(), 0)
            .into_iter()
            .take(12)
            .map(|w| serde_json::json!({
                "hwnd": w.hwnd, "z": w.z, "top": w.top, "left": w.left,
                "right": w.right, "bottom": w.bottom, "title": w.title,
            }))
            .collect::<Vec<_>>(),
        "probe": win::list_windows_debug(win::current_pid(), 0)
            .into_iter()
            .map(|(title, ok, reason)| serde_json::json!({
                "title": title, "ok": ok, "reason": reason,
            }))
            .collect::<Vec<_>>(),
    })
}

// ————————————————————————— 轮询线程 —————————————————————————

/// 第一阶段（锁内）算出的“这轮要查什么”
enum PollNeed {
    Idle,
    /// 拖拽：需要把窗口中心跟到 (cx, cy)
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
        /// 支撑被抽走时仍要跟着宿主横向平移，`(hwnd, offset_x)`
        follow: Option<(isize, f64)>,
    },
}

/// 第二阶段（锁外）查到的系统信息，供第三阶段（锁内）决策
enum PollSys {
    None,
    Center((f64, f64)),
    PerchPos {
        tx: f64,
        ty: f64,
        span: Option<(f64, f64)>,
    },
    PerchGone,
    FallBounds {
        lx: f64,
        rx: f64,
        ground_y: f64,
        win_tops: Vec<WinTop>,
    },
}

/// 第一阶段锁内的状态快照，第三阶段用它在决策前校验“期间状态没被 command 改过”
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

            // 全屏静默中：窗口是隐藏的，前端视频解码也已释放。
            // 这一轮连光标/窗口几何都不查，纯粹空转，退出全屏时由监视线程叫醒。
            let fullscreen_hidden = match shared.lock() {
                Ok(s) => s.fullscreen_hidden,
                Err(_) => false,
            };
            if fullscreen_hidden {
                tick = IDLE_TICK_MS;
                continue;
            }

            let Some(webview) = app.get_webview_window("pet") else {
                tick = IDLE_TICK_MS;
                continue;
            };
            // 锁外：窗口几何。直接 Win32，不走 Tauri 主线程 —— cursor_position /
            // outer_position / outer_size 都是 send_user_message 后同步等主线程消息循环，
            // 每 tick 白等三轮；GetCursorPos / GetWindowRect 是纯 user32 调用，微秒级返回。
            let (Some(cursor), Some((wx, wy, ww, wh))) =
                (win::cursor_pos(), win::raw_rect(self_hwnd))
            else {
                tick = IDLE_TICK_MS;
                continue;
            };
            let wpos = (wx, wy);
            let wsize = (ww, wh);

            // 窗口尺寸被改过（换 DPI / 换缩放），接触点几何要按新高度重算
            if wsize.1 <= 1.0 || wsize.0 <= 1.0 {
                tick = IDLE_TICK_MS;
                continue;
            }

            // ——— 阶段1：锁内只读快照，产出“要查什么”（纯内存） ———
            let (snap, dt) = {
                let mut state = match shared.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        tick = IDLE_TICK_MS;
                        continue;
                    }
                };
                state.pet.ticks += 1;
                state.pet.last_cursor = Some(cursor);
                let now = Instant::now();
                let dt = now
                    .duration_since(state.pet.last_tick)
                    .as_secs_f64()
                    // 空闲节拍 80ms 下单步会更大，上限放宽到 0.09，否则下落积分被截断
                    .clamp(0.001, 0.09);
                state.pet.last_tick = now;

                let off_y = state.pet.contact_off_y(wsize.1);
                let need = if state.pet.dragging {
                    let (ox, oy) = state.pet.drag_off;
                    PollNeed::Drag {
                        cx: cursor.0 - ox + wsize.0 / 2.0,
                        cy: cursor.1 - oy + wsize.1 / 2.0,
                    }
                } else if state.pet.mode == Mode::Perched {
                    match state.pet.perch.clone() {
                        Some(p) => PollNeed::Perch {
                            hwnd: p.hwnd,
                            kind: p.kind,
                            offset_x: p.offset_x,
                        },
                        None => PollNeed::Idle,
                    }
                } else if state.pet.mode == Mode::Falling {
                    PollNeed::Fall {
                        cx: wpos.0 + wsize.0 / 2.0,
                        cy: wpos.1 + off_y,
                        char_h: state.pet.char_px(wsize.1),
                        follow: state.pet.fall_follow,
                    }
                } else {
                    PollNeed::Idle
                };

                let snap = PollSnap {
                    mode: state.pet.mode,
                    dragging: state.pet.dragging,
                    perch_hwnd: state.pet.perch.as_ref().map(|p| p.hwnd),
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
                    let (lx, mon_top, rx, lb) = win::monitor_bounds(cx, cy);
                    let ground_y = win::taskbar_top().unwrap_or(lb);
                    // 支撑被抽走的那种下落：横向继续跟着宿主，别原地直坠
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
                    // 可落窗口上边缘：接触点落在窗口水平范围内、头顶留得下才算
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
                    win_tops.sort_by(|a, b| {
                        a.top
                            .partial_cmp(&b.top)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
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
                let mut state = match shared.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        tick = IDLE_TICK_MS;
                        continue;
                    }
                };

                // 快照校验：阶段1→3 之间 mode/dragging/perch 若被 command 改过
                // （松手、切配置等），基于旧快照的查询结果已失效，丢弃本轮
                if state.pet.mode != snap.mode || state.pet.dragging != snap.dragging {
                    None
                } else if snap.perch_hwnd != state.pet.perch.as_ref().map(|p| p.hwnd) {
                    None
                } else {
                    let granular = state.granular.clone();
                    let snap_shift = state.pet.snap_shift(&state.cfg, &granular);
                    let mut plan = Plan::default();
                    let mut acted = false;

                    match sys {
                        // 拖拽：窗口跟随光标
                        PollSys::Center((cx, cy)) if state.pet.dragging => {
                            plan.pos = Some((
                                (cx - wsize.0 / 2.0).round(),
                                (cy - wsize.1 / 2.0).round(),
                            ));
                            if state.pet.ignoring {
                                state.pet.ignoring = false;
                                plan.ignore = Some(false);
                            }
                            acted = true;
                        }
                        // 坐在边上：跟随宿主矩形 + 命中判定（坐着的桌宠也要能被抓走）
                        PollSys::PerchPos { tx, ty, span } if state.pet.mode == Mode::Perched => {
                            state.pet.perch_lost = 0;
                            let off_y = state.pet.contact_off_y(wsize.1);

                            // 支撑判定 —— 坐在窗口上沿，支撑就是“上沿还在脚底下”：
                            //  · 上沿往下走 → 平台从脚底抽走，跟着掉（不是黏在一起）
                            //  · 上沿往上顶   → 把桌宠跟着顶上去
                            //  · 窗口横向缩到装不下接触点 → 能坐的地方没了，往下掉
                            let dropped = match state.pet.perch_last {
                                // 2px 容差：set_position 取整写回，上沿读数会有零点几像素抖动
                                Some((_, py)) => ty > py + 2.0,
                                None => false,
                            };
                            let horiz_gone = match (&state.pet.perch, span) {
                                (Some(p), Some((l, r))) => {
                                    l + p.offset_x > r - 8.0 || l + p.offset_x < l + 4.0
                                }
                                // 任务栏没有 span，永远坐得下
                                _ => false,
                            };

                            // 只有开了重力才“脱手”；吸附模式下本来就该黏着宿主一起动
                            if state.cfg.gravity && (dropped || horiz_gone) {
                                let hwnd =
                                    state.pet.perch.as_ref().map(|p| p.hwnd).unwrap_or(0);
                                let off =
                                    state.pet.perch.as_ref().map(|p| p.offset_x).unwrap_or(0.0);
                                let fall_start = ty + snap_shift;
                                state.pet.perch = None;
                                state.pet.perch_last = None;
                                state.pet.perch_still = 0;
                                state.pet.applied = None;
                                state.pet.mode = Mode::Falling;
                                state.pet.vy = 0.0;
                                state.pet.fall_start_y = Some(fall_start);
                                state.pet.panic_fired = false;
                                // 平台被抽走：下落时继续跟着宿主横移（同一竖列往下掉）
                                // 支撑范围没了：真自由落体，掉到下面那个窗口/任务栏
                                state.pet.fall_follow = if !horiz_gone && hwnd != 0 {
                                    Some((hwnd, off))
                                } else {
                                    None
                                };
                                acted = true;
                            } else {
                                // 宿主是否在移动：拿夹紧前的原始接触点和上一轮比，决定下轮档位
                                let moved = match state.pet.perch_last {
                                    Some((px, py)) => {
                                        (px - tx).abs() > 0.5 || (py - ty).abs() > 0.5
                                    }
                                    None => true,
                                };
                                if moved {
                                    state.pet.perch_last = Some((tx, ty));
                                    state.pet.perch_still = 0;
                                } else {
                                    state.pet.perch_still += 1;
                                }
                                let mut tx = tx;
                                if let Some((l, r)) = span {
                                    // clamp 在 min > max 时会 panic（窗口被拖得极窄），
                                    // 这里用 max/min 自己夹，绝不炸轮询线程
                                    let lo = l + 8.0;
                                    let hi = (r - 8.0).max(lo);
                                    tx = tx.max(lo).min(hi);
                                }
                                let left = tx - wsize.0 / 2.0;
                                let top = ty - off_y + snap_shift;
                                if state
                                    .pet
                                    .applied
                                    .map(|(x, y)| (x - left).abs() > 0.5 || (y - top).abs() > 0.5)
                                    .unwrap_or(true)
                                {
                                    plan.pos = Some((left.round(), top.round()));
                                    state.pet.applied = Some((left, top));
                                }
                                // 关键：坐姿态也必须按掩膜判定穿透，否则整个透明容器都可点
                                update_ignore(
                                    &mut state.pet,
                                    (cursor.0, cursor.1),
                                    (wpos.0, wpos.1),
                                    (wsize.0, wsize.1),
                                    &mut plan,
                                );
                                acted = true;
                            }
                        }
                        // 宿主被关掉 / 最小化 / 最大化：单轮读不到不算，攒够再掉
                        PollSys::PerchGone if state.pet.mode == Mode::Perched => {
                            state.pet.perch_lost += 1;
                            // 计数期间保持 60Hz，别在 80ms 档上慢慢数
                            state.pet.perch_still = 0;
                            if state.pet.perch_lost >= PERCH_LOST_TICKS {
                                state.pet.perch = None;
                                state.pet.perch_lost = 0;
                                state.pet.perch_last = None;
                                state.pet.perch_still = 0;
                                state.pet.applied = None;
                                state.pet.fall_follow = None;
                                let fall = state.cfg.gravity;
                                let fall_start = wpos.1 + state.pet.contact_off_y(wsize.1);
                                state.pet.mode = if fall { Mode::Falling } else { Mode::Free };
                                state.pet.vy = 0.0;
                                state.pet.fall_start_y = if fall { Some(fall_start) } else { None };
                                state.pet.panic_fired = false;
                            }
                            acted = true;
                        }
                        // 重力下落
                        PollSys::FallBounds {
                            lx,
                            rx,
                            ground_y,
                            win_tops,
                        } if state.pet.mode == Mode::Falling => {
                            let off_y = state.pet.contact_off_y(wsize.1);
                            let char_h = state.pet.char_px(wsize.1);
                            let dpi = state.pet.dpi.max(0.5);
                            // 先按显示器夹紧再算任何相对量：offset_x 必须是“夹紧后”的
                            // 接触点相对窗口左沿的偏移，否则窗口贴着屏幕边时 offset_x 会
                            // 落到窗口范围之外，坐下第一帧就被判成“支撑没了”又掉下去
                            let cx = (wpos.0 + wsize.0 / 2.0).clamp(lx, rx);
                            let mut cy = wpos.1 + off_y;
                            let prev_cy = cy;
                            let gravity_px = 9.8 * (char_h / 1.6);
                            let max_speed = MAX_FALL_PER_H * char_h;
                            let bounce_min = BOUNCE_MIN_PER_H * char_h;
                            let panic_drop = PANIC_MIN_DROP_RATIO * char_h;

                            state.pet.vy = (state.pet.vy + gravity_px * dt).min(max_speed);
                            cy += state.pet.vy * dt;

                            // 距任务栏接触点 ≤5px 就提前播慌张；不等这一帧真正落地。
                            // 若中间还有窗口上沿可接住，则不提前触发，避免落窗也慌张
                            if state.pet.vy > 0.0 && !state.pet.panic_fired {
                                let gap = ground_y - cy;
                                let window_ahead = win_tops
                                    .iter()
                                    .any(|wt| wt.top >= cy && wt.top <= ground_y);
                                if gap > 0.0
                                    && gap <= PANIC_TRIGGER_AHEAD_PX * dpi
                                    && !window_ahead
                                {
                                    let drop = state
                                        .pet
                                        .fall_start_y
                                        .map(|start| cy - start)
                                        .unwrap_or(0.0);
                                    if drop > panic_drop {
                                        state.pet.panic_fired = true;
                                        plan.panic = true;
                                    }
                                }
                            }

                            // 这一帧穿越的可落边：任务栏地面 + 窗口上边缘，取 y 最小的
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

                            // 窗口上边缘：只认“这一帧真正穿越”的边（prev_cy..=cy），
                            // 外加 2px 容差，避免量化误差导致永远跨不过去
                            const EDGE_TOL: f64 = 2.0;
                            if state.pet.vy > 0.0 {
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
                                // 弹起来的高度看得见才弹，剩下的能量不足就直接坐稳
                                let up = state.pet.vy.max(0.0) * RESTITUTION;
                                if up > bounce_min {
                                    state.pet.vy = -up;
                                } else {
                                    state.pet.vy = 0.0;
                                    state.pet.mode = Mode::Perched;
                                    // 只有从很高处落到**任务栏**才触发慌张；
                                    // 窗口上沿落座、以及矮距离落下都保持正常姿态
                                    let drop = state
                                        .pet
                                        .fall_start_y
                                        .map(|start| cy - start)
                                        .unwrap_or(0.0);
                                    if lp.kind == PerchKind::Taskbar
                                        && drop > panic_drop
                                        && !state.pet.panic_fired
                                    {
                                        plan.panic = true;
                                    }
                                    state.pet.panic_fired = false;
                                    state.pet.fall_start_y = None;
                                    state.pet.perch = Some(lp);
                                    state.pet.perch_last = None;
                                    state.pet.perch_still = 0;
                                    state.pet.perch_lost = 0;
                                    state.pet.fall_follow = None;
                                }
                            }

                            let left = cx - wsize.0 / 2.0;
                            let shift = if state.pet.mode == Mode::Perched {
                                snap_shift
                            } else {
                                0.0
                            };
                            let top = cy - off_y + shift;
                            plan.pos = Some((left.round(), top.round()));
                            state.pet.applied = Some((left, top));
                            if state.pet.ignoring {
                                state.pet.ignoring = false;
                                plan.ignore = Some(false);
                            }
                            acted = true;
                        }
                        // 空闲：命中判定 → 穿透开关
                        PollSys::None => {
                            update_ignore(
                                &mut state.pet,
                                (cursor.0, cursor.1),
                                (wpos.0, wpos.1),
                                (wsize.0, wsize.1),
                                &mut plan,
                            );
                            acted = true;
                        }
                        _ => {}
                    }

                    if !acted {
                        None
                    } else {
                        let next = match state.pet.mode {
                            Mode::Drag | Mode::Falling => DRAG_TICK_MS,
                            // 坐在边上：宿主在动就 60Hz 跟手，静止就降到空闲档省电
                            Mode::Perched => {
                                if state.pet.perch_still >= PERCH_STILL_TICKS {
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
                    let _ = webview.set_position(Position::Physical(PhysicalPosition::new(
                        x as i32, y as i32,
                    )));
                }
                if let Some(v) = plan.ignore {
                    let _ = webview.set_ignore_cursor_events(v);
                    let _ = app.emit("pet:interactive", !v);
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

// ————————————————————————— 全屏静默 —————————————————————————

/// 全屏检测的轮询间隔。`GetForegroundWindow` + `GetWindowRect` 都是微秒级，
/// 但没必要跟物理轮询一样 60Hz —— 用户切进/切出全屏不会在 0.1 秒内反复横跳。
const FULLSCREEN_TICK_MS: u64 = 600;
/// 连续命中多少轮才隐藏（≈1.8 秒）。Alt+Tab 闪一下、截图工具抢一下焦点，
/// 都不该把桌宠收走又弹回来。
const FULLSCREEN_ENTER_TICKS: u32 = 3;

/// 把窗口左上角夹进「窗口中心所在那块显示器」的可见范围。
///
/// 横向按整窗算；纵向只要求**接触点（脚底）**落在屏幕内 —— 窗口在接地线以下
/// 还有约 14% 的透明留白，本来就是挂在屏幕外的，按窗口底边夹会把她整体抬起
/// 11px，正好破坏贴地。
fn clamp_pet_pos(x: f64, y: f64, w: f64, h: f64, off_y: f64) -> (f64, f64) {
    let (lx, mt, rx, lb) = win::monitor_bounds(x + w / 2.0, y + h / 2.0);
    let nx = x.clamp(lx, (rx - w).max(lx));
    let lo = mt - off_y;
    let hi = (lb - off_y).max(lo);
    let ny = y.clamp(lo, hi);
    (nx, ny)
}

/// 进入 / 退出全屏静默：改状态 → 显示或隐藏桌宠窗口 → 通知两个前端释放 / 恢复解码。
fn set_fullscreen_hidden(
    app: &AppHandle,
    shared: &Shared,
    self_hwnd: isize,
    hidden: bool,
    title: &str,
) {
    let restore = {
        let mut state = match shared.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if state.fullscreen_hidden == hidden {
            return;
        }
        state.fullscreen_hidden = hidden;
        state.fullscreen_title = if hidden { title.to_string() } else { String::new() };
        // 藏起来的这段时间窗口不会被我们自己挪动，恢复后按当前位置重新贴合
        state.pet.applied = None;
        if hidden {
            state.fullscreen_saved_pos = win::raw_rect(self_hwnd).map(|(x, y, _, _)| (x, y));
            None
        } else {
            state.fullscreen_saved_pos.take()
        }
    };

    if let Some(pet) = app.get_webview_window("pet") {
        if hidden {
            let _ = pet.hide();
        } else {
            // 先摆回静默前的位置，再露脸，避免在错的地方闪一下
            if let Some((sx, sy)) = restore {
                if let Some((_, _, w, h)) = win::raw_rect(self_hwnd) {
                    let off_y = match shared.lock() {
                        Ok(s) => s.pet.contact_off_y(h),
                        Err(_) => h * GROUND_RATIO,
                    };
                    let (nx, ny) = clamp_pet_pos(sx, sy, w, h, off_y);
                    if (nx - sx).abs() > 0.5 || (ny - sy).abs() > 0.5 {
                        eprintln!(
                            "[fullscreen] 静默前落点 ({sx:.0},{sy:.0}) 已在屏幕外，复位到 ({nx:.0},{ny:.0})"
                        );
                    }
                    let _ = pet.set_position(Position::Physical(PhysicalPosition::new(
                        nx.round() as i32,
                        ny.round() as i32,
                    )));
                }
            }
            let _ = pet.show();
        }
    }

    // 两个窗口都要停：主面板里也有一路 alpha 视频在解码
    let _ = app.emit(
        "pet:fullscreen",
        serde_json::json!({ "hidden": hidden, "title": title }),
    );
    if hidden {
        eprintln!("[fullscreen] 进入全屏，桌宠静默：{title}");
    } else {
        eprintln!("[fullscreen] 退出全屏，恢复桌宠");
    }
}

/// 全屏监视线程：只看前台窗口，命中就静默，退出就恢复。
fn spawn_fullscreen_watcher(app: AppHandle, shared: Shared, self_hwnd: isize) {
    std::thread::spawn(move || {
        let mut hits: u32 = 0;
        let mut hidden = false;
        loop {
            std::thread::sleep(Duration::from_millis(FULLSCREEN_TICK_MS));

            // 开关关掉时什么都不做；如果正在静默，立刻恢复
            let enabled = match shared.lock() {
                Ok(s) => s.cfg.fullscreen_hide,
                Err(_) => continue,
            };
            if !enabled {
                hits = 0;
                if hidden {
                    set_fullscreen_hidden(&app, &shared, self_hwnd, false, "");
                    hidden = false;
                }
                continue;
            }

            match win::foreground_fullscreen(win::current_pid()) {
                Some(hit) => {
                    hits = (hits + 1).min(1000);
                    if !hidden && hits >= FULLSCREEN_ENTER_TICKS {
                        set_fullscreen_hidden(&app, &shared, self_hwnd, true, &hit.title);
                        hidden = true;
                        eprintln!("[fullscreen] 命中来源：{}", hit.source);
                    }
                }
                None => {
                    hits = 0;
                    if hidden {
                        set_fullscreen_hidden(&app, &shared, self_hwnd, false, "");
                        hidden = false;
                    }
                }
            }
        }
    });
}

/// 启动时把桌面角色窗口放到主显示器右下角的**任务栏上**。
///
/// 注意对齐的是「接触点」而不是窗口底边：角色脚下在画面的 86.1% 处，
/// 按窗口底边对齐会让她悬空 59px。
fn place_pet_default(app: &AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        let size = match pet.outer_size() {
            Ok(s) => s,
            Err(_) => return,
        };
        let monitor = match pet.primary_monitor() {
            Ok(Some(m)) => m,
            _ => return,
        };
        let work = monitor.work_area();
        let off = (size.height as f64 * GROUND_RATIO).round() as i32;
        let x = work.position.x + work.size.width as i32 - size.width as i32 - 12;
        let y = work.position.y + work.size.height as i32 - off;
        let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// dev 构建的兜底：`cargo tauri dev` 会把 devUrl 烘进二进制，**且不内嵌前端资源**。
///
/// 之后如果直接双击这个 exe（而 dev 服务器已经关掉），两个窗口都只会显示
/// `ERR_CONNECTION_REFUSED` 的空白页 —— 表现就是「桌宠不见了」，而且进程还活着、
/// 窗口也可见，特别难查。这种构建里 `tauri.localhost` 下什么资源都没有，
/// 所以救不回来资源，只能把原因直接写在窗口里，别让人对着空白屏猜。
fn rescue_from_dead_dev_server(app: &AppHandle) {
    let Some(dev) = app.config().build.dev_url.clone() else {
        return;
    };
    let host = dev.host_str().unwrap_or("127.0.0.1");
    let port = dev.port_or_known_default().unwrap_or(80);
    let Ok(addr) = format!("{host}:{port}").parse::<std::net::SocketAddr>() else {
        return;
    };
    if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
        return;
    }

    eprintln!("[duo] dev 服务器 {dev} 连不上，这个构建没有内嵌前端资源，无法恢复");
    let msg = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <body style=\"margin:0;padding:14px;font:13px/1.7 'Microsoft YaHei',sans-serif;\
         color:#fff;background:rgba(24,20,26,.92);border-radius:10px\">\
         <b>前端资源没有内嵌进这个构建</b><br>\
         这个 exe 是用 <code>cargo tauri dev</code> 编的，dev 服务器（{dev}）已经关掉了。<br>\
         请在 <code>src-tauri</code> 里执行 <code>cargo build</code> 重新构建，再运行 exe。\
         </body>"
    );
    // 直接用 data: 页面展示原因，比留一个空白窗口好得多
    let encoded = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(msg.as_bytes())
    };
    if let Ok(u) = tauri::Url::parse(&format!("data:text/html;base64,{encoded}")) {
        for label in ["main", "pet"] {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.navigate(u.clone());
            }
        }
    }
}

// ————————————————————————— 托盘 —————————————————————————

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show_main", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit_tray", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("duo-tray")
        .tooltip("Multi_Pet")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_main" => reveal_main(app),
            "quit_tray" => {
                if let Some(st) = app.try_state::<Shared>() {
                    if let Ok(s) = st.try_lock() {
                        s.save();
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

// ————————————————————————— 入口 —————————————————————————

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 任务栏再点一次图标会拉起第二个进程，单实例插件把它拦下来。
            // 这时要的是把已有主窗口叫到前台，而不是弹「已经在运行」。
            reveal_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();

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
            if cfg.snap {
                cfg.gravity = false;
            }
            if !CHARACTERS.iter().any(|c| c.id == cfg.active_char) {
                cfg.active_char = default_char();
            }
            cfg.size = normalize_size(&cfg.size);
            // 老配置里没有某个角色的坐线表 → 用出厂值补齐，别让整组变 0
            for (id, set) in default_snap_offsets() {
                cfg.snap_offsets.entry(id).or_insert(set);
            }
            // 出厂值改过（比如林德维恩的正坐 33/49/73）→ 一次性迁移老配置
            let before = cfg.version;
            migrate_cfg(&mut cfg);
            if cfg.version != before {
                if let Ok(s) = serde_json::to_string_pretty(&cfg) {
                    let _ = fs::write(&cfg_path, s);
                }
            }

            // 同步开机自启
            {
                use tauri_plugin_autostart::ManagerExt;
                let autolaunch = app.handle().autolaunch();
                let current = autolaunch.is_enabled().unwrap_or(false);
                if cfg.autostart != current {
                    let result = if cfg.autostart {
                        autolaunch.enable()
                    } else {
                        autolaunch.disable()
                    };
                    if let Err(error) = result {
                        eprintln!("[autostart] sync failed: {error}");
                    }
                }
            }

            app.manage(chat::ChatState::new(dir.clone()));
            app.manage(milk_tea::MilkTeaState::new(dir.clone()));
            app.manage(tts::TtsState::new(dir.clone()));

            // 把持久化的联网搜索开关同步给聊天状态（默认关闭）
            if let Some(chat) = app.try_state::<chat::ChatState>() {
                chat.set_web_search(cfg.web_search);
            }

            let state = AppState {
                cfg: cfg.clone(),
                cfg_path,
                pet: PetState::default(),
                granular: "stand".into(),
                fullscreen_hidden: false,
                fullscreen_title: String::new(),
                fullscreen_saved_pos: None,
            };
            app.manage(Arc::new(Mutex::new(state)));

            // 关键：状态全部托管之后再创建窗口。
            // Tauri 的 setup 会先创建配置里的窗口、后调用本钩子，若让窗口自动创建，
            // 前端 invoke('bootstrap') 可能抢在 app.manage 之前到达并报 "state not managed"。
            for window_config in app.config().app.windows.clone() {
                if window_config.create {
                    continue;
                }
                let built = WebviewWindowBuilder::from_config(app.handle(), &window_config)
                    .map_err(|e| format!("窗口 {} 配置无效：{e}", window_config.label))?
                    .build()
                    .map_err(|e| format!("窗口 {} 创建失败：{e}", window_config.label))?;

                if window_config.label == "main" {
                    keep_main_alive(&built);
                }

                if window_config.label == "pet" {
                    // 默认穿透：等前端送来 alpha 掩膜后才在角色像素上变得可点。
                    // 否则这个 340×340 的透明方块会把桌面上的点击全吃掉。
                    let _ = built.set_ignore_cursor_events(true);
                    // 状态要跟窗口的真实状态一致，否则启动时若光标正好停在角色身上，
                    // want_ignore == ignoring（都是 false）会跳过 set_ignore_cursor_events，
                    // 窗口就一直保持穿透、点不到。
                    if let Some(shared) = app.try_state::<Shared>() {
                        if let Ok(mut s) = shared.lock() {
                            s.pet.ignoring = true;
                        }
                    }

                    // 不抢焦点：拖桌宠不该把用户正在编辑的窗口踢到后台
                    #[cfg(windows)]
                    if let Ok(hwnd) = built.hwnd() {
                        use windows_sys::Win32::UI::WindowsAndMessaging::{
                            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
                            WS_EX_TOOLWINDOW,
                        };
                        unsafe {
                            let ex = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
                            let _ = SetWindowLongPtrW(
                                hwnd.0,
                                GWL_EXSTYLE,
                                ex | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize,
                            );
                        }
                    }
                }
            }

            // 托盘
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("[duo] 托盘图标创建失败: {e}");
            }

            // dev 构建被烘了 devUrl、而 dev 服务器没开时，救回内嵌资源
            rescue_from_dead_dev_server(app.handle());

            // 尺寸档要落成真实窗口尺寸（物理像素），必须在摆位之前做
            if let Some(pet) = app.get_webview_window("pet") {
                let px = size_physical(&cfg.size);
                let _ = pet.set_size(Size::Physical(PhysicalSize::new(px, px)));
            }

            // 桌面角色窗口定位到右下角
            place_pet_default(&handle);

            // 桌宠窗口句柄：轮询线程用 Win32 直接读几何，省掉每 tick 的主线程往返。
            // 这里在主线程上拿一次（window_handle 是阻塞往返，不能在轮询线程里每轮调）。
            let self_hwnd: isize = handle
                .get_webview_window("pet")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);

            if let Some(shared) = handle.try_state::<Shared>() {
                let shared = shared.inner().clone();
                spawn_poller(handle.clone(), shared.clone(), self_hwnd);
                // 全屏监视：独立线程、600ms 一轮，与物理轮询互不干扰
                spawn_fullscreen_watcher(handle.clone(), shared.clone(), self_hwnd);

                // 重力开着时，开机就让她从当前位置掉到任务栏/窗口上沿，
                // 而不是悬在半空（这也是“重力”这个开关最直观的效果）。
                if cfg.gravity {
                    if let Some(pet) = handle.get_webview_window("pet") {
                        if let (Ok(pos), Ok(size)) = (pet.outer_position(), pet.outer_size()) {
                            let win_h = size.height as f64;
                            if let Ok(mut s) = shared.lock() {
                                let off_y = s.pet.contact_off_y(win_h);
                                s.pet.mode = Mode::Falling;
                                s.pet.fall_start_y = Some(pos.y as f64 + off_y);
                                s.pet.vy = 0.0;
                                s.pet.panic_fired = false;
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            show_main,
            save_cfg,
            set_autostart,
            quit_app,
            pet_physics,
            pet_drag_start,
            pet_drag_end,
            set_pet_contact,
            set_pet_mask,
            set_snap_offset,
            set_pet_size,
            pet_debug,
            fullscreen_probe,
            chat::chat_status,
            chat::chat_history,
            chat::chat_clear,
            chat::chat_send,
            chat::report_posture,
            chat::affection_status,
            chat::open_url,
            milk_tea::milk_tea_status,
            milk_tea::drink_milk_tea,
            interactions::generate_touch_reply,
            interactions::milk_tea_reply,
            tts::tts_status,
            tts::tts_set_enabled,
            tts::tts_test,
            tts::tts_ack
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
