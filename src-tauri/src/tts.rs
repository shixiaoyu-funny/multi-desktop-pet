//! Qwen-Audio-TTS speech output.
//!
//! Uses the documented HTTP + SSE streaming endpoint, accumulates the returned
//! MP3 chunks in memory, and sends one `pet:tts` event to the pet window. No
//! audio file is written to disk.

use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::chat::api_key;

const TTS_MODEL: &str = "qwen-audio-3.0-tts-plus";
const TTS_VOICE: &str = "qwen-audio-3.0-tts-plus-longmohuiling";

pub struct TtsState {
    client: reqwest::blocking::Client,
    enabled: AtomicBool,
    generation: Arc<AtomicU64>,
    started: Arc<(Mutex<u64>, Condvar)>,
    path: PathBuf,
}

impl TtsState {
    pub fn new(dir: PathBuf) -> Self {
        let path = dir.join("tts.json");
        let enabled = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("enabled").and_then(Value::as_bool))
            .unwrap_or(true);
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("RavenPet/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            client,
            enabled: AtomicBool::new(enabled),
            generation: Arc::new(AtomicU64::new(0)),
            started: Arc::new((Mutex::new(0), Condvar::new())),
            path,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if let Ok(text) = serde_json::to_string_pretty(&json!({ "enabled": enabled })) {
            let _ = fs::write(&self.path, text);
        }
    }

    pub fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub fn tts_status(state: State<'_, TtsState>) -> Value {
    json!({
        "enabled": state.enabled(),
        "model": TTS_MODEL,
        "voice": TTS_VOICE,
        "endpoint": endpoint(),
    })
}

#[tauri::command]
pub fn tts_test(state: State<'_, TtsState>) -> Result<Value, String> {
    let audio = synthesize(&state.client, "你好，我是 Raven。")?;
    Ok(json!({ "bytes": audio.len(), "endpoint": endpoint() }))
}

#[tauri::command]
pub fn tts_set_enabled(
    app: AppHandle,
    state: State<'_, TtsState>,
    enabled: bool,
) -> Result<Value, String> {
    state.set_enabled(enabled);
    if !enabled {
        let _ = app.emit("pet:tts-stop", json!({}));
    }
    Ok(json!({ "enabled": state.enabled() }))
}

#[tauri::command]
pub fn tts_ack(state: State<'_, TtsState>, generation: u64) {
    let (started, wake) = &*state.started;
    if let Ok(mut current) = started.lock() {
        if generation > *current {
            *current = generation;
        }
        wake.notify_all();
    }
}

/// Synthesize and emit the audio, then wait briefly until the pet window
/// confirms that playback actually started. Used by chat before text streaming.
pub fn prepare(app: &AppHandle, text: &str) -> bool {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 1200 {
        return false;
    }
    if std::env::var("RAVEN_TTS").ok().as_deref() == Some("0") {
        return false;
    }
    let Some(state) = app.try_state::<TtsState>() else {
        return false;
    };
    if !state.enabled() {
        return false;
    }
    let generation = state.next_generation();
    let _ = app.emit("pet:tts-stop", json!({}));
    let Ok(audio) = synthesize(&state.client, &text) else {
        return false;
    };
    let _ = app.emit(
        "pet:tts",
        json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(audio),
            "mime": "audio/mpeg",
            "text": text,
            "generation": generation,
        }),
    );

    let (started, wake) = &*state.started;
    let deadline = Instant::now() + Duration::from_millis(1600);
    let Ok(mut current) = started.lock() else {
        return true;
    };
    while *current < generation {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let Ok((next, _)) = wake.wait_timeout(current, remaining) else {
            break;
        };
        current = next;
    }
    true
}

