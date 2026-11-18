//! 统一的好感度（养成）系统 —— 同时服务 Raven 与 Suki。
//!
//! 每个角色有自己的一套阶段定义（阈值、命名、加减分上下限），
//! 但积分、落盘、裁剪、阶段查询共用同一份逻辑，避免两套实现漂移。
//!
//! 阶段由「分数阈值」驱动，人物专属的**台词/语气提示词**放在 `chat.rs` 的
//! `stage_prompt` 里（那里才知道当前是谁在说话）。
//! shixiaoyu

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 一个好感度阶段：分数 >= min 且小于下一个阶段的 min 时生效。
#[derive(Clone, Copy, Debug)]
pub struct StageDef {
    pub min: i64,
    pub key: &'static str,
    pub label: &'static str,
    /// 正分裁剪范围 (min, max)
    pub pos: (i64, i64),
    /// 负分裁剪范围（用正数表示幅度，实际取负）
    pub neg: (i64, i64),
}

/// 角色专属阶段表。按 min 从大到小排列，方便二分定位当前阶段。
#[derive(Clone, Copy, Debug)]
pub struct AffectionProfile {
    pub id: &'static str,
    pub stages: &'static [StageDef],
}

pub const RAVEN: AffectionProfile = AffectionProfile {
    id: "raven",
    stages: &[
        StageDef {
            min: 1000,
            key: "close",
            label: "卸下防备",
            pos: (3, 15),
            neg: (1, 5),
        },
        StageDef {
            min: 300,
            key: "warming",
            label: "勉强认可",
            pos: (2, 10),
            neg: (2, 8),
        },
        StageDef {
            min: -29,
            key: "cold",
            label: "高冷防备",
            pos: (2, 7),
            neg: (1, 5),
        },
        StageDef {
            min: i64::MIN,
            key: "hostile",
            label: "极度反感",
            pos: (1, 5),
            neg: (3, 10),
        },
    ],
};

pub const SUKI: AffectionProfile = AffectionProfile {
    id: "suki",
    stages: &[
        StageDef {
            min: 600,
            key: "clingy",
            label: "超级黏人精",
            pos: (5, 15),
            neg: (1, 3),
        },
        StageDef {
            min: 300,
            key: "playful",
            label: "活泼爱撒娇",
            pos: (3, 10),
            neg: (2, 10),
        },
        StageDef {
            min: -29,
            key: "guarded",
            label: "拘谨讨好",
            pos: (2, 8),
            neg: (1, 6),
        },
        StageDef {
            min: i64::MIN,
            key: "despair",
            label: "绝望黑化",
            pos: (1, 3),
            neg: (5, 15),
        },
    ],
};

/// 林德维恩 —— 平易近人、有点任性的总务官；工作与私下判若两人，爱把身边人吹成传说。
pub const LINDEVERNE: AffectionProfile = AffectionProfile {
    id: "lindverne",
    stages: &[
        StageDef {
            min: 1000,
            key: "confidant",
            label: "并肩同谋",
            pos: (3, 15),
            neg: (1, 5),
        },
        StageDef {
            min: 300,
            key: "familiar",
            label: "熟络亲近",
            pos: (3, 10),
            neg: (2, 7),
        },
        StageDef {
            min: -29,
            key: "curious",
            label: "初识好奇",
            pos: (2, 8),
            neg: (1, 5),
        },
        StageDef {
            min: i64::MIN,
            key: "aloof",
            label: "公事公办",
            pos: (1, 4),
            neg: (3, 10),
        },
    ],
};

/// 阿哈 —— 欢愉星神。「好感」对祂来说只是「这玩具耐不耐玩」的刻度，
/// 所以阶段的命名全是乐子人的口吻，而不是亲密度。
pub const AHA: AffectionProfile = AffectionProfile {
    id: "aha",
    stages: &[
        StageDef {
            min: 1000,
            key: "prime",
            label: "首席乐子",
            pos: (3, 15),
            neg: (1, 5),
        },
        StageDef {
            min: 300,
            key: "amused",
            label: "有点意思",
            pos: (3, 12),
            neg: (1, 6),
        },
        StageDef {
            min: -29,
            key: "toy",
            label: "新玩具",
            pos: (2, 8),
            neg: (1, 5),
        },
        StageDef {
            min: i64::MIN,
            key: "bored",
            label: "无聊透顶",
            pos: (1, 5),
            neg: (3, 10),
        },
    ],
};

#[derive(Serialize, Deserialize, Default)]
struct AffectionFile {
    #[serde(default)]
    score: i64,
}

#[derive(Clone)]
pub struct Affection {
    score: i64,
    path: PathBuf,
    profile: AffectionProfile,
}

impl Affection {
    pub fn load(dir: &PathBuf, profile: AffectionProfile) -> Self {
        // 每个角色独立落盘，互不串分
        let path = dir.join(format!("affection_{}.json", profile.id));
        let score = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<AffectionFile>(&text).ok())
            .map(|file| file.score)
            .unwrap_or(0)
            .clamp(-9999, 9999);
        Self {
            score,
            path,
            profile,
        }
    }

    pub fn profile(&self) -> AffectionProfile {
        self.profile
    }

    pub fn score(&self) -> i64 {
        self.score
    }

    pub fn stage(&self) -> &'static StageDef {
        self.profile
            .stages
            .iter()
            .find(|stage| self.score >= stage.min)
            .unwrap_or(&self.profile.stages[0])
    }

    pub fn stage_key(&self) -> &'static str {
        self.stage().key
    }

    pub fn stage_label(&self) -> &'static str {
        self.stage().label
    }

    /// 按当前阶段把 delta 裁剪到允许范围。
    pub fn clamp_delta(&self, delta: i64) -> i64 {
        let stage = self.stage();
        if delta > 0 {
            delta.clamp(stage.pos.0, stage.pos.1)
        } else if delta < 0 {
            -((-delta).clamp(stage.neg.0, stage.neg.1))
        } else {
            0
        }
    }

    /// 应用裁剪后的变化并落盘，返回最新总分。
    pub fn apply_delta(&mut self, delta: i64) -> i64 {
        let delta = self.clamp_delta(delta);
        if delta == 0 {
            return self.score;
        }
        self.set_score(self.score + delta)
    }

    /// 固定加/减分（如喝奶茶这类明确奖励），不受阶段上下限影响。
    pub fn add_points(&mut self, delta: i64) -> i64 {
        if delta == 0 {
            return self.score;
        }
        self.set_score(self.score + delta)
    }

    pub fn set_score(&mut self, score: i64) -> i64 {
        self.score = score.clamp(-9999, 9999);
        let _ = fs::write(
            &self.path,
            serde_json::to_string_pretty(&AffectionFile { score: self.score })
                .unwrap_or_else(|_| "{}".into()),
        );
        self.score
    }

    pub fn status(&self) -> serde_json::Value {
        let stage = self.stage();
        serde_json::json!({
            "score": self.score,
            "stage": stage.key,
            "label": stage.label,
            "delta": {
                "positive": [stage.pos.0, stage.pos.1],
                "negative": [-stage.neg.1, -stage.neg.0],
            },
        })
    }
}
