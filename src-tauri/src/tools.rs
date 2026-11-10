//! Tool abstraction for the desktop pet's ReAct loop.
//!
//! The chat loop only sees `Tool`/`ToolRegistry`; platform implementations are
//! independent and can later be swapped for MCP clients without touching ReAct.

use base64::Engine;
use image::RgbaImage;
use md5::{Digest, Md5};
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::form_urlencoded;
use wait_timeout::ChildExt;

use crate::apps::AppCatalog;

pub enum ToolOutput {
    Text(String),
    Image {
        text: String,
        mime: String,
        base64: String,
    },
}

pub trait Tool: Send + Sync {
    fn name(&self) -> String;
    fn description(&self) -> String;
    fn schema(&self) -> Value;
    fn call(&self, args: &Value) -> Result<ToolOutput, String>;
}

#[derive(Clone)]
pub struct ToolRegistry {
    tools: Vec<Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn with_builtin(apps: Arc<AppCatalog>) -> Self {
        let session = Arc::new(Mutex::new(BilibiliSession::default()));
        Self {
            tools: vec![
                Arc::new(BilibiliTool::new(BilibiliKind::Search, session.clone())),
                Arc::new(BilibiliTool::new(BilibiliKind::Popular, session.clone())),
                Arc::new(BilibiliTool::new(BilibiliKind::Video, session.clone())),
                Arc::new(BilibiliTool::new(BilibiliKind::User, session)),
                Arc::new(OpenAppTool { apps }),
                Arc::new(SandboxTerminalTool),
                Arc::new(ScreenshotTool),
            ],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn schemas(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name(),
                            "description": tool.description(),
                            "parameters": tool.schema(),
                        }
                    })
                })
                .collect(),
        )
    }

    pub fn names(&self) -> Vec<String> {
        self.tools.iter().map(|tool| tool.name()).collect()
    }

    pub fn call(&self, name: &str, args: &Value) -> Result<ToolOutput, String> {
        let tool = self
            .tools
            .iter()
            .find(|tool| tool.name() == name)
            .ok_or_else(|| format!("未知工具：{name}"))?;
        tool.call(args)
    }
}

#[derive(Clone, Copy)]
enum BilibiliKind {
    Search,
    Popular,
    Video,
    User,
}

struct BilibiliTool {
    kind: BilibiliKind,
    client: reqwest::blocking::Client,
    session: Arc<Mutex<BilibiliSession>>,
}

#[derive(Default)]
struct BilibiliSession {
    buvid3: Option<String>,
    buvid4: Option<String>,
    img_key: Option<String>,
    sub_key: Option<String>,
    refreshed_at: Option<Instant>,
}

