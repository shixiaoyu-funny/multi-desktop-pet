# Multi_Pet · Windows AI 桌宠

一个运行在 Windows 桌面上的透明置顶桌宠，四名角色合体于同一套软件里。角色是**带透明通道的 WebM 帧动画**，桌面窗口真正「浮」在桌面与窗口上沿，可以拖拽、重力下落、吸附到窗口上沿、点击穿透，还会陪你聊天、记好感、喝奶茶、跟着音乐「弹弹」。

- 作者：shixiaoyu-funny（B 站：<https://space.bilibili.com/517323821>）
- 技术栈：**Tauri 2 + Rust + 原生 HTML/JS/CSS**（无 node 构建链，无前端打包器）

> 本项目仅供个人学习、技术交流与开源研究，严禁商业售卖或盈利性二次分发。

## 角色

| 角色 | 显示名 | 配色 / 人设 | 官方声线（TTS） | 饮品 |
|---|---|---|---|---|
| Raven | 蕾文 | 黑红 · 傲娇 | ✅ | 奶茶 |
| Suki | Suki | 粉蓝 · 元气 | ✅ | 奶茶 |
| Lindverne | 林德维恩 | 白灰蓝 · 总务官 | ❌（版权素材，不合成） | 茶饮 |
| Aha | 阿哈 | 白红 · 欢愉 | ❌ | 气泡饮料 |

没有官方声线的角色只出文字，不用其它声线冒充。饮品名称与动作也随角色各自配置。

## 功能

- **透明桌面窗**：340×340（可切 256 / 384 / 512）无边框、置顶、不进任务栏。
- **点击穿透**：前端把当前帧采样成 192×192 的 alpha 掩膜发给 Rust，光标落在角色像素上才可点，其余区域不挡桌面。
- **拖拽 / 重力 / 吸附**：物理全部在 Rust 侧，16ms 轮询全局光标，不走 JS 每帧 IPC。
  - 拖拽跟手；松手按设置吸附或下落。
  - 吸附是「坐到窗口上沿 / 任务栏上沿」，不是贴屏幕角；会跟随宿主窗口移动，宿主被拖走/最小化/缩小就掉下去。
  - 重力是真实积分下落 + 回弹，从高处砸到任务栏会播「慌张」。
- **AI 聊天**：调用阿里云百炼（DashScope）OpenAI 兼容端点，支持工具调用（B 站搜索、打开本机应用、联网搜索、只读 PowerShell、屏幕截图）。
- **养成系统**：每个角色独立的对话历史、长期摘要与好感度阶段，好感影响语气与台词。
- **饮品互动**：每天每角色 2 次「请喝奶茶 / 茶饮 / 气泡饮料」。
- **语音播报**：TTS 走 SSE 流式合成，内存里拼 MP3 再交给前端播放（不落盘）。
- **弹弹**：脚底钉住，身体按拍子挤压 / 拉伸，倍速 0.5–4 倍，配乐循环播放（默认静音）。
- **全屏静默**：检测到全屏游戏 / 视频时隐藏桌宠并**释放视频解码器**（省显存），退出后恢复原动作。
- **开发者调参面板**：`Ctrl+Shift+D` 打开，可实时调每个动作的缩放 / 偏移 / 气泡位置，以及按「角色 × 姿态 × 尺寸档」的吸附落脚点。
- 单实例、托盘图标、开机自启、启动时把桌宠放到任务栏右下角。

## 目录结构

```
project/
├─ src/                    前端（主窗 index.html + 桌面窗 pet.html）
│  ├─ index.html / app.js  主控制面板（角色切换、预览、聊天、设置、开发者面板）
│  ├─ pet.html / pet.js    桌面漂浮窗（完整动作状态机、拖拽/点击、掩膜采样）
│  ├─ bounce.js            「弹弹」挤压拉伸 + 配乐
│  └─ assets/              角色素材与 manifest
│     ├─ raven/ suki/ lindverne/ aha/
│     │  ├─ manifest.json   动作清单（idle/touch/drink/oneshot/trans）
│     │  ├─ idle/ oneshot/ trans/ …  带 alpha 的 WebM
│     │  └─ …
│     ├─ avatars/           角色头像
│     └─ music/bounce.flac  「弹弹」配乐（相对路径引用）
└─ src-tauri/              Rust 后端
   ├─ tauri.conf.json      双窗口、CSP、打包（nsis）配置
   ├─ Cargo.toml
   └─ src/
      ├─ lib.rs            角色表、配置、窗口创建、托盘、物理轮询线程
      ├─ win.rs            Win32 窗口枚举 / 任务栏 / 全屏判定
      ├─ chat.rs           AI 对话、动作白名单、人设、好感提示词、ReAct 工具循环
      ├─ tools.rs          工具注册表（B 站 / 打开应用 / 联网搜索 / 只读终端 / 截图）
      ├─ affection.rs      好感度阶段与落盘
      ├─ interactions.rs   摸头 / 喝饮品的短台词
      ├─ tts.rs            语音合成
      ├─ milk_tea.rs       每日饮品额度
      └─ apps.rs           本机应用发现与启动
```

## 构建

前置要求：

- Windows 10 / 11，**WebView2 Runtime**
- Rust（1.77+，`stable-x86_64-pc-windows-msvc`）与 MSVC 工具链
- `cargo tauri` 子命令（`cargo install tauri-cli`）

```powershell
cd project/src-tauri
cargo tauri build
```

产物在 `project/src-tauri/target/release/bundle/nsis/`（NSIS 安装包），可执行文件在 `target/release/`。项目 `frontendDist` 直接指向 `../src`，**不需要 npm / pnpm**。

## 配置

AI 聊天与语音需要阿里云百炼 API Key（环境变量）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 聊天 + 语音的鉴权 | 无（必配） |
| `DUO_CHAT_API_URL` | 覆盖聊天端点 | 官方 compatible-mode 端点 |
| `DASHSCOPE_TTS_URL` | 覆盖 TTS 端点 | 官方 DashScope TTS 端点 |
| `DASHSCOPE_WORKSPACE_ID` / `DASHSCOPE_REGION` | 用工作区域名的 TTS 端点 | 无 |
| `RAVEN_TTS` | 置 `0` 关闭语音 | 开启 |

聊天端点回退读取 `QWEN_API_KEY` / `ALIYUN_API_KEY`，也可在 Windows 用户环境变量里设置（后端会读注册表）。

运行时数据（`config.json`、各角色 `chat_history_*.json`、`chat_summary_*.json`、`affection_*.json`、`milk_tea.json`、`tts.json`）写入系统应用配置目录（`%APPDATA%\com.local.duo.winpet`），不会随仓库分发。

## 说明

- 未签名的 exe 首次运行可能触发 SmartScreen，选「仍要运行」即可。
- `弹弹` 的配乐是仓库内 `src/assets/music/bounce.flac`，已改为相对路径引用；缺失时只会静音，不影响其它功能。
- `project/` 下的 `cdp_*.mjs` 是走 CDP（9222 端口）的调试脚本，正常使用不需要。
