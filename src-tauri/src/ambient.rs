//! Proactive desktop companionship.
//!
//! Foreground app detection -> local hard rules -> flash gate -> one-off bubble
//! and occasional screenshots. Nothing here touches the chat history.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

static AMBIENT_RUNNING: AtomicBool = AtomicBool::new(false);
static AMBIENT_TICKS: AtomicU64 = AtomicU64::new(0);
static AMBIENT_LAST_KEY: Mutex<String> = Mutex::new(String::new());
static AMBIENT_STAGE: Mutex<String> = Mutex::new(String::new());

fn set_stage(stage: &str) {
    if let Ok(mut current) = AMBIENT_STAGE.lock() {
        current.clear();
        current.push_str(stage);
    }
}

use crate::chat::{api_key, API_URL, MODEL};

const GATE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const OPEN_BUBBLE_COOLDOWN: Duration = Duration::from_secs(30 * 60);
const MIN_BUBBLE_GAP: Duration = Duration::from_secs(20);
const MAX_SHOTS_PER_HOUR: usize = 12;
const IGNORE_TITLE: &[&str] = &["无痕", "无痕模式", "InPrivate", "密码", "银行", "支付"];
const HARD_IGNORE: &[&str] = &[
    "explorer.exe",
    "applicationframehost.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "lockapp.exe",
    "dwm.exe",
    "svchost.exe",
    "taskmgr.exe",
    "systemsettings.exe",
    "control.exe",
    "mmc.exe",
    "regedit.exe",
    "raven-winpet.exe",
    "deepseek harness.exe",
];

/// exe, label, category, allow comment, allow screenshot
const KNOWN_APPS: &[(&str, &str, &str, bool, bool)] = &[
    ("bilibili.exe", "B站", "entertainment", true, true),
    ("哔哩哔哩.exe", "B站", "entertainment", true, true),
    ("douyin.exe", "抖音", "entertainment", true, false),
    ("抖音.exe", "抖音", "entertainment", true, false),
    ("steam.exe", "Steam", "entertainment", true, false),
    ("spotify.exe", "Spotify", "entertainment", true, false),
    ("vlc.exe", "VLC", "entertainment", true, false),
    ("potplayermini64.exe", "PotPlayer", "entertainment", true, false),
    ("code.exe", "VS Code", "work", true, true),
    ("cursor.exe", "Cursor", "work", true, true),
    ("idea64.exe", "IntelliJ IDEA", "work", true, true),
    ("pycharm64.exe", "PyCharm", "work", true, true),
    ("devenv.exe", "Visual Studio", "work", true, true),
    ("sublime_text.exe", "Sublime Text", "work", true, true),
    ("winword.exe", "Word", "work", true, true),
    ("excel.exe", "Excel", "work", true, true),
    ("powerpnt.exe", "PowerPoint", "work", true, true),
    ("wps.exe", "WPS", "work", true, true),
    ("photoshop.exe", "Photoshop", "work", true, true),
    ("blender.exe", "Blender", "work", true, true),
    ("unity.exe", "Unity", "work", true, true),
    ("windowsterminal.exe", "Windows Terminal", "work", true, false),
    ("powershell.exe", "PowerShell", "work", true, false),
    ("cmd.exe", "命令提示符", "work", true, false),
    ("chrome.exe", "浏览器", "browser", true, false),
    ("msedge.exe", "浏览器", "browser", true, false),
    ("firefox.exe", "浏览器", "browser", true, false),
    ("wechat.exe", "微信", "social", true, false),
    ("weixin.exe", "微信", "social", true, false),
    ("qq.exe", "QQ", "social", true, false),
    ("discord.exe", "Discord", "social", true, false),
    ("telegram.exe", "Telegram", "social", true, false),
    ("obsidian.exe", "Obsidian", "study", true, true),
    ("notion.exe", "Notion", "study", true, true),
    ("acrobat.exe", "Acrobat", "study", true, false),
    ("sumatrapdf.exe", "SumatraPDF", "study", true, false),
];

#[derive(Clone, Debug)]
struct ForegroundApp {
    key: String,
    exe: String,
    label: String,
    title: String,
    rect: (i32, i32, i32, i32),
    fullscreen: bool,
}

#[derive(Clone, Debug)]
struct GateDecision {
    worth: bool,
    label: String,
    category: String,
    screenshots: bool,
}

#[derive(Clone, Debug)]
struct LocalHint {
    hard_ignore: bool,
    known: bool,
    label: String,
    category: String,
    screenshots: bool,
}