impl BilibiliTool {
    fn new(kind: BilibiliKind, session: Arc<Mutex<BilibiliSession>>) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            kind,
            client,
            session,
        }
    }

    fn cookie(&self) -> String {
        let session = self.session.lock().ok();
        let mut parts = Vec::new();
        if let Some(session) = session.as_ref() {
            if let Some(value) = &session.buvid3 {
                parts.push(format!("buvid3={value}"));
            }
            if let Some(value) = &session.buvid4 {
                parts.push(format!("buvid4={value}"));
            }
        }
        parts.join("; ")
    }

    fn session_is_fresh(&self) -> bool {
        self.session
            .lock()
            .ok()
            .and_then(|session| session.refreshed_at)
            .map(|instant| instant.elapsed() < Duration::from_secs(30 * 60))
            .unwrap_or(false)
    }

    fn ensure_session(&self) -> Result<(), String> {
        if self.session_is_fresh() {
            let has_keys = self
                .session
                .lock()
                .ok()
                .map(|session| session.img_key.is_some() && session.sub_key.is_some())
                .unwrap_or(false);
            if has_keys {
                return Ok(());
            }
        }

        let spi = self.send(
            "https://api.bilibili.com/x/frontend/finger/spi",
            &[],
            "",
            "https://www.bilibili.com/",
        )?;
        let spi_json: Value = serde_json::from_str(&spi).unwrap_or(Value::Null);
        let buvid3 = spi_json
            .pointer("/data/b_3")
            .and_then(Value::as_str)
            .map(str::to_string);
        let buvid4 = spi_json
            .pointer("/data/b_4")
            .and_then(Value::as_str)
            .map(str::to_string);
        let cookie = match (&buvid3, &buvid4) {
            (Some(b3), Some(b4)) => format!("buvid3={b3}; buvid4={b4}"),
            (Some(b3), None) => format!("buvid3={b3}"),
            _ => String::new(),
        };
        let nav = self.send(
            "https://api.bilibili.com/x/web-interface/nav",
            &[],
            &cookie,
            "https://www.bilibili.com/",
        )?;
        let nav_json: Value = serde_json::from_str(&nav)
            .map_err(|error| format!("B 站 nav 返回非 JSON：{error}"))?;
        let img_url = nav_json
            .pointer("/data/wbi_img/img_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let sub_url = nav_json
            .pointer("/data/wbi_img/sub_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let img_key = img_url.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("");
        let sub_key = sub_url.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("");
        if img_key.is_empty() || sub_key.is_empty() {
            return Err("B 站 WBI 密钥获取失败".into());
        }
        if let Ok(mut session) = self.session.lock() {
            session.buvid3 = buvid3;
            session.buvid4 = buvid4;
            session.img_key = Some(img_key.to_string());
            session.sub_key = Some(sub_key.to_string());
            session.refreshed_at = Some(Instant::now());
        }
        Ok(())
    }

    fn send(
        &self,
        url: &str,
        query: &[(String, String)],
        cookie: &str,
        referer: &str,
    ) -> Result<String, String> {
        let mut request = self
            .client
            .get(url)
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "zh-CN,zh;q=0.9")
            .header("Origin", "https://www.bilibili.com")
            .header("Referer", referer)
            .query(query);
        if !cookie.is_empty() {
            request = request.header("Cookie", cookie);
        }
        let response = request
            .send()
            .map_err(|error| format!("请求 B 站失败：{error}"))?;
        let status = response.status();
        let text = response.text().unwrap_or_default();
        if status.as_u16() == 412 {
            return Err("B 站风控（412），请求被拦截".into());
        }
        if !status.is_success() {
            return Err(format!(
                "B 站 HTTP {}：{}",
                status.as_u16(),
                text.chars().take(200).collect::<String>()
            ));
        }
        Ok(text)
    }

    fn get_json(
        &self,
        url: &str,
        query: &[(String, String)],
        referer: &str,
    ) -> Result<Value, String> {
        self.ensure_session()?;
        let cookie = self.cookie();
        let first = self.send(url, query, &cookie, referer);
        let text = match first {
            Ok(text) => text,
            Err(error) if error.contains("412") => {
                self.refresh_session();
                let cookie = self.cookie();
                self.send(url, query, &cookie, referer)?
            }
            Err(error) => return Err(error),
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("B 站返回非 JSON：{error}"))?;
        if value.get("code").and_then(Value::as_i64) == Some(-412) {
            self.refresh_session();
            let cookie = self.cookie();
            let text = self.send(url, query, &cookie, referer)?;
            return serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("B 站返回非 JSON：{error}"));
        }
        Ok(value)
    }

    fn refresh_session(&self) {
        if let Ok(mut session) = self.session.lock() {
            *session = BilibiliSession::default();
        }
    }

    fn wbi_key(&self) -> Result<String, String> {
        self.ensure_session()?;
        let session = self
            .session
            .lock()
            .map_err(|_| "B 站会话锁不可用".to_string())?;
        let img = session.img_key.clone().unwrap_or_default();
        let sub = session.sub_key.clone().unwrap_or_default();
        if img.is_empty() || sub.is_empty() {
            return Err("B 站 WBI 密钥为空".into());
        }
        let raw = format!("{img}{sub}");
        const TAB: [usize; 64] = [
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
            33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
            26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
            20, 34, 44, 52,
        ];
        Ok(TAB
            .iter()
            .filter_map(|index| raw.chars().nth(*index))
            .take(32)
            .collect())
    }

    fn search(&self, keyword: &str) -> Result<Value, String> {
        let key = self.wbi_key()?;
        let mut params = vec![
            ("search_type".to_string(), "video".to_string()),
            ("keyword".to_string(), keyword.to_string()),
            ("page".to_string(), "1".to_string()),
            (
                "wts".to_string(),
                (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0))
                .to_string(),
            ),
        ];
        params.sort_by(|a, b| a.0.cmp(&b.0));
        let query_for_sign = params
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}={}",
                    form_urlencoded::byte_serialize(key.as_bytes()).collect::<String>(),
                    form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        let digest = Md5::digest(format!("{query_for_sign}{key}").as_bytes());
        let w_rid: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        params.push(("w_rid".to_string(), w_rid));
        self.get_json(
            "https://api.bilibili.com/x/web-interface/wbi/search/type",
            &params,
            "https://search.bilibili.com/",
        )
    }
}

