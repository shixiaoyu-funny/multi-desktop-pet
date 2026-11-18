//! 触摸回复与饮品互动的短文本生成（按角色生成对应人设台词）。

use crate::chat::{api_key, full_persona, ChatState, MODEL};
use rand::Rng;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 触摸加好感的节流窗口：同一角色 30 秒内只计一次，
/// 免得对着桌宠一顿猛点就把好感刷满。
const TOUCH_GAIN_COOLDOWN: Duration = Duration::from_secs(30);

fn last_touch_gain() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 这次触摸该加多少好感：过了冷却给 +1，否则 0。
fn touch_gain(character: &str) -> i64 {
    let mut map = last_touch_gain().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    match map.get(character) {
        Some(last) if now.duration_since(*last) < TOUCH_GAIN_COOLDOWN => 0,
        _ => {
            map.insert(character.to_string(), now);
            1
        }
    }
}

/// 饮品名称：蕾文 / Suki 是奶茶，林德维恩是茶饮。
fn drink_label(character: &str) -> &'static str {
    crate::character_of(character).drink_label
}

fn action_label(action: &str) -> &'static str {
    if action.contains("wipe") {
        "擦汗"
    } else if action.contains("hair") {
        "撩头发"
    } else if action.contains("giggle") {
        "捂嘴笑"
    } else if action.contains("angry") || action.contains("cross") {
        "生气"
    } else if action.contains("laugh") {
        "大笑"
    } else if action.contains("tea_drink") || action.contains("milk_tea") || action.contains("drink") {
        "喝了一口饮料"
    } else if action.contains("makeup") {
        "补妆"
    } else if action.contains("static") {
        "被静电电到"
    } else if action.contains("balloon") {
        "玩气球"
    } else {
        "轻轻碰了一下"
    }
}

/// 提示词里怎么称呼「对面那个人」。阿哈不会叫「主人」，换成中性说法。
fn user_addr(character: &str) -> &'static str {
    if character == "aha" {
        "桌上这个人"
    } else {
        "主人"
    }
}

fn pose_label(pose: &str) -> &'static str {
    match pose {
        "sit_upright" => "正坐",
        "sit_side" => "侧坐",
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
    let text = raw
        .chars()
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .collect::<String>();
    let text = text
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .replace("  ", " ")
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(80).collect())
}

fn quick_completion(key: &str, system: &str, user: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(40))
        .user_agent("DuoPet/1.0")
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
    let api_url = std::env::var("DUO_CHAT_API_URL").unwrap_or_else(|_| crate::chat::API_URL.to_string());
    let response = client
        .post(&api_url)
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
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("短回复 JSON 失败：{error}"))?;
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "短回复为空".into())
}

/// 当前角色的完整人设（含好感阶段），供短互动复用。
fn persona_of(state: &ChatState, character: &str) -> String {
    if let Some(affection) = state.affection_snapshot(character) {
        full_persona(character, &affection)
    } else {
        format!("你是 {character}。")
    }
}

/// 被摸之后的反应台词 + 少量好感。
///
/// 返回 `{ text, delta, status }`：`delta` 可能为 0（冷却中），
/// `status` 是最新好感状态，前端直接拿去更新徽章，不用再查一次。
#[tauri::command]
pub async fn generate_touch_reply(
    app: AppHandle,
    zone: String,
    pose: String,
    action: String,
    character: String,
    state: State<'_, ChatState>,
) -> Result<Value, String> {
    // 好感先算好：冷却内的连点不加分，但台词照常给
    let delta = touch_gain(&character);
    let status = if delta != 0 {
        let status = state.add_affection_points(&character, delta);
        let _ = app.emit("pet:affection", status.clone());
        status
    } else {
        state.affection_status(&character)
    };

    let reply = touch_line(&zone, &pose, &action, &character, &state).await;
    Ok(json!({ "text": reply, "delta": delta, "status": status }))
}

async fn touch_line(zone: &str, pose: &str, action: &str, character: &str, state: &ChatState) -> String {
    let fallback = touch_fallback(zone, character);
    let Some((_, key)) = api_key() else {
        return fallback;
    };
    // 阿哈不会叫「主人」，用中性说法，免得模型顺着提示词喊出主人
    let who = user_addr(character);
    let system = format!(
        "{}\n\n你正在被{who}触摸。只写一句自然、简短、符合当前关系状态的中文反应，\n\
         8 到 48 个字；不要换行，不要 Markdown，不要解释，不要提到 AI 或提示词。",
        persona_of(state, character)
    );
    let user = format!(
        "当前姿态：{}；{who}碰了你的{}；你的动作是「{}」。写这一句反应。",
        pose_label(pose),
        zone_label(zone),
        action_label(action)
    );
    tauri::async_runtime::spawn_blocking(move || quick_completion(&key, &system, &user))
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|raw| clean_reply(&raw))
        .unwrap_or(fallback)
}