struct Session {
    app: ForegroundApp,
    started: Instant,
    gate: Option<GateDecision>,
    gate_done: bool,
    opening_done: bool,
    dead: bool,
    next_shot: usize,
}

struct CachedGate {
    decision: GateDecision,
    at: Instant,
}

struct AmbientState {
    client: reqwest::blocking::Client,
    session: Option<Session>,
    gate_cache: HashMap<String, CachedGate>,
    last_bubble: Option<Instant>,
    last_open: HashMap<String, Instant>,
    shot_times: Vec<Instant>,
}

pub fn spawn(app: AppHandle) {
    if std::env::var("RAVEN_AMBIENT").ok().as_deref() == Some("0") {
        return;
    }
    if api_key().is_none() {
        eprintln!("[ambient] DASHSCOPE_API_KEY missing; proactive companion disabled");
        return;
    }
    std::thread::Builder::new()
        .name("raven-ambient".into())
        .spawn(move || run(app))
        .ok();
}

#[tauri::command]
pub fn ambient_capture_test() -> Value {
    let Some(info) = foreground_app() else {
        return json!({ "ok": false, "reason": "no-foreground" });
    };
    match crate::tools::capture_screen_jpeg_region(Some(info.rect), 1280) {
        Ok(bytes) => json!({
            "ok": true,
            "exe": info.exe,
            "rect": info.rect,
            "bytes": bytes.len(),
        }),
        Err(error) => json!({ "ok": false, "reason": error }),
    }
}

#[tauri::command]
pub fn ambient_probe(app: AppHandle) -> Value {
    match foreground_app() {
        None => json!({ "ok": false, "reason": "no-foreground" }),
        Some(info) => {
            let hint = local_hint(&info);
            json!({
                "ok": true,
                "exe": info.exe,
                "title": info.title,
                "rect": info.rect,
                "fullscreen": info.fullscreen,
                "hard_ignore": hint.hard_ignore,
                "known": hint.known,
                "label": hint.label,
                "category": hint.category,
                "screenshots": hint.screenshots,
                "idle": user_idle(),
                "chat_visible": chat_visible(&app),
                "chat_busy": chat_busy(&app),
                "api_key": api_key().is_some(),
                "ambient_env": std::env::var("RAVEN_AMBIENT").unwrap_or_default(),
                "screenshots_env": std::env::var("RAVEN_AMBIENT_SCREENSHOTS").unwrap_or_default(),
                "running": AMBIENT_RUNNING.load(Ordering::SeqCst),
                "ticks": AMBIENT_TICKS.load(Ordering::SeqCst),
                "last_key": AMBIENT_LAST_KEY.lock().map(|key| key.clone()).unwrap_or_default(),
                "stage": AMBIENT_STAGE.lock().map(|stage| stage.clone()).unwrap_or_default(),
                "chat_url": std::env::var("RAVEN_CHAT_API_URL").unwrap_or_default(),
            })
        }
    }
}