impl Tool for BilibiliTool {
    fn name(&self) -> String {
        match self.kind {
            BilibiliKind::Search => "bilibili_search",
            BilibiliKind::Popular => "bilibili_popular",
            BilibiliKind::Video => "bilibili_video",
            BilibiliKind::User => "bilibili_user",
        }
        .to_string()
    }

    fn description(&self) -> String {
        match self.kind {
            BilibiliKind::Search => "在 Bilibili 搜索视频，只读。参数 keyword 必填，limit 可选（默认 8，最多 20）。",
            BilibiliKind::Popular => "查看 Bilibili 当前热门视频，只读。参数 limit 可选（默认 10，最多 20）。",
            BilibiliKind::Video => "查看 Bilibili 视频详情，只读。参数 bvid 必填，例如 BV1xx411c7mD。",
            BilibiliKind::User => "查看 Bilibili UP 主公开资料，只读。参数 mid 必填（数字 UID）。",
        }
        .to_string()
    }

    fn schema(&self) -> Value {
        match self.kind {
            BilibiliKind::Search => json!({
                "type": "object",
                "properties": {
                    "keyword": { "type": "string", "description": "搜索关键词" },
                    "limit": { "type": "integer", "description": "返回条数，1~20", "default": 8 }
                },
                "required": ["keyword"]
            }),
            BilibiliKind::Popular => json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "description": "返回条数，1~20", "default": 10 }
                }
            }),
            BilibiliKind::Video => json!({
                "type": "object",
                "properties": {
                    "bvid": { "type": "string", "description": "视频 BV 号" }
                },
                "required": ["bvid"]
            }),
            BilibiliKind::User => json!({
                "type": "object",
                "properties": {
                    "mid": { "type": "string", "description": "UP 主数字 UID" }
                },
                "required": ["mid"]
            }),
        }
    }

    fn call(&self, args: &Value) -> Result<ToolOutput, String> {
        match self.kind {
            BilibiliKind::Search => {
                let keyword = args
                    .get("keyword")
                    .and_then(Value::as_str)
                    .ok_or("缺少 keyword")?;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(8)
                    .clamp(1, 20) as usize;
                let value = self.search(keyword)?;
                let list = value
                    .get("data")
                    .and_then(|data| data.get("result"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let items: Vec<Value> = list
                    .into_iter()
                    .take(limit)
                    .map(|item| {
                        json!({
                            "title": clean_html(item.get("title").and_then(Value::as_str).unwrap_or("")),
                            "bvid": item.get("bvid").and_then(Value::as_str).unwrap_or(""),
                            "author": item.get("author").and_then(Value::as_str).unwrap_or(""),
                            "play": item.get("play").and_then(Value::as_u64).unwrap_or(0),
                            "duration": item.get("duration").and_then(Value::as_str).unwrap_or(""),
                            "url": item.get("arcurl").and_then(Value::as_str).unwrap_or(""),
                        })
                    })
                    .collect();
                Ok(ToolOutput::Text(
                    serde_json::to_string(&json!({ "keyword": keyword, "items": items })).unwrap(),
                ))
            }
            BilibiliKind::Popular => {
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(10)
                    .clamp(1, 20) as usize;
                let value = self.get_json(
                    "https://api.bilibili.com/x/web-interface/popular",
                    &[
                        ("ps".to_string(), limit.to_string()),
                        ("pn".to_string(), "1".to_string()),
                    ],
                    "https://www.bilibili.com/",
                )?;
                let list = value
                    .get("data")
                    .and_then(|data| data.get("list"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let items: Vec<Value> = list
                    .into_iter()
                    .take(limit)
                    .map(|item| {
                        json!({
                            "title": item.get("title").and_then(Value::as_str).unwrap_or(""),
                            "bvid": item.get("bvid").and_then(Value::as_str).unwrap_or(""),
                            "owner": item.get("owner").and_then(|o| o.get("name")).and_then(Value::as_str).unwrap_or(""),
                            "play": item.get("stat").and_then(|s| s.get("view")).and_then(Value::as_u64).unwrap_or(0),
                            "url": item.get("short_link_v2").and_then(Value::as_str).unwrap_or(""),
                        })
                    })
                    .collect();
                Ok(ToolOutput::Text(
                    serde_json::to_string(&json!({ "items": items })).unwrap(),
                ))
            }
            BilibiliKind::Video => {
                let bvid = args
                    .get("bvid")
                    .and_then(Value::as_str)
                    .ok_or("缺少 bvid")?;
                let value = self.get_json(
                    "https://api.bilibili.com/x/web-interface/view",
                    &[("bvid".to_string(), bvid.to_string())],
                    "https://www.bilibili.com/",
                )?;
                let data = value
                    .get("data")
                    .ok_or_else(|| format!("视频不存在或接口返回异常：{}", value.get("message").and_then(Value::as_str).unwrap_or("")))?;
                Ok(ToolOutput::Text(serde_json::to_string(&json!({
                    "bvid": data.get("bvid"),
                    "title": data.get("title"),
                    "desc": data.get("desc"),
                    "owner": data.get("owner"),
                    "stat": data.get("stat"),
                    "duration": data.get("duration"),
                    "pubdate": data.get("pubdate"),
                }))
                .unwrap()))
            }
            BilibiliKind::User => {
                let mid = args
                    .get("mid")
                    .and_then(Value::as_str)
                    .ok_or("缺少 mid")?;
                let value = self.get_json(
                    "https://api.bilibili.com/x/web-interface/card",
                    &[("mid".to_string(), mid.to_string())],
                    "https://www.bilibili.com/",
                )?;
                let card = value
                    .get("data")
                    .and_then(|data| data.get("card"))
                    .ok_or_else(|| format!("UP 主不存在或接口返回异常：{}", value.get("message").and_then(Value::as_str).unwrap_or("")))?;
                Ok(ToolOutput::Text(serde_json::to_string(&json!({
                    "mid": card.get("mid"),
                    "name": card.get("name"),
                    "sign": card.get("sign"),
                    "fans": card.get("fans"),
                    "level": card.get("level_info"),
                }))
                .unwrap()))
            }
        }
    }
}

struct OpenAppTool {
    apps: Arc<AppCatalog>,
}

impl Tool for OpenAppTool {
    fn name(&self) -> String {
        "open_app".into()
    }

    fn description(&self) -> String {
        "打开本机已安装的应用程序，只接受应用名称。用户说“打开微信/打开浏览器”时使用。\
         应用名必须来自系统提示词里的本机应用列表；不要直接执行 shell 命令。"
            .into()
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "应用名称，例如“微信”或“Chrome”" }
            },
            "required": ["name"]
        })
    }

    fn call(&self, args: &Value) -> Result<ToolOutput, String> {
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or("缺少应用名称")?;
        self.apps.open(name).map(ToolOutput::Text)
    }
}

