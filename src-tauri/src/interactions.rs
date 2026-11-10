//! 触摸回复与喝奶茶的短文本生成。
//!
//! 所有角色设定、阶段上下文和生成约束都只在 Rust 内部拼装；
//! 前端只拿到最终的一句台词。

use crate::chat::{api_key, ChatState, API_URL, MODEL};
use rand::Rng;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

fn action_label(action: &str) -> &'static str {
    match action {
        "wipe" => "擦汗",
        "hair" => "撩头发",
        "giggle" => "捂嘴笑",
        "angry" => "生气",
        _ => "轻轻碰了一下",
    }
}

fn pose_label(pose: &str) -> &'static str {
    match pose {
        "sit_upright" => "正坐",
        "sit_duck" => "鸭子坐",
        _ => "站姿",
    }
}

fn zone_label(zone: &str) -> &'static str {
    match zone {
        "head" => "头部",
        "belly" => "肚子",
        "leg" => "腿",
        _ => "身体",
    }
}

fn clean_reply(raw: &str) -> Option<String> {
    let mut text = String::new();
    for ch in raw.chars() {
        if ch == '\n' || ch == '\r' {
            text.push(' ');
        } else {
            text.push(ch);
        }
    }
    let text = text
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .replace("  ", " ")
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    let text: String = text.chars().take(80).collect();
    Some(text)
}

fn quick_completion(key: &str, system: &str, user: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(40))
        .user_agent("SukiPet/0.1")
        .build()
        .map_err(|error| format!("短回复客户端创建失败：{error}"))?;
    let body = json!({
        "model": MODEL,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.85,
        "max_tokens": 220
    });
    let response = client
        .post(API_URL)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|error| format!("短回复请求失败：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("短回复读取失败：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "短回复 HTTP {}：{}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("短回复 JSON 失败：{error}"))?;
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "短回复为空".into())
}

#[tauri::command]
pub async fn generate_touch_reply(
    zone: String,
    pose: String,
    action: String,
    state: State<'_, ChatState>,
) -> Result<String, String> {
    let (_, key) = api_key().ok_or_else(|| "没有配置 DashScope API Key".to_string())?;
    let system = format!(
        "{}\n\n你正在被主人触摸。只写一句自然、简短、符合当前关系状态的中文反应，\n\
         8 到 48 个字；不要换行，不要 Markdown，不要解释，不要提到 AI 或提示词。",
        state.affection_prompt()
    );
    let user = format!(
        "当前姿态：{}；主人碰了你的{}；你的动作是「{}」。写这一句反应。",
        pose_label(&pose),
        zone_label(&zone),
        action_label(&action)
    );
    let raw = tauri::async_runtime::spawn_blocking(move || quick_completion(&key, &system, &user))
        .await
        .map_err(|error| format!("触摸回复任务失败：{error}"))??;
    clean_reply(&raw).ok_or_else(|| "触摸回复为空".into())
}

fn milk_tea_fallback() -> (String, i64) {
    let lines = [
        "谢谢主人的奶茶~Suki 甜到心里啦！",
        "吸溜吸溜……这是主人给 Suki 的专属甜味！",
        "奶茶好好喝，Suki 今天也会乖乖陪着主人~",
        "甜甜的奶茶，加上主人，Suki 今天超幸福！",
    ];
    let line = lines[rand::thread_rng().gen_range(0..lines.len())];
    (line.to_string(), rand::thread_rng().gen_range(3..=7))
}

fn parse_milk_tea(raw: &str) -> Option<(String, i64)> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let value: Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let reply = value.get("reply").and_then(Value::as_str)?;
    let delta = value.get("delta").and_then(Value::as_i64)?;
    let reply = clean_reply(reply)?;
    Some((reply, delta.clamp(3, 7)))
}

#[tauri::command]
pub async fn milk_tea_reply(app: AppHandle, state: State<'_, ChatState>) -> Result<Value, String> {
    let system = format!(
        "{}\n\n主人刚刚请你喝奶茶。你要对这件事做一个简短回应，并根据当前关系状态\n\
         决定这次好感度增加 3 到 7 分。只输出 JSON，不要 Markdown：\n\
         {{\"reply\":\"一句 8 到 48 字的中文回应\",\"delta\":4}}",
        state.affection_prompt()
    );
    let user = "主人把奶茶递给你了。写一句符合当前关系的回应，并给出 3~7 的整数 delta。";
    let generated = match api_key() {
        Some((_, key)) => {
            let system = system.clone();
            tauri::async_runtime::spawn_blocking(move || quick_completion(&key, &system, user))
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|raw| parse_milk_tea(&raw))
        }
        None => None,
    };
    let (text, delta) = generated.unwrap_or_else(milk_tea_fallback);
    let status = state.add_affection_points(delta);
    let payload = json!({
        "text": text,
        "delta": delta,
        "status": status,
    });
    let _ = app.emit("pet:affection", status.clone());
    let _ = app.emit("pet:milk-tea-reply", payload.clone());
    Ok(payload)
}