fn run(app: AppHandle) {
    AMBIENT_RUNNING.store(true, Ordering::SeqCst);
    let mut state = AmbientState {
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent("RavenPet/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new()),
        session: None,
        gate_cache: HashMap::new(),
        last_bubble: None,
        last_open: HashMap::new(),
        shot_times: Vec::new(),
    };

    std::thread::sleep(Duration::from_secs(2));
    loop {
        std::thread::sleep(Duration::from_millis(500));
        AMBIENT_TICKS.fetch_add(1, Ordering::SeqCst);
        if std::env::var("RAVEN_AMBIENT").ok().as_deref() == Some("0") {
            continue;
        }
        let Some(app_info) = foreground_app() else {
            state.session = None;
            continue;
        };
        if let Ok(mut key) = AMBIENT_LAST_KEY.lock() {
            key.clone_from(&app_info.key);
        }
        let hint = local_hint(&app_info);
        if hint.hard_ignore {
            state.session = None;
            set_stage("hard-ignore");
            continue;
        }
        let paused = chat_visible(&app) || chat_busy(&app) || user_idle();
        if paused {
            set_stage("paused");
        } else {
            set_stage("tick");
        }
        state.tick(&app, app_info, hint, paused);
    }
}

impl AmbientState {
    fn tick(&mut self, app: &AppHandle, info: ForegroundApp, hint: LocalHint, paused: bool) {
        let changed = self
            .session
            .as_ref()
            .map(|session| session.app.key != info.key)
            .unwrap_or(true);
        if changed {
            self.session = Some(Session {
                app: info,
                started: Instant::now(),
                gate: None,
                gate_done: false,
                opening_done: false,
                dead: false,
                next_shot: 0,
            });
            return;
        }
        if paused {
            return;
        }

        let Some(mut session) = self.session.take() else {
            return;
        };
        let elapsed = session.started.elapsed().as_secs_f64();

        if !session.gate_done && elapsed >= 3.0 {
            set_stage("gate-request");
            let decision = self.gate(app, &session.app, &hint);
            set_stage("gate-done");
            session.gate = Some(decision.clone());
            session.gate_done = true;
            if !decision.worth {
                session.dead = true;
            }
        }

        if !session.dead && session.gate.is_some() {
            let decision = session.gate.clone().unwrap();
            if !session.opening_done {
                session.opening_done = true;
                let cooldown = self
                    .last_open
                    .get(&session.app.key)
                    .map(|at| at.elapsed() < OPEN_BUBBLE_COOLDOWN)
                    .unwrap_or(false);
                if !cooldown && self.can_bubble() {
                    if let Ok(text) = opening_bubble(&self.client, &session.app, &decision) {
                        if foreground_key().as_deref() == Some(session.app.key.as_str()) {
                            emit_bubble(app, &session.app, &text, "open");
                            self.note_bubble();
                            self.last_open.insert(session.app.key.clone(), Instant::now());
                        }
                    }
                }
            }

            let screenshots_enabled = std::env::var("RAVEN_AMBIENT_SCREENSHOTS")
                .ok()
                .as_deref()
                != Some("0");
            if screenshots_enabled
                && decision.screenshots
                && !session.app.fullscreen
                && !is_sensitive_title(&session.app.title)
            {
                while session.next_shot < 40 {
                    let target = shot_target(session.next_shot);
                    if elapsed < target {
                        break;
                    }
                    session.next_shot += 1;
                    // 暂停/切走太久不补拍，避免恢复后连拍。
                    if elapsed - target > 30.0 {
                        continue;
                    }
                    if !self.can_bubble() || !self.can_shot() {
                        continue;
                    }
                    let Some(text) = self.take_shot(app, &session.app, &decision) else {
                        continue;
                    };
                    if foreground_key().as_deref() == Some(session.app.key.as_str()) {
                        emit_bubble(app, &session.app, &text, "screen");
                        self.note_bubble();
                        self.shot_times.push(Instant::now());
                    }
                    break;
                }
            }
        }

        self.session = Some(session);
    }

    fn can_bubble(&self) -> bool {
        self.last_bubble
            .map(|at| at.elapsed() >= MIN_BUBBLE_GAP)
            .unwrap_or(true)
    }

    fn can_shot(&mut self) -> bool {
        self.shot_times.retain(|at| at.elapsed() < Duration::from_secs(3600));
        self.shot_times.len() < MAX_SHOTS_PER_HOUR
    }

    fn note_bubble(&mut self) {
        self.last_bubble = Some(Instant::now());
    }

    fn gate(&mut self, app: &AppHandle, info: &ForegroundApp, hint: &LocalHint) -> GateDecision {
        if let Some(cached) = self.gate_cache.get(&info.key) {
            if cached.at.elapsed() < GATE_TTL {
                return cached.decision.clone();
            }
        }
        let decision = gate_with_flash(&self.client, info, hint).unwrap_or_else(|| {
            GateDecision {
                worth: hint.known,
                label: hint.label.clone(),
                category: hint.category.clone(),
                screenshots: hint.known && hint.screenshots,
            }
        });
        let mut decision = decision;
        // 未识别应用不开放截图，即使 flash 判断为值得交流，也先只说话。
        if !hint.screenshots {
            decision.screenshots = false;
        }
        if hint.label != "未知应用" {
            decision.label = hint.label.clone();
        }
        self.gate_cache.insert(
            info.key.clone(),
            CachedGate {
                decision: decision.clone(),
                at: Instant::now(),
            },
        );
        let _ = app;
        decision
    }

    fn take_shot(&mut self, app: &AppHandle, info: &ForegroundApp, decision: &GateDecision) -> Option<String> {
        let jpeg = capture_foreground(app, info).ok()?;
        screenshot_bubble(&self.client, info, decision, &jpeg).ok()
    }
}

fn shot_target(index: usize) -> f64 {
    match index {
        0 => 45.0,
        1 => 180.0,
        _ => 180.0 + (index as f64 - 1.0) * 240.0,
    }
}

fn chat_visible(app: &AppHandle) -> bool {
    app.get_webview_window("chat")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn chat_busy(app: &AppHandle) -> bool {
    app.try_state::<crate::chat::ChatState>()
        .map(|state| state.busy())
        .unwrap_or(false)
}

fn emit_bubble(app: &AppHandle, info: &ForegroundApp, text: &str, kind: &str) {
    let _ = app.emit(
        "pet:ambient",
        json!({
            "text": text,
            "app": info.label,
            "kind": kind,
        }),
    );
    crate::tts::speak(app.clone(), text.to_string());
}

fn clean_bubble(raw: &str) -> String {
    let mut text = raw.trim().replace(['\r', '\n'], " ");
    while text.starts_with('"') || text.starts_with('“') {
        text.remove(0);
    }
    while text.ends_with('"') || text.ends_with('”') {
        text.pop();
    }
    let text = text.trim();
    if text.chars().count() > 80 {
        return text.chars().take(80).collect::<String>() + "…";
    }
    text.to_string()
}

fn completion(client: &reqwest::blocking::Client, messages: Value, max_tokens: u32, temperature: f64) -> Result<String, String> {
    let (_, key) = api_key().ok_or("缺少 API Key")?;
    let url = std::env::var("RAVEN_CHAT_API_URL").unwrap_or_else(|_| API_URL.to_string());
    set_stage("http-send");
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": MODEL,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }))
        .send()
        .map_err(|error| format!("请求失败：{error}"))?;
    set_stage("http-response");
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let value: Value = response.json().map_err(|error| format!("响应不是 JSON：{error}"))?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "响应缺少 content".to_string())?;
    Ok(content.to_string())
}

fn gate_with_flash(client: &reqwest::blocking::Client, info: &ForegroundApp, hint: &LocalHint) -> Option<GateDecision> {
    let title = if is_sensitive_title(&info.title) {
        "[隐私窗口]".to_string()
    } else {
        info.title.chars().take(80).collect::<String>()
    };
    let system = "你是一个桌面陪伴助手的应用筛选器。只输出一个 JSON 对象，不要 Markdown。\
        判断用户当前打开的应用是否适合主动闲聊。输出字段：\
        worth(boolean)、label(string)、category(string)、screenshots(boolean)、confidence(0~1)、reason(string)。\
        规则：文件资源管理器/设置/任务管理器/系统组件/安装器/密码/银行/隐私工具 → worth=false。\
        浏览器/微信/QQ/社交 → 可以 worth=true，但 screenshots=false。\
        娱乐/工作/学习类 → worth=true。未知或没有把握 → worth=false。";
    let user = format!(
        "进程名：{}\n显示名：{}\n窗口标题：{}\n本地分类：{}\n请判断是否值得主动陪伴，并只输出 JSON。",
        info.exe, hint.label, title, hint.category
    );
    let messages = json!([
        { "role": "system", "content": system },
        { "role": "user", "content": user },
    ]);
    let text = completion(client, messages, 160, 0.1).ok()?;
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let value: Value = serde_json::from_str(&text[start..=end]).ok()?;
    let worth = value.get("worth").and_then(Value::as_bool).unwrap_or(false);
    let confidence = value.get("confidence").and_then(Value::as_f64).unwrap_or(0.5);
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&hint.label)
        .chars()
        .take(24)
        .collect::<String>();
    let category = value
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or(&hint.category)
        .to_string();
    let screenshots = value
        .get("screenshots")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(GateDecision {
        worth: worth && confidence >= 0.5,
        label,
        category,
        screenshots,
    })
}

