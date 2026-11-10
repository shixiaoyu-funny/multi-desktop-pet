//! Qwen-Audio-TTS streaming synthesis.
//!
//! The HTTP endpoint supports SSE (`X-DashScope-SSE: enable`). Each
//! `sentence-synthesis` event carries a Base64 WAV fragment; fragments are
//! appended in order to one WAV buffer and returned to the front end as a data
//! URL. No audio is written to disk.

use base64::Engine;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::time::Duration;

const TTS_MODEL: &str = "qwen-audio-3.0-tts-plus";
const TTS_VOICE: &str = "qwen-audio-3.0-tts-plus-longfengyuanquan";
const TTS_URL: &str = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";

fn synthesize(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("TTS 文本为空".into());
    }
    let text: String = text.chars().take(1000).collect();
    let (_, key) = crate::chat::api_key().ok_or("没有配置 DashScope API Key")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("SukiPet/0.1")
        .build()
        .map_err(|error| format!("TTS HTTP 客户端创建失败：{error}"))?;
    let url = std::env::var("SUKI_TTS_URL").unwrap_or_else(|_| TTS_URL.to_string());
    let body = json!({
        "model": TTS_MODEL,
        "input": {
            "text": text,
            "voice": TTS_VOICE,
            "format": "mp3",
            "sample_rate": 24000,
            "rate": 1.2,
            "language_hints": ["zh"]
        }
    });
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .header("X-DashScope-SSE", "enable")
        .json(&body)
        .send()
        .map_err(|error| format!("TTS 请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().unwrap_or_default();
        return Err(format!(
            "TTS HTTP {}：{}",
            status.as_u16(),
            detail.chars().take(300).collect::<String>()
        ));
    }

    let mut audio = Vec::new();
    let mut remote_url = String::new();
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("TTS 流读取失败：{error}"))?;
        if read == 0 {
            break;
        }
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(chunk) = value
            .pointer("/output/audio/data")
            .and_then(Value::as_str)
            .filter(|chunk| !chunk.is_empty())
        {
            if let Ok(mut bytes) = base64::engine::general_purpose::STANDARD.decode(chunk) {
                audio.append(&mut bytes);
            }
        }
        if let Some(url) = value
            .pointer("/output/audio/url")
            .and_then(Value::as_str)
            .filter(|url| url.starts_with("http"))
        {
            remote_url = url.to_string();
        }
    }

    if audio.is_empty() && !remote_url.is_empty() {
        let download = client
            .get(&remote_url)
            .send()
            .map_err(|error| format!("TTS 音频下载失败：{error}"))?;
        if !download.status().is_success() {
            return Err(format!("TTS 音频下载 HTTP {}", download.status().as_u16()));
        }
        audio = download
            .bytes()
            .map_err(|error| format!("TTS 音频读取失败：{error}"))?
            .to_vec();
    }
    if audio.is_empty() {
        return Err("TTS 没有返回音频".into());
    }
    Ok(format!(
        "data:audio/mpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(audio)
    ))
}

#[tauri::command]
pub async fn tts_speak(text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || synthesize(&text))
        .await
        .map_err(|error| format!("TTS 任务失败：{error}"))?
}

// shixiaoyu-funny原创，详见bilibili：https://space.bilibili.com/517323821?spm_id_from=333.337.0.0，仅供学习，严禁商用
