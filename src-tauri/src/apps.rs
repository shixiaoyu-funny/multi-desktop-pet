//! Installed-application discovery and launching.
//!
//! The catalog is built once at startup from the Start Menu and `Get-StartApps`.
//! Only names are injected into the system prompt; full launch paths stay local.

use serde_json::Value;
use std::collections::HashSet;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
enum Launch {
    Path(PathBuf),
    AppId(String),
}

#[derive(Clone)]
struct AppEntry {
    name: String,
    launch: Launch,
}

pub struct AppCatalog {
    entries: Vec<AppEntry>,
}

impl AppCatalog {
    pub fn discover() -> Self {
        let mut entries = Vec::new();
        let mut seen = HashSet::new();

        // UWP / Microsoft Store apps.
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let value: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
                let items = match &value {
                    Value::Array(items) => items.clone(),
                    Value::Object(_) => vec![value],
                    _ => Vec::new(),
                };
                for item in items {
                    let Some(name) = item.get("Name").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(app_id) = item.get("AppID").and_then(Value::as_str) else {
                        continue;
                    };
                    let key = name.to_lowercase();
                    if !name.trim().is_empty() && seen.insert(key) {
                        entries.push(AppEntry {
                            name: name.trim().to_string(),
                            launch: Launch::AppId(app_id.to_string()),
                        });
                    }
                }
            }
        }

        // Classic Win32 shortcuts.
        if let Ok(program_data) = std::env::var("ProgramData") {
            scan_shortcuts(
                &PathBuf::from(program_data)
                    .join("Microsoft\\Windows\\Start Menu\\Programs"),
                &mut entries,
                &mut seen,
            );
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            scan_shortcuts(
                &PathBuf::from(app_data)
                    .join("Microsoft\\Windows\\Start Menu\\Programs"),
                &mut entries,
                &mut seen,
            );
        }

        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Self { entries }
    }

    pub fn prompt(&self) -> String {
        if self.entries.is_empty() {
            return "（没有扫描到可用应用）".to_string();
        }
        let names = self
            .entries
            .iter()
            .take(600)
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>()
            .join("、");
        format!("{names}")
    }

    pub fn open(&self, name: &str) -> Result<String, String> {
        let query = name.trim().to_lowercase();
        if query.is_empty() {
            return Err("应用名称为空".into());
        }
        let exact: Vec<&AppEntry> = self
            .entries
            .iter()
            .filter(|entry| entry.name.to_lowercase() == query)
            .collect();
        let matches = if exact.is_empty() {
            self.entries
                .iter()
                .filter(|entry| entry.name.to_lowercase().contains(&query))
                .collect::<Vec<_>>()
        } else {
            exact
        };
        if matches.is_empty() {
            return Err(format!("没有找到应用：{name}"));
        }
        if matches.len() > 1 {
            let candidates = matches
                .iter()
                .take(10)
                .map(|entry| entry.name.clone())
                .collect::<Vec<_>>()
                .join("、");
            return Err(format!("找到多个应用，请指定更准确的名字：{candidates}"));
        }
        let entry = matches[0];
        match &entry.launch {
            Launch::Path(path) => {
                Command::new("explorer")
                    .arg(path)
                    .spawn()
                    .map_err(|error| format!("启动失败：{error}"))?;
            }
            Launch::AppId(app_id) => {
                Command::new("explorer")
                    .arg(format!("shell:AppsFolder\\{app_id}"))
                    .spawn()
                    .map_err(|error| format!("启动失败：{error}"))?;
            }
        }
        Ok(format!("已打开：{}", entry.name))
    }
}

fn scan_shortcuts(dir: &Path, entries: &mut Vec<AppEntry>, seen: &mut HashSet<String>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_shortcuts(&path, entries, seen);
            continue;
        }
        let is_shortcut = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        if !is_shortcut {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let name = stem.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_lowercase();
        if seen.insert(key) {
            entries.push(AppEntry {
                name: name.to_string(),
                launch: Launch::Path(path.clone()),
            });
        }
    }
}