/// Start one asynchronous TTS generation. A newer request invalidates older
/// results; the frontend also stops the previous audio immediately.
pub fn speak(app: AppHandle, text: String) {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 1200 {
        return;
    }
    if std::env::var("RAVEN_TTS").ok().as_deref() == Some("0") {
        return;
    }
    let Some(state) = app.try_state::<TtsState>() else {
        return;
    };
    if !state.enabled() {
        return;
    }
    let generation = state.next_generation();
    let client = state.client.clone();
    let generation_shared = state.generation.clone();
    let app_for_thread = app.clone();
    let _ = app.emit("pet:tts-stop", json!({}));
    std::thread::spawn(move || {
        let result = synthesize(&client, &text);
        if generation_shared.load(Ordering::SeqCst) != generation {
            return;
        }
        match result {
            Ok(audio) => {
                let _ = app_for_thread.emit(
                    "pet:tts",
                    json!({
                        "base64": base64::engine::general_purpose::STANDARD.encode(audio),
                        "mime": "audio/mpeg",
                        "text": text,
                        "generation": generation,
                    }),
                );
            }
            Err(error) => {
                eprintln!("[tts] {error}");
            }
        }
    });
}

fn endpoint() -> String {
    if let Ok(url) = std::env::var("DASHSCOPE_TTS_URL") {
        if !url.trim().is_empty() {
            return url;
        }
    }
    if let Ok(workspace) = std::env::var("DASHSCOPE_WORKSPACE_ID") {
        if !workspace.trim().is_empty() {
            let region = std::env::var("DASHSCOPE_REGION")
                .unwrap_or_else(|_| "cn-beijing".to_string());
            return format!(
                "https://{}.{}.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
                workspace.trim(),
                region.trim()
            );
        }
    }
    // Legacy DashScope endpoint. If the account requires a workspace-specific
    // domain, set DASHSCOPE_WORKSPACE_ID or DASHSCOPE_TTS_URL.
    "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer".to_string()
}

fn synthesize(client: &reqwest::blocking::Client, text: &str) -> Result<Vec<u8>, String> {
    let (_, key) = api_key().ok_or("缺少 DASHSCOPE_API_KEY")?;
    let body = json!({
        "model": TTS_MODEL,
        "input": {
            "text": text,
            "voice": TTS_VOICE,
            "format": "mp3",
            "sample_rate": 24000,
            // HTTP API 的合成参数放在 input 内；1.1 = 语速稍快。
            "rate": 1.1,
            "pitch": 1.0,
            "volume": 50,
        }
    });
    let response = client
        .post(endpoint())
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .header("X-DashScope-SSE", "enable")
        .json(&body)
        .send()
        .map_err(|error| format!("请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(format!(
            "HTTP {}：{}",
            status.as_u16(),
            text.chars().take(300).collect::<String>()
        ));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut audio = Vec::new();
    let mut url: Option<String> = None;

    if content_type.contains("text/event-stream") {
        let reader = BufReader::new(response);
        for line in reader.lines() {
            let line = line.map_err(|error| format!("读取音频流失败：{error}"))?;
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            collect_audio(&value, &mut audio, &mut url);
        }
    } else if content_type.starts_with("audio/") {
        audio = response
            .bytes()
            .map_err(|error| format!("读取音频失败：{error}"))?
            .to_vec();
    } else {
        let value: Value = response
            .json()
            .map_err(|error| format!("解析响应失败：{error}"))?;
        collect_audio(&value, &mut audio, &mut url);
    }

    if audio.is_empty() {
        if let Some(url) = url {
            let download = client
                .get(url)
                .send()
                .map_err(|error| format!("下载音频失败：{error}"))?;
            if !download.status().is_success() {
                return Err(format!("音频 URL HTTP {}", download.status().as_u16()));
            }
            audio = download
                .bytes()
                .map_err(|error| format!("读取音频 URL 失败：{error}"))?
                .to_vec();
        }
    }
    if audio.is_empty() {
        return Err("TTS 返回空音频".into());
    }
    Ok(audio)
}

fn collect_audio(value: &Value, audio: &mut Vec<u8>, url: &mut Option<String>) {
    if let Some(data) = value
        .pointer("/output/audio/data")
        .and_then(Value::as_str)
        .filter(|data| !data.is_empty())
    {
        let compact = data.chars().filter(|ch| !ch.is_whitespace()).collect::<String>();
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(compact) {
            audio.extend_from_slice(&bytes);
        }
    }
    if let Some(found) = value
        .pointer("/output/audio/url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
    {
        *url = Some(found.to_string());
    }
}

// shixiaoyu-funny原创，详见bilibili：https://space.bilibili.com/517323821?spm_id_from=333.337.0.0，仅供学习，严禁商用