struct SandboxTerminalTool;

impl Tool for SandboxTerminalTool {
    fn name(&self) -> String {
        "sandbox_terminal".into()
    }

    fn description(&self) -> String {
        "在本机运行只读 PowerShell 命令（沙盒限制：只允许 Get-*、where、whoami、dir、echo 等查询；\
         禁止写入、删除、启动进程、网络请求和管道）。用于查看系统信息，不要用它打开应用。"
            .into()
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "只读 PowerShell 命令" }
            },
            "required": ["command"]
        })
    }

    fn call(&self, args: &Value) -> Result<ToolOutput, String> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .ok_or("缺少 command")?;
        if command.chars().count() > 500 {
            return Err("命令太长".into());
        }
        let lower = command.to_lowercase();
        const BLOCKED: &[&str] = &[
            "|", ">", "<", ";", "&&", "`", "$(", "remove-", "rm ", "del ", "erase ", "format ",
            "shutdown", "restart", "reg ", "regedit", "net user", "diskpart", "set-", "new-",
            "copy-", "move-", "invoke-", "start-process", "stop-process", "taskkill", "schtasks",
        ];
        if BLOCKED.iter().any(|word| lower.contains(word)) {
            return Err("该命令包含沙盒禁止的操作".into());
        }
        const ALLOWED: &[&str] = &[
            "get-", "where", "whoami", "dir", "echo", "get-startapps",
        ];
        if !ALLOWED.iter().any(|prefix| lower.starts_with(prefix)) {
            return Err("沙盒终端只允许只读查询命令".into());
        }
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", command])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|error| format!("启动 PowerShell 失败：{error}"))?;
        let status = child
            .wait_timeout(Duration::from_secs(12))
            .map_err(|error| format!("等待命令失败：{error}"))?;
        if status.is_none() {
            let _ = child.kill();
            return Err("命令超时（12 秒）".into());
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("读取命令输出失败：{error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut text = stdout.trim().to_string();
        if !stderr.trim().is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(stderr.trim());
        }
        if text.chars().count() > 8000 {
            text = text.chars().take(8000).collect::<String>() + "\n…（输出已截断）";
        }
        if text.is_empty() {
            text = "（命令无输出）".into();
        }
        Ok(ToolOutput::Text(text))
    }
}

struct ScreenshotTool;

impl Tool for ScreenshotTool {
    fn name(&self) -> String {
        "capture_screen".into()
    }

