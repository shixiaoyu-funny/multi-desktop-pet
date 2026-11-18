//! 每日两次的「饮品互动」次数管理与动作触发（按角色隔离）。
//!
//! 动作和名称都从 `lib::CHARACTERS` 取，所以蕾文/Suki 是「奶茶」，
//! 林德维恩是「茶饮」——各自素材各自命名，不在这里硬编码。
//! https://space.bilibili.com/517323821?spm_id_from=333.1007.0.0

use chrono::Local;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const DAILY_LIMIT: u32 = 2;

#[derive(Default, Serialize, Deserialize)]
struct MilkTeaFile {
    #[serde(default)]
    date: String,
    /// character id -> 今日已喝杯数
    #[serde(default)]
    counts: HashMap<String, u32>,
}

pub struct MilkTeaState {
    inner: Mutex<MilkTeaFile>,
    path: PathBuf,
}

impl MilkTeaState {
    pub fn new(dir: PathBuf) -> Self {
        let path = dir.join("milk_tea.json");
        let mut file = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<MilkTeaFile>(&text).ok())
            .unwrap_or_default();
        let today = today();
        if file.date != today {
            file.date = today;
            file.counts.clear();
            let _ = save(&path, &file);
        }
        Self {
            inner: Mutex::new(file),
            path,
        }
    }

    fn status_value(&self, character: &str) -> Value {
        let file = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let count = file.counts.get(character).copied().unwrap_or(0).min(DAILY_LIMIT);
        json!({
            "date": file.date,
            "count": count,
            "remaining": DAILY_LIMIT.saturating_sub(count),
            "limit": DAILY_LIMIT,
        })
    }

    /// 清空记忆时一并恢复今天的饮品额度。
    pub fn reset_today(&self, character: &str) -> Value {
        {
            let mut file = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            file.date = today();
            file.counts.clear();
            let _ = save(&self.path, &file);
        }
        self.status_value(character)
    }

    fn consume(&self, character: &str) -> Result<(u32, u32), (u32, u32)> {
        let today = today();
        let mut file = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if file.date != today {
            file.date = today;
            file.counts.clear();
            let _ = save(&self.path, &file);
        }
        let count = file.counts.get(character).copied().unwrap_or(0);
        if count >= DAILY_LIMIT {
            return Err((0, count));
        }
        let next = count + 1;
        file.counts.insert(character.to_string(), next);
        let _ = save(&self.path, &file);
        Ok((DAILY_LIMIT.saturating_sub(next), next))
    }
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn save(path: &PathBuf, file: &MilkTeaFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(file).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn milk_tea_status(state: State<'_, MilkTeaState>, character: String) -> Value {
    state.status_value(&character)
}

/// 请你喝一杯：消耗一次今日额度，随机挑一个该角色的饮品动作，广播给前端播放。
#[tauri::command]
pub fn drink_milk_tea(
    app: AppHandle,
    state: State<'_, MilkTeaState>,
    character: String,
) -> Value {
    let actions = crate::character_of(&character).drink_actions;
    if actions.is_empty() {
        return json!({
            "ok": false,
            "reason": "no_drink_action",
        });
    }
    match state.consume(&character) {
        Ok((remaining, count)) => {
            let variant = actions[rand::thread_rng().gen_range(0..actions.len())];
            let _ = app.emit(
                "pet:milk-tea",
                json!({ "character": character, "action": variant, "remaining": remaining, "count": count }),
            );
            json!({
                "ok": true,
                "action": variant,
                "remaining": remaining,
                "count": count,
                "limit": DAILY_LIMIT,
            })
        }
        Err((remaining, count)) => json!({
            "ok": false,
            "remaining": remaining,
            "count": count,
            "limit": DAILY_LIMIT,
            "reason": "daily_limit",
        }),
    }
}