fn opening_bubble(
    client: &reqwest::blocking::Client,
    info: &ForegroundApp,
    decision: &GateDecision,
) -> Result<String, String> {
    let system = "你是 Raven（蕾文），用户的桌面伴侣。傲娇、爱逗人、嘴硬心软；\
        不每句都用“哼”，不承认自己黏人。你现在主动说一句陪伴性闲话，不是回答提问。\
        只输出一句中文，15～45字；不要旁白、不要问“有什么可以帮你”、不要提 AI/截图/系统。";
    let user = format!(
        "用户刚打开了【{}】（{}类）。结合这个场景主动说一句符合性格的话。",
        decision.label, decision.category
    );
    let messages = json!([
        { "role": "system", "content": system },
        { "role": "user", "content": user },
    ]);
    let raw = completion(client, messages, 100, 0.95)?;
    let text = clean_bubble(&raw);
    if text.is_empty() {
        return Err("空气泡".into());
    }
    let _ = info;
    Ok(text)
}

fn screenshot_bubble(
    client: &reqwest::blocking::Client,
    info: &ForegroundApp,
    decision: &GateDecision,
    jpeg: &[u8],
) -> Result<String, String> {
    use base64::Engine;
    let system = "你是 Raven（蕾文），用户的桌面伴侣。傲娇、爱逗人、嘴硬心软；\
        不每句都用“哼”。你现在看到用户当前应用截图，主动说一句陪伴性闲话，不是回答提问。\
        只输出一句中文，15～45字；不要读出代码、密码、聊天内容、姓名等隐私；\
        看不清或内容不适合评论时，给一句通用陪伴即可；不要提 AI/截图/系统。";
    let user_text = format!(
        "这是用户当前【{}】（{}类）窗口的截图。结合画面主动说一句自然、有陪伴感的话。",
        decision.label, decision.category
    );
    let data_url = format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    );
    let messages = json!([
        { "role": "system", "content": system },
        {
            "role": "user",
            "content": [
                { "type": "text", "text": user_text },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }
    ]);
    let raw = completion(client, messages, 120, 0.9)?;
    let text = clean_bubble(&raw);
    if text.is_empty() {
        return Err("空气泡".into());
    }
    let _ = info;
    Ok(text)
}

