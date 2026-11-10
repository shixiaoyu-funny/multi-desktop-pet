//! 每日两次的“喝奶茶”次数管理与动作触发。

use chrono::Local;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const DAILY_LIMIT: u32 = 2;
const DRINK_VARIANTS: [&str; 2] = ["drink_milk_tea_a", "drink_milk_tea_b"];

#[derive(Default, Serialize, Deserialize)]
struct MilkTeaFile {
    #[serde(default)]
    date: String,
    #[serde(default)]
    count: u32,
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
            file.count = 0;
            let _ = save(&path, &file);
        }
        Self {
            inner: Mutex::new(file),
            path,
        }
    }

    fn status_value(&self) -> Value {
        let file = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let remaining = DAILY_LIMIT.saturating_sub(file.count.min(DAILY_LIMIT));
        json!({
            "date": file.date,
            "count": file.count.min(DAILY_LIMIT),
            "remaining": remaining,
            "limit": DAILY_LIMIT,
        })
    }

    /// 清空记忆时一并恢复今天的两杯奶茶。
    pub fn reset_today(&self) -> Value {
        {
            let mut file = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            file.date = today();
            file.count = 0;
            let _ = save(&self.path, &file);
        }
        self.status_value()
    }

    fn consume(&self) -> Result<(u32, u32), (u32, u32)> {
        let today = today();
        let mut file = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if file.date != today {
            file.date = today;
            file.count = 0;
            let _ = save(&self.path, &file);
        }
        if file.count >= DAILY_LIMIT {
            return Err((0, file.count));
        }
        file.count += 1;
        let _ = save(&self.path, &file);
        Ok((DAILY_LIMIT.saturating_sub(file.count), file.count))
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
pub fn milk_tea_status(state: State<'_, MilkTeaState>) -> Value {
    state.status_value()
}

#[tauri::command]
pub fn drink_milk_tea(app: AppHandle, state: State<'_, MilkTeaState>) -> Value {
    match state.consume() {
        Ok((remaining, count)) => {
            let variant = DRINK_VARIANTS[rand::thread_rng().gen_range(0..DRINK_VARIANTS.len())];
            let _ = app.emit(
                "pet:milk-tea",
                json!({ "variant": variant, "remaining": remaining, "count": count }),
            );
            let _ = app.emit(
                "pet:milk-tea-status",
                json!({ "remaining": remaining, "count": count, "limit": DAILY_LIMIT }),
            );
            json!({
                "ok": true,
                "variant": variant,
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