    fn description(&self) -> String {
        "截取当前主屏幕并把截图附加给模型。需要看用户屏幕、窗口内容或界面时使用；只读，不修改系统。"
            .into()
    }

    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn call(&self, _args: &Value) -> Result<ToolOutput, String> {
        capture_screen()
    }
}

#[cfg(windows)]
pub fn capture_screen_jpeg_region(
    rect: Option<(i32, i32, i32, i32)>,
    max_width: u32,
) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
    };

    unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        if width <= 0 || height <= 0 {
            return Err("无法获取屏幕尺寸".into());
        }
        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("无法获取屏幕 DC".into());
        }
        let memory_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if memory_dc.is_null() || bitmap.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("创建截图缓冲区失败".into());
        }
        let old = SelectObject(memory_dc, bitmap as _);
        if BitBlt(memory_dc, 0, 0, width, height, screen_dc, 0, 0, SRCCOPY) == 0 {
            SelectObject(memory_dc, old);
            DeleteObject(bitmap as _);
            DeleteDC(memory_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("截图 BitBlt 失败".into());
        }
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(memory_dc, old);
        DeleteObject(bitmap as _);
        DeleteDC(memory_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        if lines == 0 {
            return Err("读取截图像素失败".into());
        }
        let mut rgba = Vec::with_capacity(pixels.len());
        for pixel in pixels.chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
        let image = RgbaImage::from_raw(width as u32, height as u32, rgba)
            .ok_or_else(|| "截图数据尺寸错误".to_string())?;
        let image = match rect {
            Some((x, y, w, h)) => {
                let x = x.max(0).min(width);
                let y = y.max(0).min(height);
                let w = w.max(0).min(width - x);
                let h = h.max(0).min(height - y);
                if w > 0 && h > 0 {
                    image::imageops::crop_imm(&image, x as u32, y as u32, w as u32, h as u32)
                        .to_image()
                } else {
                    image
                }
            }
            None => image,
        };
        let max_width = max_width.max(320);
        let image = if image.width() > max_width {
            let new_height = (image.height() as u64 * max_width as u64 / image.width() as u64)
                .max(1) as u32;
            image::imageops::resize(
                &image,
                max_width,
                new_height,
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            image
        };
        let mut jpeg = Vec::new();
        let rgb = image::DynamicImage::ImageRgba8(image).to_rgb8();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|error| format!("截图编码失败：{error}"))?;
        Ok(jpeg)
    }
}

#[cfg(not(windows))]
pub fn capture_screen_jpeg_region(
    _rect: Option<(i32, i32, i32, i32)>,
    _max_width: u32,
) -> Result<Vec<u8>, String> {
    Err("当前平台不支持截图".into())
}

#[cfg(windows)]
fn capture_screen() -> Result<ToolOutput, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
    };

    unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        if width <= 0 || height <= 0 {
            return Err("无法获取屏幕尺寸".into());
        }
        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("无法获取屏幕 DC".into());
        }
        let memory_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if memory_dc.is_null() || bitmap.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("创建截图缓冲区失败".into());
        }
        let old = SelectObject(memory_dc, bitmap as _);
        if BitBlt(memory_dc, 0, 0, width, height, screen_dc, 0, 0, SRCCOPY) == 0 {
            SelectObject(memory_dc, old);
            DeleteObject(bitmap as _);
            DeleteDC(memory_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err("截图 BitBlt 失败".into());
        }
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(memory_dc, old);
        DeleteObject(bitmap as _);
        DeleteDC(memory_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        if lines == 0 {
            return Err("读取截图像素失败".into());
        }
        let mut rgba = Vec::with_capacity(pixels.len());
        for pixel in pixels.chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
        }
        let image = RgbaImage::from_raw(width as u32, height as u32, rgba)
            .ok_or_else(|| "截图数据尺寸错误".to_string())?;
        let image = if width > 1280 {
            let new_height = (height * 1280 / width).max(1);
            image::imageops::resize(&image, 1280, new_height as u32, image::imageops::FilterType::Lanczos3)
        } else {
            image
        };
        let mut jpeg = Vec::new();
        let rgb = image::DynamicImage::ImageRgba8(image).to_rgb8();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|error| format!("截图编码失败：{error}"))?;
        Ok(ToolOutput::Image {
            text: "当前主屏幕截图已附加。".into(),
            mime: "image/jpeg".into(),
            base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        })
    }
}

#[cfg(not(windows))]
fn capture_screen() -> Result<ToolOutput, String> {
    Err("当前平台不支持截图".into())
}

fn clean_html(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

// ————————————————————————— MCP 工具定义 —————————————————————————