fn capture_foreground(app: &AppHandle, info: &ForegroundApp) -> Result<Vec<u8>, String> {
    let pet = app.get_webview_window("pet");
    let visible = pet
        .as_ref()
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        if let Some(window) = &pet {
            let _ = window.hide();
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    let result = crate::tools::capture_screen_jpeg_region(Some(info.rect), 1280);
    if visible {
        if let Some(window) = &pet {
            let _ = window.show();
        }
    }
    result
}

fn foreground_key() -> Option<String> {
    foreground_app().map(|app| app.key)
}

fn is_sensitive_title(title: &str) -> bool {
    IGNORE_TITLE.iter().any(|word| title.contains(word))
}

fn local_hint(info: &ForegroundApp) -> LocalHint {
    let exe = info.exe.to_lowercase();
    if exe.is_empty() || HARD_IGNORE.iter().any(|name| exe == *name) {
        return LocalHint {
            hard_ignore: true,
            known: false,
            label: "未知应用".into(),
            category: "system".into(),
            screenshots: false,
        };
    }
    for (name, label, category, _comment, screenshots) in KNOWN_APPS {
        if exe == *name {
            return LocalHint {
                hard_ignore: false,
                known: true,
                label: (*label).to_string(),
                category: (*category).to_string(),
                screenshots: *screenshots,
            };
        }
    }
    LocalHint {
        hard_ignore: false,
        known: false,
        label: "未知应用".into(),
        category: "unknown".into(),
        screenshots: false,
    }
}

#[cfg(windows)]
fn foreground_app() -> Option<ForegroundApp> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SM_CXSCREEN, SM_CYSCREEN,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        let mut exe = String::new();
        if !handle.is_null() {
            let mut buffer = [0u16; 1024];
            let mut size = buffer.len() as u32;
            if QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) != 0 {
                let path = String::from_utf16_lossy(&buffer[..size as usize]);
                exe = std::path::Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .to_string();
            }
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        let title_len = GetWindowTextLengthW(hwnd).max(0) as usize;
        let mut title_buf = vec![0u16; title_len + 1];
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize])
            .trim()
            .to_string();
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return None;
        }
        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        if width == 0 || height == 0 {
            return None;
        }
        let sw = GetSystemMetrics(SM_CXSCREEN);
        let sh = GetSystemMetrics(SM_CYSCREEN);
        let fullscreen = rect.left <= 0 && rect.top <= 0 && width >= sw - 2 && height >= sh - 2;
        let label = title.clone();
        Some(ForegroundApp {
            key: exe.to_lowercase(),
            exe,
            label,
            title,
            rect: (rect.left, rect.top, width, height),
            fullscreen,
        })
    }
}

#[cfg(not(windows))]
fn foreground_app() -> Option<ForegroundApp> {
    None
}

#[cfg(windows)]
fn user_idle() -> bool {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut info: LASTINPUTINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<LASTINPUTINFO>() as u32;
        if GetLastInputInfo(&mut info) == 0 {
            return false;
        }
        GetTickCount().wrapping_sub(info.dwTime) > 120_000
    }
}

#[cfg(not(windows))]
fn user_idle() -> bool {
    false
}

// shixiaoyu-funny原创，详见bilibili：https://space.bilibili.com/517323821?spm_id_from=333.337.0.0，仅供学习，严禁商用
