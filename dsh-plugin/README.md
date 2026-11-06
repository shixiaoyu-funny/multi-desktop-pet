# role2 桌宠 · DSH Web 插件

把 role2 桌宠作为**页面内悬浮层**显示在 DeepSeek Harness 的 Web 界面里。不包含 Tauri/exe，也不改动 DSH 本体；动作素材随插件分发。

## 安装

```text
plugin_manager install_bundle → 目标：C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\role2-pet-plugin
```

安装后刷新页面，桌宠出现在右下角。

## 使用

- **拖拽**：按住角色拖动（页面内边界限制）。
- **右键菜单**：大小（大/中/小）、坐下/站起、换一个动作、随机切换、响应 AI、重置位置。
- **气泡**：随 Agent 活动显示「工作中 / 查资料 / 搞定 / 出错了」。
- 设置（大小/位置/随机/响应 AI）保存在浏览器 `localStorage`，刷新后保留。

## 动作比例（定稿值）

动作的 `scale` 与坐姿 `offset` 来自 `assets/manifest.json`，以 **1024 基准画布** 为准：

- `scale` 是「相对 1024 容器满铺的比例」，1 = 铺满；
- `offset` 是 1024 画布内的 CSS 垂直偏移，只有坐姿/慌张有（12.8），站姿/过渡为 0。

客户端为每一层 `<video>` 单独应用 `width = 1024 × scale`、`translate(-50%, calc(-50% + offset))`，再把整个 1024 画布缩放到页面档位（512 / 384 / 288 CSS px）。这样切换动作时角色大小、坐姿接地位置与桌面版一致，不会忽大忽小。

> `groundRatio` / `charHeightRatio` / 桌面三档 768/512/384 是桌面窗口物理坐标体系，网页端不需要窗口吸附，因此只沿用动作的比例关系。

## AI 联动

宿主半区监听 `session/event` 与 `agent/assistant-stream`，但**只处理当前主视图会话**：页面从会话目录的 `retainedBy.mainView` 标记取出当前会话 id，切换时上报给宿主；其他工作区/会话的 AI 活动不会驱动桌宠。

| 状态 | 触发 | 动作 |
|---|---|---|
| 工作中 | 当前会话回合开始、思考、普通工具调用 | `stand_phone`（玩手机） |
| 查资料 | 当前会话的 `web_search` / `web_fetch` 等搜索类工具 | `stand_book`（看书） |
| 待机 | 当前会话回合结束 / 失败后 | 站姿、正坐、侧坐每 30 秒随机切换 |

- 回合正常结束：立即回待机并显示「搞定！」；
- 失败：显示「出错了…」并回待机；
- 工作中暂停随机切换，避免动作被打断；
- 右键「响应 AI」可整体关闭，桌宠只做自己的待机循环。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半区：`/role2-pet/assets/*` 视频路由（Range/206）、会话活动投影、SSE 推送 |
| `client.js` | 客户端半区：`shell.overlay` 悬浮桌宠、动作状态机、比例/偏移、拖拽/菜单/气泡 |
| `cordis.patch.yml` | 插入插件行 |
| `assets/` | 动作视频与 `manifest.json`（**部署时才存在**，见下） |
| `locale/` | 插件列表里的标题/描述 |
| `icon.svg` | 插件图标 |

## 素材从哪来

`dsh-plugin/` 本身**不含**视频——素材的唯一真源是仓库根目录的 `src/assets/`（桌面版与插件共用同一套动作与 `manifest.json`）。宿主半区的 `index.js` 在启动时按顺序找两个位置：

1. `<插件目录>/assets/`（部署后的常规位置）；
2. `<插件目录>/../src/assets/`（直接从本仓库跑时的兜底）。

所以从本仓库安装前，先运行根目录的 `同步到DSH.bat`（即 `tools/sync-plugin.ps1`），它会把插件代码与 `src/assets/` 镜像到部署目录。否则 `/role2-pet/assets/*` 会返回 503。

## 说明

- 视频路由仅允许本机回环访问。
- 客户端声明为 `immediately: false`：即使客户端模块出错，也只影响桌宠本身，不会阻塞 DSH 的 Web boot。
- 更换动作素材后，更新 `src/assets/manifest.json` 的 `scale`/`offset` 并重新同步即可，无需改客户端代码。
