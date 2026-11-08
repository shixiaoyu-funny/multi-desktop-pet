# Raven · 透明 WebM 桌宠

一个运行在 Windows 桌面的透明 WebM 桌宠。角色以 768×768@60fps 带 Alpha 通道的 VP9 视频渲染，能拖拽、坐在任务栏/其他窗口边缘、受重力掉落、跟随宿主窗口移动，并带一个独立的工具箱窗口、系统托盘图标和 AI 聊天。角色工程代号仍为 `Raven`。

> 桌宠本体（程序）与美术动画是分开的两条线：本仓库负责程序逻辑与运行时；角色动作视频由美术侧产出后，放进 `src/assets/` 并登记到 `src/assets/manifest.json` 即可接入。

### 项目亮点

- **27 个动作素材**：6 个持续待机、12 个一次性动作、6 个姿态过渡、1 个重力慌张、2 版喝奶茶。
- **真正透明的交互**：按角色实际像素 alpha 命中，透明区域鼠标穿透；不是矩形热区。
- **完整的 Win32 桌宠物理**：窗口边缘/任务栏吸附、重力下落、弹跳、跟随宿主窗口横移、5px 预触发慌张。
- **有性格的 AI**：`qwen3.8-flash` 聊天 + 手写 ReAct 工具循环 + 四阶段好感度；记忆可清空，清空前有四段确认。
- **主动陪伴**：检测前台应用，先用 flash 判断“值不值得搭话”，再按 45s / 180s / 420s… 自动看屏幕、冒气泡。
- **语音输出**：`qwen-audio-3.0-tts-plus` + `qwen-audio-3.0-tts-plus-longmohuiling` 音色，语音开始后再吐字。
- **一套素材，两种形态**：Windows/Tauri 桌面版 + DSH Web 插件共用同一套动作与 manifest。

### 下载

Windows x64 便携版（免安装、直接运行 `raven-winpet.exe`）发布在 GitHub Releases：

<https://github.com/shixiaoyu-funny/DSHAndMulti_PlatFormDesktopPet/releases/latest>

> 需要 Windows 10/11 与 WebView2 Runtime；未签名 exe 首次运行可能被 SmartScreen 提示。

---

## 目录