/// 断网 / 没配 key 时的兜底台词，按部位给几句。
fn touch_fallback(zone: &str, character: &str) -> String {
    let lines: &[&str] = if character == "aha" {
        match zone {
            "head" => &[
                "摸头？小可爱，我的头现在只是借来的，别忘了这一点哦。",
                "你这只手放得很熟练嘛——是错觉，还是你就是这种性格？",
            ],
            "leg" => &[
                "哦？这里也敢碰。行，我记下了，等我想到怎么还回去。",
                "手慢一点，我还没决定这场戏该怎么收场呢。",
            ],
            _ => &[
                "被碰到啦，那我们就正式认识了——你猜我接下来会干什么？",
                "嗯，手感不错。我说的是你的胆子。",
            ],
        }
    } else if character == "lindverne" {
        match zone {
            "head" => &["唔……摸头是副官的权限，你倒是用得挺顺手。", "头发会乱的。……算了，就这一次。"],
            "leg" => &["喂，那里不行。我的耐心也是有限的。", "再碰一下，我就当你在挑衅我了。"],
            _ => &["嗯？想讨我开心的话，光这样可不够。", "手放规矩一点……不过，也没让你拿开。"],
        }
    } else if character == "suki" {
        match zone {
            "head" => &["嘿嘿，被摸头了~Suki 好开心！", "再摸一下嘛，主人~"],
            "leg" => &["呀！主、主人，那里会痒的啦……", "呜……不许偷袭 Suki！"],
            _ => &["主人主人！Suki 在这里哦~", "被主人碰到啦，心跳得好快……"],
        }
    } else {
        match zone {
            "head" => &["……别摸头，头发会乱。", "哼，就一下。就一下而已。"],
            "leg" => &["喂！谁准你碰那里的！", "再靠近我就咬你了。"],
            _ => &["有话就说，别动手动脚。", "……你倒是不怕我。"],
        }
    };
    let line = lines[rand::thread_rng().gen_range(0..lines.len())];
    line.to_string()
}

fn drink_fallback(character: &str) -> (String, i64) {
    let drink = drink_label(character);
    if character == "aha" {
        let lines = [
            format!("{drink}？算你有心。不过我已经在里面动了点手脚……开玩笑的，喝吧。"),
            "咕嘟——唔，气泡在喉咙里炸开的感觉，真好玩。".to_string(),
            format!("我上一个请我喝{drink}的人，现在在给一颗虫子当经纪人了。你也想试试？"),
            "谢啦。这次不整你，就这一次。".to_string(),
        ];
        let line = lines[rand::thread_rng().gen_range(0..lines.len())].clone();
        (line, rand::thread_rng().gen_range(3..=7))
    } else if character == "lindverne" {
        // 她喝的是「茶饮」，台词里不能出现奶茶
        let lines = [
            format!("哦？特意给我准备的{drink}？那我就勉为其难地收下，顺便给你记上一笔功劳～"),
            "呷……温度刚好。看来我的副官很懂行嘛。".to_string(),
            format!("这{drink}不错。要不要听一个关于茶的故事？算了，太短了，编不出气势。"),
            "谢谢你呀。下次我请你，用的当然是你的钱～".to_string(),
        ];
        let line = lines[rand::thread_rng().gen_range(0..lines.len())].clone();
        (line, rand::thread_rng().gen_range(3..=7))
    } else if character == "suki" {
        let lines = [
            format!("谢谢主人的{drink}~Suki 甜到心里啦！"),
            "吸溜吸溜……这是主人给 Suki 的专属甜味！".to_string(),
            format!("{drink}好好喝，Suki 今天也会乖乖陪着主人~"),
            format!("甜甜的{drink}，加上主人，Suki 今天超幸福！"),
        ];
        let line = lines[rand::thread_rng().gen_range(0..lines.len())].clone();
        (line, rand::thread_rng().gen_range(3..=7))
    } else {
        let lines = [
            "哼，既然你都送到手边了……这次就算你有心。".to_string(),
            format!("我、我才不是喜欢{drink}呢，只是不想浪费。"),
            "味道还行吧……就，就还行。".to_string(),
            "看在你这么殷勤的份上，我就收下了。".to_string(),
        ];
        let line = lines[rand::thread_rng().gen_range(0..lines.len())].clone();
        (line, rand::thread_rng().gen_range(3..=7))
    }
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

/// 喝完饮品后的台词 + 好感加分。先由 `drink_milk_tea` 触发动作，再调这里补台词。
///
/// 饮品名称按角色取：蕾文 / Suki 是「奶茶」，林德维恩是「茶饮」。
#[tauri::command]
pub async fn milk_tea_reply(
    app: AppHandle,
    state: State<'_, ChatState>,
    character: String,
) -> Result<Value, String> {
    let drink = drink_label(&character);
    let who = user_addr(&character);
    let system = format!(
        "{}\n\n{who}刚刚请你喝{drink}。你要对这件事做一个简短回应，并根据当前关系状态\n\
         决定这次好感度增加 3 到 7 分。只输出 JSON，不要 Markdown：\n\
         {{\"reply\":\"一句 8 到 48 字的中文回应\",\"delta\":4}}",
        persona_of(&state, &character)
    );
    let user = format!("{who}把{drink}递给你了。写一句符合当前关系的回应，并给出 3~7 的整数 delta。");
    let generated = match api_key() {
        Some((_, key)) => {
            let system = system.clone();
            tauri::async_runtime::spawn_blocking(move || quick_completion(&key, &system, &user))
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|raw| parse_milk_tea(&raw))
        }
        None => None,
    };
    let (text, delta) = generated.unwrap_or_else(|| drink_fallback(&character));
    let status = state.add_affection_points(&character, delta);
    let payload = json!({
        "text": text,
        "delta": delta,
        "status": status,
    });
    let _ = app.emit("pet:affection", status);
    let _ = app.emit("pet:milk-tea-reply", payload.clone());
    Ok(payload)
}