- [项目亮点](#项目亮点)
- [下载](#下载)
- [快速上手](#快速上手)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [动作总览](#动作总览)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [构建与运行](#构建与运行)
- [使用说明](#使用说明)
- [配置说明](#配置说明)
- [动作与缩放 / 偏移](#动作与缩放--偏移)
- [架构与关键实现](#架构与关键实现)
- [命令与事件接口](#命令与事件接口)
- [关键常量速查](#关键常量速查)
- [开发工具](#开发工具)
- [性能](#性能)
- [未来规划](#未来规划)

---

## 快速上手

### 三行跑起来

```bat
cd src-tauri
cargo build
.\target\debug\raven-winpet.exe
```

（或直接双击 `启动桌宠.vbs` 无控制台启动；`启动桌宠.bat` 会显示编译控制台，只建议构建时用。）

### 代码地图：想改什么就动哪

| 想做的事 | 改哪里 | 要重新编译？ |
|---|---|---|
| 换 / 加一个动作视频 | `src/assets/` 放视频 + `src/assets/manifest.json` 登记 | ✅ `cargo build` |
| 调某个动作的显示大小 / 上下偏移 | 开发者面板拖滑杆（存 localStorage），定稿后回填 `manifest.json` | 回填后 ✅ |
| 改桌宠窗口的动画调度逻辑（状态机、交叉淡入、随机切换） | `src/main.js` | ✅ |
| 改工具箱界面的控件 / 布局 | `src/toolbox.html` / `toolbox.js` / `toolbox.css` | ✅ |
| 改拖拽 / 吸附 / 重力 / 窗口摆位逻辑 | `src-tauri/src/lib.rs` | ✅ |
| 改窗口枚举与任务栏探测 | `src-tauri/src/win.rs` | ✅ |
| 改权限白名单 | `src-tauri/capabilities/default.json` | ✅ |
| 查某个动作的 id / 缩放 / 偏移 | `src/assets/manifest.json` | — |

> 注意：`src/` 下所有前端资源在编译时**嵌入 exe**（`frontendDist: "../src"`），所以任何 `src/` 改动都要重新 `cargo build` 才能生效，没有热更新。

### 核心概念一句话

- 桌宠本体 = 一个透明无边框窗口（`pet`）+ 一个按需弹出的工具箱窗口（`toolbox`），两个都是 WebView。
- 两窗口之间**不直接互相调用**，全部走 Tauri 事件（`pet:state` 状态广播 / `pet:command` 操作指令），权威状态在 `pet` 窗口。
- 动作分四类：**持续待机**（空手/持物，随机轮换）、**一次性动作**（擦汗/撩头发/生气/捂嘴笑，播一次回待机）、**过渡**（姿态变化时自动播一次）、**慌张**（重力落地瞬间触发），由 `manifest.json` 的 `loop` / `playable` 字段区分。

---

## 功能特性

- **透明 WebM 渲染**：无边框透明置顶窗口，两层 `<video>` 交叉淡入切换动作，画面极清、透明背景、60fps、内存占用低。
- **鼠标拖拽**：按住角色拖动，窗口实时跟随光标，并限制在屏幕内（允许露半个身子）。
- **鼠标穿透**：光标落在角色**实际像素**上才可交互，落在透明空白处则穿透到下层软件（基于 192×192 alpha 掩膜命中判定，非矩形判定）。
- **窗口边缘 / 任务栏吸附**：松开时若接触点距离某个非最大化窗口上沿或任务栏上沿 ≤ 80px（逻辑像素），自动「坐」上去。
- **重力掉落**：吸附关闭时可开启重力，把角色拎到半空松手会受重力下落，落在**任务栏或任意非最大化窗口的上边缘**上，速度快时先弹跳几次再坐稳。
- **拖拽跟随**：坐着的宿主窗口被拖动时，桌宠跟着平移；宿主最大化/关闭/最小化、或缩窄到接触点失去支撑时，继续受重力往下掉到更低的窗口或任务栏。
- **随机轮换**：随机池包含除慌张外的全部动作；待机动作完整展示所选间隔（3/10/15 分钟）后切换，其他动作播一次回到待机再重新计时；AI 聊天窗口打开时暂停随机。
- **点击互动 + 气泡**：点头部撩头发、点腹部捂嘴笑、正坐时点腿慌张；按当前姿态选对应版本，并随机弹出一句反应台词。
- **AI 聊天**：工具箱「AI 聊天」按钮打开独立聊天窗口，接入阿里云百炼 `qwen3.8-flash`，流式回复、会话记忆、角色设定，并按当前姿态约束动作。
- **姿态状态机 + 过渡动画**：站 ↔ 坐、正坐 ↔ 侧坐之间切换时，自动播放对应的过渡动画（共 6 条），播完落定在目标待机动作；同姿态内切换则不播过渡。
- **慌张挥手**：从超过 **200px** 的高度落到任务栏时播「正坐慌张挥手」一次（本端 1.2 倍速）；高度不足或落到窗口上沿不触发，结束后随机落定正坐或侧坐（落侧坐会自动补一段过渡）。
- **三档尺寸**：大 768 / 中 512 / 小 384（物理像素）。
- **系统托盘 + 独立工具箱窗口**：托盘右键可打开工具箱或退出；工具箱窗口 600×400，不透明、不常驻（关掉即销毁）。
- **AI 聊天 + ReAct 工具**：聊天窗口接入 `qwen3.8-flash`；需要时调用 B站查询、截屏、打开应用、只读沙盒终端等工具，再输出最终回复。
- **四阶段好感度**：好感度从高冷防备到卸下防备，影响语气、工具可用性和动作；工具箱顶栏显示分数与阶段颜色。
- **喝奶茶**：工具箱按钮每天可请她喝 2 次；AI 结合当前好感阶段回应，并在 3~7 分内决定加分。奶茶动作只能由该按钮触发。
- **触摸互动**：站立 / 正坐 / 侧坐都可摸头、肚子、腿，分别触发擦汗或撩发、捂嘴笑、生气；台词池每种 8 条，并会在后台用 AI 生成新台词替换旧池。
- **主动陪伴**：前台应用检测 + flash 判断 + 定时截图，主动冒泡；不写聊天记忆。
- **语音输出**：TTS 与聊天文字同步启动，可在工具箱一键关闭。
- **开机自启**：工具箱开关，使用官方 `tauri-plugin-autostart`，状态写入 `config.json` 并在启动时同步。
- **单实例防多开**：使用官方 `tauri-plugin-single-instance`；重复启动不会创建第二只桌宠，只弹出「本小姐一个人还不够陪你，你还有再开几个？？！」提示。
- **DSH Web 插件**：同一套动作/配置可同步到 DeepSeek Harness 页面内悬浮层。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | [Tauri 2](https://tauri.app)（Rust）+ WebView2 |
| 系统探测 | Win32 API（`windows-sys`：窗口枚举、任务栏、GDI 截屏、DWM、前台进程） |
| 前端 | 原生 HTML / CSS / JS，无构建步骤，无框架 |
| 渲染 | WebM VP9（Alpha 通道），双 `<video>` 交叉淡入 + Canvas alpha 命中 |
| AI 对话 | 阿里云百炼 `qwen3.8-flash`，OpenAI 兼容接口，流式输出 + 多模态图片输入 |
| AI 工具 | 手写 ReAct 循环：B站只读查询、截图、本机应用启动、只读 PowerShell 沙盒 |
| 语音合成 | `qwen-audio-3.0-tts-plus`，音色 `qwen-audio-3.0-tts-plus-longmohuiling`，HTTP SSE |
| 主动陪伴 | 前台窗口/进程轮询 + flash gate + 定时截图 + 无记忆气泡 |
| 数据 | JSON 配置 / 聊天历史 / 好感度 / TTS 开关，前端 localStorage 保存调参值 |

前端资源由 Tauri 编译时嵌入 exe（`frontendDist: "../src"`），因此**改动 `src/` 下任何文件后必须重新 `cargo build` 才生效**。

---

## 目录结构

```
Desktop_Pet/
├── 启动桌宠.bat               # 一键编译 + 启动（Windows）
├── 同步到DSH.bat              # 把插件代码与素材同步到 DSH 的部署副本
├── 可选功能.md                # 功能路线与现状对照（✅/⚠️/□）
├── tools/
│   └── sync-plugin.ps1        # 上者调用的同步脚本（镜像 + 漂移检查）
├── src/                       # 前端（编译时嵌入 exe）
│   ├── index.html             # 桌宠窗口
│   ├── main.js                # 桌宠控制器（动作/姿态/缩放/通信/语音播放）
│   ├── style.css              # 桌宠窗口样式
│   ├── toolbox.html           # 工具箱窗口（姿态 / 间隔 / 语音 / 好感度）
│   ├── toolbox.js             # 工具箱逻辑（纯 UI，事件驱动）
│   ├── toolbox.css            # 工具箱样式
│   ├── chat.html / chat.js / chat.css       # AI 聊天窗口
│   ├── setup.html / setup.js / setup.css    # API Key 配置页
│   └── assets/
│       ├── manifest.json      # 动作池 / 姿态 / 缩放 / 偏移配置
│       ├── idle/              # 6 个持续循环的待机视频（空手 / 持花 / 手机 / 书籍 / 正坐 / 侧坐）
│       │   ├── 站姿待机.webm
│       │   ├── 站姿鲜花.webm
│       │   ├── 站姿手机.webm
│       │   ├── 站姿书籍.webm
│       │   ├── 正坐待机.webm
│       │   └── 侧坐单手撑.webm
│       ├── oneshot/           # 13 个一次性动作（擦汗 / 撩头发 / 生气 / 捂嘴笑 / 慌张挥手）
│       ├── special/           # 2 版喝奶茶；只允许工具箱按钮触发
│       └── trans/             # 6 个过渡动画（站↔坐、正坐↔侧坐）
│           ├── 过渡_站到正坐.webm
│           ├── 过渡_站到侧坐.webm
│           ├── 过渡_正坐到站.webm
│           ├── 过渡_侧坐到站.webm
│           ├── 过渡_侧坐到正坐.webm
│           └── 过渡_正坐到侧坐.webm
└── src-tauri/                 # Rust 后端
    ├── Cargo.toml
    ├── tauri.conf.json        # 窗口 / 安全 / 打包配置
    ├── capabilities/
    │   └── default.json       # ACL 权限（event / window / webview 等）
    ├── icons/                 # 托盘与应用图标
    └── src/
        ├── main.rs            # 入口（GUI subsystem，无控制台）
        ├── lib.rs             # 主逻辑（轮询 / 吸附 / 重力 / 命令 / 托盘）
        ├── win.rs             # Win32 窗口探测模块
        ├── chat.rs            # AI 聊天 / ReAct / 好感度 / 历史
        ├── ambient.rs         # 前台应用检测 / 主动陪伴 / 定时截图
        ├── apps.rs            # 本机应用扫描与启动
        ├── tools.rs           # 工具注册表 / B站 / 截图 / 终端 / open_app
        ├── tts.rs             # Qwen-Audio-TTS 流式合成
        └── bin/
            └── winscan.rs     # 开发用：打印可坐窗口与任务栏
```

---

## 环境要求

- **Windows 10/11**（依赖 WebView2 Runtime；Tauri 打包时已配 `downloadBootstrapper` 自动引导安装）
- **Rust 1.77+**（含 `cargo`）
- **MSVC 生成工具**（`cl.exe` + Windows SDK，用于链接 `windows-sys`）
  - 本项目本机环境：`D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat`
- FFmpeg（仅当需要自己转码动作视频时用到，运行桌宠不需要）

---

## 构建与运行

### 方式一：`启动桌宠.bat`

脚本做了三件事：加载 MSVC 环境 → `cargo build`（增量编译）→ 启动 `target\debug\raven-winpet.exe`。

```bat
启动桌宠.bat
```

脚本假定 MSVC 在 `D:\BuildTools`，路径不对就改脚本里的 `VCVARS` 变量。

日常启动建议双击 `启动桌宠.vbs`：它直接以隐藏窗口方式启动 `raven-winpet.exe`，不会弹黑色控制台；`角色启动时枚举应用/命令行工具` 的子进程也都使用 `CREATE_NO_WINDOW`，不会闪黑框。

### 方式二：手动

```powershell
# 1. 加载 MSVC 环境（路径按本机调整）
cmd /c "D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set

# 2. 编译（开发版）
cd src-tauri
cargo build

# 3. 运行
.\target\debug\raven-winpet.exe
```

### 发布版

```powershell
cd src-tauri
cargo build --release   # 产物 target\release\raven-winpet.exe
```

`Cargo.toml` 已配 `opt-level = "s"`、`lto = true`、`codegen-units = 1`、`strip = true`，发布版体积小、无控制台窗口（`main.rs` 里 `windows_subsystem = "windows"`）。

---

## 使用说明

### 桌宠本体

| 操作 | 行为 |
|---|---|
| 左键按住角色 | 拖拽移动（限制在屏幕内） |
| 左键点击头部 | 撩头发 + 随机气泡 |
| 左键点击腹部 | 捂嘴笑 + 随机气泡 |
| 正坐时点击腿部 | 慌张一次 + 随机气泡 |
| 右键 | 打开工具箱窗口 |
| 托盘图标右键 | 「打开工具箱窗口」/「退出」 |

### 工具箱窗口

打开后左侧只有**站立 / 正坐 / 侧坐**三个姿态入口；其他一次性动作不在普通界面展示，由随机、AI、点击互动或重力事件触发。右侧是设置项：右上角的 **AI 聊天** 按钮会打开聊天窗口；没有配置 Key 时会自动打开配置页。

- **大小**：大 / 中 / 小（768 / 512 / 384 物理像素）
- **随机切换动作**：开关；切换间隔可选 3 / 10 / 15 分钟。待机动作保持完整间隔，非待机动作播一次后回到待机并重置计时；AI 聊天窗口打开期间暂停。
- **窗口置顶**
- **坐在窗口边缘**：开启吸附（与重力互斥，开吸附自动关重力）
- **重力掉落**：吸附关闭时才可用
- **开发者入口**：当前已隐藏（桌面工具箱和 DSH 菜单都不显示入口），代码和面板保留，后续需要再恢复。坐线值固定为：小档正坐 20 / 侧坐 6，中档 27 / 8，大档 40 / 12（逻辑像素，仅吸附时生效）。

> 工具箱不持有权威状态：它只订阅桌宠窗口广播的 `pet:state`，操作通过 `pet:command` 事件发回桌宠窗口落地，再回推新状态。

---

## AI 聊天

工具箱右上角的 **AI 聊天** 按钮会打开独立聊天窗口。第一次使用前需要配置阿里云百炼的 API Key：

1. 打开 [百炼控制台](https://bailian.console.aliyun.com/?apiKey=1) 创建 API Key；
2. 设置用户环境变量 `DASHSCOPE_API_KEY`（PowerShell：`setx DASHSCOPE_API_KEY "sk-..."`）；
3. 如果桌宠已经在运行，在配置页点「重新检测」；仍读不到再从托盘退出并重新打开。

没有检测到 Key 时，点「AI 聊天」会自动打开配置页，而不是直接进聊天。Key 只从环境变量读取，不会写进会话文件或仓库。

- **模型**：`qwen3.8-flash`，接口为百炼 OpenAI 兼容模式 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`。
- **角色**：Raven，黑长直、红瞳、黑红制服、金色发饰；傲娇、爱挑逗、嘴硬心软。
- **流式输出**：SSE 增量返回，聊天窗口边收边显示。
- **会话记忆**：最近 40 条消息保存在 `%APPDATA%\com.local.raven.winpet\chat_history.json`，重启后保留；聊天窗口的「清空」会同时清空内存和文件。
- **聊天时保持姿态**：打开聊天窗口后暂停随机，并保持打开前的姿态；如果当前正在演表情/慌张，会回到该姿态的待机（站姿待机 / 正坐待机 / 侧坐单手撑），不会停在最后一帧。
- **动作约束**：每次请求都会把当前姿态（站姿 / 正坐 / 侧坐）和该姿态允许的动作表加入模型上下文；动作表包含英文 id、中文名称、含义/使用时机，并要求模型只输出英文 id。模型返回 `{"reply":"...","action":"...","score":...}` 后，后端校验 JSON 能否解析、action 是否在当前列表中；失败会自动重新生成，最多重试 10 次。仍失败则回复兜底台词「本小姐现在不想理你，给我点时间静静......」，不会把坏格式发出去。
- **动作触发**：模型返回的动作通过 `pet:ai-action` 发给桌宠窗口，播放一次后回到当前姿态待机；回复文本同时显示在聊天窗口和桌宠气泡里。

### 好感度系统

好感度总分保存在 `%APPDATA%\com.local.raven.winpet\affinity.json`。模型在 JSON 里返回 `score` 变化值，服务端按当前阶段限制范围后累加：

| 阶段 | 分数 | 扣分范围 | 加分范围 |
|---|---:|---:|---:|
| 极度反感 | ≤ -30 | 3~10 | 1~5 |
| 高冷防备 | -29~299 | 1~5 | 2~7 |
| 勉强认可 | 300~999 | 2~8 | 2~10 |
| 卸下防备 | ≥ 1000 | 1~5 | 3~15 |

阶段会动态影响角色语气与行为。极度反感阶段不向模型提供工具，且动作必须使用当前姿态的生气/无视动作（站姿 `stand_angry` / `stand_phone`，正坐 `sit_angry`，侧坐 `sit_side_angry`）。JSON 校验失败时聊天窗口状态显示「思考中」。

聊天窗口的「清空」会先经过四段确认，确认后同时清空聊天历史、好感度（回到 0）和当天喝奶茶次数（恢复为 0/2）。

### 语音输出（TTS）

工具箱「语音输出」开关控制是否朗读 AI 回复和主动陪伴气泡：

- 模型：`qwen-audio-3.0-tts-plus`
- 音色：`qwen-audio-3.0-tts-plus-longmohuiling`
- 官方 HTTP `input.rate` 设为 `1.1`，由服务端合成稍快语速；前端 `playbackRate` 保持 1.0，不叠加；
- 使用官方 HTTP + SSE 流式合成，服务端在内存中合并 MP3 音频块，再以 base64 交给桌宠前端播放；
- 不写本地音频文件，也不上传 OSS；音频只在内存和 WebView Blob 中存在；
- 新语音会停止上一条语音；
- 开关状态保存在 `%APPDATA%\com.local.raven.winpet\tts.json`。

默认使用 `https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`。如果账号要求业务空间专属域名，可以设置：

```powershell
setx DASHSCOPE_WORKSPACE_ID "你的业务空间ID"
# 或完全自定义端点
setx DASHSCOPE_TTS_URL "https://..../api/v1/services/audio/tts/SpeechSynthesizer"
```

## 工具浏览（ReAct）

聊天已改为手写 ReAct：模型可先调用工具，拿到结果后再输出最终 JSON。当前工具：

- **Bilibili（已可用）**：`bilibili_search`、`bilibili_popular`、`bilibili_video`、`bilibili_user`，公开只读接口，不需要登录。搜索使用 WBI 签名 + `buvid` Cookie；遇到 B站 412 会自动刷新会话重试一次，降低风控拦截概率。
- **capture_screen**：截取当前主屏幕，压缩成 JPEG 后以 `image_url` 的 base64 附加给 `qwen3.8-flash`；需要看用户屏幕时使用。
- **open_app**：启动时扫描 Start Menu / `Get-StartApps`，把可用应用目录加入模型上下文；用户说“打开某软件”时按应用名匹配并启动实际快捷方式。
- **sandbox_terminal**：只读 PowerShell 沙盒终端，只允许 `Get-*`、`where`、`whoami`、`dir`、`echo` 等查询；禁止写入、删除、启动进程、网络请求和管道，超时 12 秒。

工具全部通过统一 `ToolRegistry` 注入；当前不支持下单、支付、发消息、上传/下载。

## 主动陪伴

启动后会检测当前前台应用（1 秒轮询），先经过本地硬排除，再让 `qwen3.8-flash` 判断“这个软件值不值得主动搭话”：

- 文件资源管理器、设置、任务管理器、系统组件、桌宠自己 → 直接静默，不请求 AI；
- 浏览器/微信/QQ → 可以说话，但默认不截图；
- B站、VS Code、Office、Steam 等 → 判断通过后显示打开气泡；
- 未知应用默认只判断，不开放截图。

通过判断后：

- 约 3 秒稳定后显示一条打开气泡；
- 在 45 秒、180 秒、420 秒、660 秒、900 秒……（`180 + n×240`）自动截当前前台窗口发给模型，生成一条陪伴气泡；
- 气泡不写 `chat_history.json`，不进入聊天记忆；
- 截图只截前台窗口，截前临时隐藏桌宠；浏览器/社交/全屏/空闲/聊天窗口打开时跳过；
- 同一应用打开气泡 30 分钟冷却，全局气泡最小间隔 20 秒，每小时最多 12 张截图。

可用环境变量关闭：

```powershell
setx RAVEN_AMBIENT 0              # 关闭整个主动陪伴
setx RAVEN_AMBIENT_SCREENSHOTS 0  # 只关闭自动截图
```

`ambient_probe` 命令（调试用）可查看当前前台应用、分类、gate 状态和空闲状态。截图仍然只在内存中转 Base64，不落盘、不上 OSS。

---

## 配置说明

### 运行时配置 `config.json`

桌宠的偏好设置存放在系统应用配置目录（Tauri `app_config_dir`），本机为：

```
%APPDATA%\com.local.raven.winpet\config.json
```

字段（自动落盘，一般无需手改）：

```json
{
  "version": 2,
  "size": "medium",
  "cx": 960, "cy": 540,
  "alwaysOnTop": true,
  "random": true,
  "interval": 180,
  "action": "stand_idle",
  "snap": false,
  "gravity": false,
  "snapOffsetUprightSmall": 20,
  "snapOffsetUprightMedium": 27,
  "snapOffsetUprightLarge": 40,
  "snapOffsetSideSmall": 6,
  "snapOffsetSideMedium": 8,
  "snapOffsetSideLarge": 12
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `size` | string | 档位：`"large"` / `"medium"` / `"small"`（768 / 512 / 384 物理像素） |
| `cx` / `cy` | number | 窗口中心坐标（物理像素），启动时若为空则落在主屏右下角 |
| `alwaysOnTop` | bool | 是否置顶 |
| `random` | bool | 是否随机切换动作 |
| `interval` | number | 随机切换间隔（秒），可选 180 / 600 / 900 |
| `action` | string | 启动时恢复的待机动作 id（只记录可手动播放的动作） |
| `snap` | bool | 是否吸附窗口边缘（与 `gravity` 互斥） |
| `gravity` | bool | 是否开启重力掉落（吸附开着时不可开） |
| `snapOffsetUprightSmall` / `Medium` / `Large` | number | 小/中/大档正坐吸附到窗口/任务栏时，接触点额外下移量（逻辑像素，默认 20 / 27 / 40） |
| `snapOffsetSideSmall` / `Medium` / `Large` | number | 小/中/大档侧坐吸附到窗口/任务栏时，接触点额外下移量（逻辑像素，默认 6 / 8 / 12） |

> `snap` / `gravity` 互斥：开吸附自动关重力；重力开着时无法开吸附。已在 Rust `save_cfg` 里强制。

### 动作池 `src/assets/manifest.json`

新增一个动作只需三步：

1. 把持续循环的待机 webm 放进 `src/assets/idle/`；一次性动作放 `src/assets/oneshot/`；过渡动画放 `src/assets/trans/`；
2. 在 `manifest.json` 对应的 pool（`idle` / `trans` / `panic`）里加一条；
3. 重新 `cargo build`。

条目字段：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，约定前缀 `stand_` / `sit_` / `trans_` |
| `label` | 工具箱里显示的名字 |
| `posture` | `"stand"` 站姿 / `"sit"` 坐姿（决定吸附/掉落/分组） |
| `sitKind` | 仅坐姿：`"upright"` 正坐 / `"side"` 侧坐（区分正坐与侧坐） |
| `scale` | 出厂缩放（定稿值见下节） |
| `offset` | 出厂上下偏移（CSS px；正坐 13.5 / 侧坐 13.9 / 慌张 12.5，站姿/过渡默认 0） |
| `transition` | 仅过渡动画：`{ "from", "to" }` 用 `stand` / `sit_upright` / `sit_side` 描述姿态方向 |
| `loop` | 是否循环（待机 `true`；一次性动作/过渡/慌张 `false`，播一次） |
| `playable` | 是否进入随机池（待机与一次性动作为 `true`；过渡/慌张为 `false`，只由状态机内部触发） |
| `file` | 视频相对路径 |
| `fps` / `frames` / `duration` | 元数据 |

`playable=false` 的动作不会出现在随机池里，也不能手动播放，只在状态机内部自动使用。普通工具箱只展示站立/正坐/侧坐三个姿态入口；一次性动作由随机、AI、点击互动或重力事件触发，播放一次后回到待机。

---

## 动作总览

共 **27 个** 768×768@60fps 带 Alpha 的 WebM 动作：

| 类型 | 数量 | 内容 | 播放方式 |
|---|---:|---|---|
| 持续待机 | 6 | 站姿待机 / 鲜花 / 手机 / 书籍、正坐待机、侧坐单手撑 | 循环，按 3/10/15 分钟随机轮换 |
| 一次性动作 | 12 | 站姿/正坐/侧坐 × 擦汗 / 撩头发 / 生气 / 捂嘴笑 | 播放一次后回当前姿态待机 |
| 姿态过渡 | 6 | 站 ↔ 正坐、站 ↔ 侧坐、正坐 ↔ 侧坐 | 姿态变化时自动播放 |
| 慌张 | 1 | 正坐慌张挥手 | 重力重落地时触发，1.2 倍速 |
| 喝奶茶 | 2 | 两版喝奶茶动作 | 只能由工具箱「请她喝」按钮触发 |

普通工具箱只暴露 **站立 / 正坐 / 侧坐** 三个入口；一次性动作、过渡和慌张由随机、AI、点击互动、重力事件触发，保留探索感。喝奶茶不进入随机池、不进入 AI 动作表，也不会被触摸触发。

## 动作与缩放 / 偏移

> 当前 `manifest.json` 共 27 条：6 个持续待机、12 个一次性动作（擦汗/撩头发/生气/捂嘴笑）、6 条过渡、1 个慌张、2 版喝奶茶。下表只列基础动作，完整 id 以 `src/assets/manifest.json` 为准。

### 待机动作（6 个，持续循环，参与随机切换）

| id | 名称 | 姿态 | 坐姿细分 | 缩放 | 偏移 |
|---|---|---|---|---|---|
| `stand_idle` | 站姿待机 | 站姿 | — | 0.995 | 0 |
| `stand_flower` | 站姿鲜花 | 站姿 | — | 0.995 | 0 |
| `stand_phone` | 站姿手机 | 站姿 | — | 0.97 | 0 |
| `stand_book` | 站姿书籍 | 站姿 | — | 0.97 | 0 |
| `sit_idle` | 正坐待机 | 坐姿 | upright 正坐 | 0.875 | 13.5 |
| `sit_lean` | 侧坐单手撑 | 坐姿 | side 侧坐 | 0.876 | 13.9 |

### 过渡动画（6 个，仅状态机自动播放，不出现在动作池）

| id | 名称 | 方向 | 缩放 |
|---|---|---|---|
| `trans_stand_to_upright` | 站→正坐 | stand → sit_upright | 0.995 |
| `trans_stand_to_side` | 站→侧坐 | stand → sit_side | 0.995 |
| `trans_upright_to_stand` | 正坐→站 | sit_upright → stand | 1 |
| `trans_side_to_stand` | 侧坐→站 | sit_side → stand | 1 |
| `trans_side_to_upright` | 侧坐→正坐 | sit_side → sit_upright | 0.995 |
| `trans_upright_to_side` | 正坐→侧坐 | sit_upright → sit_side | 0.995 |

### 慌张挥手（1 个，重力落地瞬间触发）

| id | 名称 | 姿态 | 缩放 | 偏移 |
|---|---|---|---|---|
| `sit_panic` | 正坐慌张挥手 | 坐姿（正坐） | 0.875 | 12.5 |
### 上下偏移 `offset`

坐姿动作（含慌张）的视频素材接地线与站姿存在微小落差，用 CSS 垂直偏移校正（`translate(-50%, calc(-50% + offset px))`）。定稿值写死在 `manifest.json` 的 `offset` 字段：正坐 13.5 / 侧坐 13.9 / 慌张 12.5；开发者面板可继续微调，覆盖值存 localStorage（键 `ravenpet.actionOffsets.v1`）。

> 说明：早期版本的「坐姿下沉 sink」机制（按坐姿类型 × 档位额外下压、配合 Rust `set_contact` 的 `sink` 参数）已彻底移除，统一改为上述 CSS `offset` 方案。

### 接入一个新动画（完整流程）

三类动作的接入方式略有不同：

**A. 待机动作（可手动播放 / 参与随机切换）**

1. 视频放进 `src/assets/idle/`；
2. 在 `manifest.json` 的 `pools.idle.items` 里加一条，`posture` 填 `"stand"` 或 `"sit"`（坐姿还要填 `sitKind`）；
3. `scale` 先随便填 1，`offset` 填 0；
4. 重新 `cargo build` 跑起来，打开工具箱「开发者选项」拖滑杆把大小调对；
5. 调好后把数值回填到 `manifest.json` 的 `scale`（缩放）和 `offset`（上下偏移，仅坐姿）。

**B. 过渡动画（只在姿态变化时自动播，不进动作池）**

1. 视频放进 `src/assets/trans/`；
2. 在 `manifest.json` 的 `pools.trans.items` 里加一条，必须填 `transition: { "from", "to" }`，方向用 `stand` / `sit_upright` / `sit_side` 三个细分姿态；
3. `loop: false`、`playable: false`；
4. 缩放同样在开发者面板调好回填。

> 状态机靠 `TRANSITION_IDS` 表（`main.js`）把 `"from>to"` 映射到动作 id，若新增了「站↔侧坐」这类**当前没有的过渡方向**，需要同时在那张表里补一行，否则切过去会没有过渡。

**C. 慌张 / 一次性动作（事件触发）**

1. 视频放进 `src/assets/oneshot/`；
2. 在 `manifest.json` 的 `pools.idle.items` 里加一条，`loop: false`、`playable: true`；慌张动作放 `pools.panic`，`loop: false`、`playable: false`；
3. 触发点目前在 `main.js` 的 `playPanic()`（监听 Rust 的 `pet:panic` 事件），要换触发逻辑就改这里。

> 所有动作的 `fps` / `frames` / `duration` 是元数据，目前只作参考、不参与逻辑；`scale` 是「相对容器满铺的比例」，1 = 铺满 1024 容器。

---

## 架构与关键实现

### 进程 / 窗口模型

- 单进程，两个 WebView 窗口：`pet`（透明桌宠）与 `toolbox`（按需创建/销毁）。
- 两个窗口通过 Tauri 事件通信：`pet:state`（状态广播）、`pet:command`（操作指令）、`pet:request_state`（工具箱启动时要一次全量状态）、`pet:posture`（坐/站姿态，Rust 判定后下发）、`pet:panic`（重力落地瞬间触发慌张挥手）、`pet:interactive`（是否可交互）。
- 权限在 `capabilities/default.json` 里白名单声明（`core:event:default` 等），两个窗口都覆盖。

### 透明窗口与尺寸

- 窗口固定 **1024×1024 物理像素**，永不 resize；三档大小靠窗口内 CSS 缩放视频实现，与系统 DPI 解耦（`set_size` 时按 `scale_factor` 换算成逻辑像素）。
- 角色在画面中只占 68% 高、接地线在 86.1%，所以对齐到窗口边缘的不是窗口矩形，而是**接触点**（contact point）。前端用 `getBoundingClientRect()` 实测视频布局后，把 `offY` / `charH` 通过 `set_contact` 命令送给 Rust。

### 无死锁四阶段轮询器（`spawn_poller`）

拖拽、下落、吸附跟随、命中判定全部由一个后台线程驱动，刻意拆成四阶段避免「持锁调窗口 API」导致的死锁：

1. **阶段 1（锁内，纯内存）**：读状态快照，产出「这轮要查什么」（`PollNeed`）；
2. **阶段 2（锁外，OS 调用）**：`GetCursorPos` / `GetWindowRect` / `EnumWindows` / 任务栏查询；
3. **阶段 3（锁内，纯内存）**：校验快照未变，产出 `Plan`（要设置的位置/穿透/姿态）与下一轮 tick；
4. **阶段 4（锁外，窗口/IPC 调用）**：`set_position` / `set_ignore_cursor_events` / `emit`。

### 自适应轮询频率

| 状态 | 间隔 |
|---|---|
| 拖拽 / 重力下落 / 宿主移动中 | 16ms（60Hz） |
| 自由停留 / 宿主静止 | 80ms（12.5Hz） |

宿主静止的判定：连续 `PERCH_STILL_TICKS`（10）轮接触点位移 ≤ 0.5px，就降到 80ms；一动立刻回 16ms。几何读取走直连 Win32（`cursor_pos` / `raw_rect`），避免 Tauri getter 每 tick 三次阻塞主线程往返。

### 窗口探测与吸附（`win.rs`）

- `list_windows` 枚举顶层可见窗口，过滤：自身进程、工具窗口（`WS_EX_TOOLWINDOW`）、DWM cloaked 幽灵窗口、桌面/任务栏/外壳类、无标题、尺寸 < 120×90、以及**最大化窗口**（`IsZoomed` / `WS_MAXIMIZE` / `GetWindowPlacement` 三重判定）。
- 最大化窗口被排除的原因：其上沿就是屏幕顶，坐上去角色会跑到屏幕外「消失」。
- 吸附半径 `SNAP_PX = 80.0`（逻辑像素，运行时乘 DPI 缩放）。
- `window_rect` 供坐着时逐帧跟随；宿主最大化/关闭/最小化返回 `None`，桌宠自动掉回任务栏。

### 重力下落的落地检测

下落时每轮在锁外查两类「可落边」：任务栏上沿，以及所有**位于接触点正下方、水平方向覆盖接触点、头顶在屏幕内**的非最大化窗口上边缘（`WinTop`，按 y 升序）。阶段 3 取这一帧真正被脚底**穿越**的最高一条边：

- 落上窗口上边缘与落上任务栏完全同构 —— 都由 `Perch { hwnd, kind, offset_x }` 描述，接触点 `offset_x` 相对窗口左边缘，所以坐下后照样跟着窗口平移；
- 落地速度乘以 `RESTITUTION`（0.22）后仍超过 `BOUNCE_MIN`（260 px/s）才反弹，否则直接坐稳 —— 避免「能量已经不够了还抖一下」的假弹跳；
- 只有当**向下落**（`vy > 0`）时才做落地判定，上升阶段不会误判。

两条容易踩坑的量化误差：

1. **接触点回读要一致**。落地位置公式是 `top = cy - offY`，回读接触点时必须反算（`cy = wpos.y + offY`）。否则追踪点与真实接触点错位：任务栏靠 `cy >= ground` 还能兜住，窗口上沿靠「跨边」判定就会被永久跳过。
2. **跨边判定要有 2px 容差**（`EDGE_TOL`）。窗口位置是按整数像素写回去的，回读接触点有 ±0.5px 量化误差 —— 弹跳后接触点可能刚好落在上沿下方零点几像素，没有容差这条边就永远「跨不过去」，表现为「在窗口上沿弹一下，然后穿过去掉到任务栏」。

### 坐在窗口上：跟随而不是黏住

坐着时每轮拿宿主窗口的实时矩形重算位置，行为分三种：

| 宿主变化 | 桌宠反应 |
|---|---|
| 横向移动 | 跟着平移（`offset_x` 相对左沿，位移完全同步） |
| 上沿往上顶 | 跟着被顶上去 |
| 上沿往下走 > 2px | **脱手**转 `Falling`，靠重力自己往下掉再落到新上沿（不是被瞬间平移下去） |
| 横向缩窄到装不下接触点 | 座位没了，转自由落体，掉到下一个更低窗口或任务栏 |

「上沿下沉就脱手」只在开启重力时生效；吸附模式下本来就该黏着宿主一起动。
脱手时若只是平台下沉，`fall_follow` 记下宿主，下落过程继续跟着它横移（同一竖列往下掉）；若是横向座位没了，则清掉 `fall_follow` 真自由落体。

另外宿主查询**连续 4 轮**（`PERCH_LOST_TICKS`）失败才判定「窗口真没了」，单轮读不到（DWM 瞬时抖动、窗口正在移动重绘）不会让她莫名掉下去。

### 鼠标穿透（Alpha 掩膜命中）

前端把当前视频的 alpha 通道采样成 192×192 的 0/1 掩膜（`set_mask`），Rust 每轮用全局光标位置换算成归一化坐标查掩膜，命中角色像素才把窗口设为可交互，否则 `set_ignore_cursor_events(true)` 穿透。掩膜只在动作切换/尺寸变化/缩放调整时按需重算。

### 动作切换、状态机与内存释放

动作切换走**姿态状态机**：用细分姿态 `granular ∈ { stand, sit_upright, sit_side }` 驱动。普通界面只手动切换三个姿态；待机动作（空手/持花/手机/书籍/正坐/侧坐）持续循环，其他动作（擦汗/撩头发/生气/捂嘴笑/慌张挥手）播放一次后回到待机。过渡动画（`playable=false`）只在姿态变化时自动播一次（站 ↔ 坐、正坐 ↔ 侧坐），同姿态内切换不播过渡；慌张挥手只在重力掉落到任务栏瞬间触发一次，结束后随机落定正坐或侧坐。

两层 `<video>` 交叉淡入（`opacity` 过渡，300ms）。切换完成后把闲置层 `removeAttribute('src') + load()`，彻底释放已解码帧的 GPU/渲染进程内存——解决「切换动作后显存不释放」的问题。

---

## 命令与事件接口

接手时最常用的参考：前端能调哪些 Rust 命令、两个窗口靠哪些事件通信。

### Tauri 命令（前端 `invoke(...)` 可调用，定义在 `lib.rs`）

| 命令 | 参数 | 作用 | 调用方 |
|---|---|---|---|
| `bootstrap` | — | 返回初始 `cfg` + 容器尺寸 / 掩膜分辨率 / 接地线比例 | `main.js` 启动时 |
| `save_cfg` | `patch` | 增量落盘运行时配置（size / action / 开关等） | `main.js` |
| `set_mask` | `w,h,data` | 提交 192×192 alpha 掩膜（0/1） | `main.js` |
| `set_contact` | `offY,charH` | 提交接地线距窗口顶部 + 角色实际高度（物理像素） | `main.js` |
| `set_menu_open` | `open` | 标记右键菜单是否打开（穿透判定用）；**当前前端未调用，属预留** | （预留） |
| `start_drag` / `end_drag` | — | 拖拽起止（进入/退出 Drag 模式） | `main.js` |
| `set_always_on_top` | `on` | 切置顶 | `main.js` |
| `open_toolbox` | — | 创建 / 复用工具箱窗口 | `main.js` |
| `quit_app` | — | 退出程序 | `toolbox.js` |
| `get_debug` | — | 返回调试信息（模式 / 接触点 / 宿主 / 窗口枚举原因） | 开发调试 |

### 事件通信（`emit` / `listen`）

| 事件 | 方向 | 载荷 | 作用 |
|---|---|---|---|
| `pet:state` | pet → toolbox | 全量状态 | 工具箱渲染依据 |
| `pet:command` | toolbox → pet | `{type, ...}` | 工具箱操作落地（见下表） |
| `pet:request_state` | toolbox → pet | — | 工具箱启动时主动要一次状态 |
| `pet:posture` | Rust → pet | `{sit: bool}` | 判断「该坐 / 该站」，触发姿态切换 |
| `pet:panic` | Rust → pet | — | 重力落地瞬间，触发慌张挥手 |
| `pet:interactive` | Rust → pet | `bool` | 是否可交互（透传判断结果） |

### `pet:command` 的子命令 `type`

| type | 载荷 | 作用 |
|---|---|---|
| `play` | `id` | 点选待机动作（走状态机，跨姿态自动播过渡） |
| `preview` | `id` | 循环预览过渡/慌张（开发者调大小用） |
| `size` | `key` | 切档位 |
| `random` | `on` | 随机切换开关 |
| `interval` | `seconds` | 随机间隔 |
| `top` | `on` | 置顶开关 |
| `snap` | `on` | 吸附开关 |
| `gravity` | `on` | 重力开关 |
| `setScale` / `resetScale` | `id,value` | 缩放调参 / 复位 |
| `setOffset` / `resetOffset` | `id,value` | 上下偏移调参 / 复位（慌张） |

### localStorage 键（前端调参落盘）

| 键 | 内容 |
|---|---|
| `ravenpet.devScales.v3` | 每个动作的缩放覆盖值（id → 比例） |
| `ravenpet.actionOffsets.v1` | 每个动作的上下偏移覆盖值（id → CSS px） |

> 键名带版本号（`.v3` / `.v1`）：定稿值回填 manifest 后会**换新键**作废旧覆盖值，避免旧的调试中间值盖掉定稿值。这是刻意的「换键作废」机制。

---

## 关键常量速查

全部定义在 `src-tauri/src/lib.rs` 顶部，改物理手感 / 命中判定时查这里：

| 常量 | 值 | 含义 |
|---|---|---|
| `CONTAINER_PX` | 1024 | 窗口边长（物理像素，永不 resize） |
| `MASK_N` | 192 | 前端 alpha 掩膜分辨率（192×192） |
| `DRAG_TICK_MS` / `IDLE_TICK_MS` | 16 / 80 | 拖拽/下落 60Hz，静止 12.5Hz |
| `PERCH_STILL_TICKS` | 10 | 连续静止轮数，判定后降到 80ms |
| `PERCH_LOST_TICKS` | 4 | 连续读不到宿主轮数，判定窗口真没了 |
| `SNAP_PX` | 80 | 吸附半径（逻辑像素） |
| `GROUND_RATIO` | 0.861 | 接地线占容器高的比例 |
| `CHAR_H_RATIO` | 0.68 | 角色实际高度占容器高的比例 |
| `PX_PER_M` / `GRAVITY` | 435 / 9.8×435 | 每米像素数 / 重力加速度（px/s²） |
| `MAX_FALL_SPEED` | 4200 | 下落速度上限（px/s） |
| `RESTITUTION` | 0.22 | 落地反弹系数 |
| `BOUNCE_MIN` | 260 | 反弹速度阈值（低于此直接坐稳，不弹跳） |
| `PANIC_MIN_DROP_PX` | 200 | 触发落地慌张的最小下落高度（逻辑像素） |
| `EDGE_TOL` | 2 | 跨边判定容差（像素） |
| `TOOLBOX_W` / `TOOLBOX_H` | 600 / 400 | 工具箱窗口尺寸 |

> 接地线 / 角色高度比例在 `main.js` 里还有一份 `groundRatio = 0.861`（启动时以 `bootstrap` 返回的值为准）。改这两处要两边一起看。

---

## 开发工具

### `winscan`（Win32 探测调试）

打印当前可坐窗口列表、Z 序、任务栏矩形，用于排查「吸不上」时先确认系统到底枚举到了哪些窗口：

```powershell
cd src-tauri
cargo run --bin winscan
```

> 它内部先设成 per-monitor v2 DPI 感知，与桌宠一致，量出来的坐标才对齐。

### `get_debug` 命令

前端可通过 `invoke('get_debug')` 拿到当前模式、吸附半径、接触点（`offY` / `charH`）、宿主信息，以及 `win::list_windows_debug` 给出的「每个窗口被接受/拒绝的原因」（`not_visible` / `maximized(...)` / `too_small(...)` / `tool_window` 等）。只在该命令被调用时执行，不影响正常轮询。

### 版本管理与插件同步

仓库已用 git 管理（`main` 分支），`src-tauri/target/` 与构建中间产物已 ignore。改坏了直接 `git diff` / `git checkout --` 回滚。

桌面版与 DSH 网页版共用同一套动作素材，但**部署出去的是两份**：仓库里的 `dsh-plugin/` 只有代码，素材唯一真源是 `src/assets/`，运行时副本在 `default-workspace\raven-winpet-plugin`（DSH profile 用 `link:` 指向它）。

改完插件或素材后，必须跑一次同步，否则网页版还是旧内容：

```powershell
.\同步到DSH.bat            # 覆盖部署副本
.\同步到DSH.bat -CheckOnly # 只看有没有漂移（有差异退出码 1）
```

同步脚本会镜像 `dsh-plugin/` 的代码文件与 `src/assets/` 的全部素材，并删掉部署目录里源中已不存在的多余素材。插件代码改动由 DSH 热重载，素材改动刷新页面即可。

---

## 性能

- 视频采用 768×768@60fps VP9（带 Alpha）成品，替换早期 2048 源，解码与内存占用大幅下降。
- 单 `<video>` 常驻、切换后释放闲置层，避免显存累积。
- 掩膜按需重算、轮询自适应频率、几何直连 Win32，空闲时 CPU 趋近于零。
- 实测切换后渲染进程内存约 100MB 级（早期接近 380MB）。

---

## 未来规划

语音对话、屏幕感知、桌面特效等方向记录在 [`可选功能.md`](./可选功能.md)，本 README 只描述已实现的部分。

---

## 许可

内部项目，暂不对外发布。

## ⚠️ 免责声明 (Disclaimer)

1. **学习与交流目的**：本项目（包括代码及相关美术素材）由 **shixiaoyu-funny** 原创开发，仅供个人学习、技术交流与开源社区研究使用，**严禁用于任何形式的商业售卖、倒卖或盈利性二次分发**。
2. **版权归属**：项目内使用的部分 AI 生成素材及相关知识产权归原作者所有。任何个人或组织在未经明确书面授权的情况下，不得将本项目（或其修改版）打包上架至淘宝、闲鱼、拼多多等商业平台进行售卖。
3. **免责条款**：使用者在使用本项目时，需自行承担因操作不当、代码修改或第三方 API 调用（如大模型生成内容）产生的所有后果。作者不对任何因使用本项目而导致的直接或间接损失、法律纠纷承担任何责任。
4. **侵权处理**：如发现任何人违反本声明进行商业倒卖，作者保留追究其法律责任及向平台举报的权利。如有版权疑问或授权需求，请通过 B站（https://space.bilibili.com/517323821）联系作者。

*本项目最终解释权归 shixiaoyu-funny 所有。*
