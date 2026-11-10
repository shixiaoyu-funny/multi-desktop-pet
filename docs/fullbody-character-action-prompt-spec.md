# 正比角色动作生成与桌宠制作规范 v0.1

> 适用对象：粉蓝渐变双马尾、贝雷帽、粉裙 + 蓝色开衫、白丝白鞋的二次元全身角色。  
> 目标：生成物理可信、动作连贯、身份一致、可抠像的全身动作，最终转成 768×768 / 60fps 透明 WebM，供桌面端与 DSH 桌宠共用。

---

## 1. 角色特点与动画风险

### 外观拆解

- **发型**：粉色到青蓝渐变的超长双马尾、齐刘海、发尾外翻；发量多、轮廓长。
- **头部**：蓝色贝雷帽、金色星形/蝴蝶结发饰、粉色眼睛。
- **服装**：粉色高腰连衣裙 + 外层蓝色开衫；泡泡袖、蕾丝裙边、胸前提丝带、蝴蝶结、金色小饰物。
- **下装/鞋**：白色连裤袜、白色厚底运动鞋。
- **整体气质**：甜美、轻盈、童话感，颜色明度很高。

### 对动作生成的影响

| 特征 | 风险 | 提示词/制作对策 |
|---|---|---|
| 超长双马尾 | 头发穿模、发尾抖动、左右不同步 | 明确“双马尾延迟 2–3 帧跟随”，左右分别描述 |
| 贝雷帽/发饰 | 头部转动时帽子漂移、饰物变形 | 写“帽子与发饰固定在头上，不脱落、不变形” |
| 泡泡袖开衫 | 手臂抬起时袖子穿插、肩部变形 | 写“开衫随肩部自然滑动，袖子不穿透手臂” |
| 蕾丝蓬裙 | 裙摆穿腿、蕾丝细节糊掉、惯性不对 | 写“裙摆滞后于髋部，落地后继续轻摆再停” |
| 白丝/白鞋 | 白底抠像丢边缘，白鞋和白背景融合 | **必须用纯绿幕**，不要白底；保留白鞋边缘 |
| 高饱和粉/青 | 绿幕溢色、边缘发绿 | 绿幕打光均匀，后期 despill；角色本身不含绿色，适合 key |
| 小饰物/细缎带 | 生成时消失或抖动 | 锁定饰物数量、位置；避免大幅快速动作 |
| 全身构图 | 模型容易裁脚、拉长腿、比例漂移 | 明确 full body head-to-toe，脚在画面内，比例不变 |

> 结论：这个角色不适合“随便扭一下”的提示词。她的动作质量主要取决于**头发、裙子、开衫、缎带的次级运动**，以及**脚底是否稳定**。

---

## 2. 公开资料研究结论

目前公开资料主要是通用图生视频、短视频运镜和写实人物动作，没有成熟的“二次元全身桌宠动作”提示词规范。可迁移的结论如下。

### 2.1 Kling：运动优先，明确“什么不动”

Kling 官方/第三方指南的核心是：

- **运动优先**：先写“谁在动、怎么动、往哪动、多快”，不要用“dynamic / energetic”这类抽象词。
- **图生视频最适合保角色**：静帧负责身份、服装、构图；提示词只负责运动和镜头。
- **明确约束静止项**：模型有“动一切”的倾向，必须写“camera locked off”“背景静止”“脸部不变”。
- **一个片段只做一件事**：一个主要动作节拍，不要同时走路、转身、挥手、说话。
- 常见失败：整体漂移、主体变形、脸/服饰退化；对策是锁镜头、减少同时运动、用干净的参考图。

来源：[Kling AI Prompt Guide](https://morphed.app/blog/kling-ai-prompt-guide)

### 2.2 Runway Act-Two：不适合全身桌宠

Act-Two 是“表演视频驱动角色”的方案，但官方最佳实践明确要求：

- 表演视频和角色图**最多到腰部**（waist up）；
- 输出 24fps；
- 角色图输入会自动添加环境/镜头运动；
- 手势控制要求手在画面内。

这意味着 Act-Two 不能直接做“全身站姿/坐姿/走位”的桌宠动作。可以做半身表情/手势，不适合本项目的全身管线。

来源：[Performance Capture with Act-Two](https://help.runwayml.com/hc/en-us/articles/42311337895827-Performance-Capture-with-Act-Two)

### 2.3 Seedance/中文提示词：物理描述词汇可复用

中文图生视频提示词里常见的有效描述包括：

- 重心转移自然
- 双脚稳踏地面
- 平衡感真实
- 动作转换流畅
- 毛发与布料物理效果逼真
- 阴影一致
- 身体结构稳定、动作连贯

这些词可以直接作为“物理约束段”，但必须配合具体动作，不能只堆形容词。

来源：[awesome-seedance-2-prompts](https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/blob/main/README_zh-TW.md)

### 2.4 自研结论

1. **纯图生视频做全身坐姿/侧坐不可靠**：从站姿直接生成“坐下”很容易腿变形、裙摆穿模。正确做法是**先有对应姿态的基准图**（站、正坐、侧坐各一张），再分别生成该姿态的 idle/表情动作。
2. **全身动作需要“接触约束”**：脚底、膝盖、髋部、手撑地/坐面必须有明确接触点；否则会滑步、漂浮。
3. **次级运动要单独写**：双马尾、裙摆、开衫、缎带分别描述延迟和衰减，不能只写“头发飘动”。
4. **一动作一视频**：不要在一个片段里做“站→坐→撩头发”；拆成独立动作，再用桌宠状态机衔接。

---

## 3. 提示词骨架

### 3.1 六段式

```text
[1 身份锁定] + [2 构图/镜头] + [3 主动作] + [4 接触/物理] + [5 静止项] + [6 负面约束]
```

#### 1. 身份锁定

- 同一角色、同一套服装、同一发型/发色/瞳色/身高比例
- 2D anime / cel shading，线条和配色与参考图一致
- 饰物数量、位置不变

#### 2. 构图/镜头

- full body, head to toe, entire shoes visible
- centered, consistent scale, camera locked off
- no zoom / pan / crop / camera shake
- flat pure green background, no shadow, no floor

#### 3. 主动作

- 只写一个动作节拍
- 写清起始姿态、动作方向、速度、结束姿态
- 用物理动词，不用情绪形容词

#### 4. 接触/物理

- 脚：planted / no foot sliding / weight on left leg
- 腿：knees bend / hips lead / shoulders counter-rotate
- 头发：twin tails lag 2–3 frames, settle after head stops
- 裙子：hem follows hips, overshoots slightly, settles
- 开衫/缎带：sleeves and ribbons trail, then settle
- 不穿模：skirt does not pass through legs; sleeves do not intersect arms

#### 5. 静止项

- face/eyes/mouth unchanged (unless expression action)
- hat and hair ornaments stay fixed
- background and camera do not move
- body proportions unchanged

#### 6. 负面约束

```text
no extra limbs, no missing fingers, no deformed hands, no face morphing,
no changing outfit, no hat/ornament disappearing, no skirt clipping,
no hair passing through body, no foot sliding, no floating,
no camera movement, no zoom, no crop, no text, no watermark,
no photorealistic style, no 3D render, no shadows, no floor
```

---

## 4. 主提示词模板

### 4.1 英文主模板（图生视频）

```text
2D anime full-body character animation, exactly the same character as the reference image:
pastel pink-to-cyan twin tails, blue beret, pink eyes, pink high-waist dress,
light blue cardigan with puff sleeves, white tights, white sneakers, gold star ornaments.

Full body head-to-toe, centered, entire shoes visible, consistent proportions,
camera locked off at chest height, no zoom, no pan, no crop, no camera shake.
Flat pure green background (#00FF00), no shadow, no floor, no environment.

Motion: [ONE ACTION BEAT].
The character starts in [START POSE] and ends in [END POSE].
[SPEED / WEIGHT / DIRECTION].

Physics: feet stay planted with no foot sliding; weight shifts onto [LEFT/RIGHT] leg;
knees bend slightly; hips lead and shoulders counter-rotate;
the long twin tails lag 2–3 frames behind the head and settle after it stops;
the skirt hem follows the hips with a slight overshoot, then settles;
the cardigan sleeves and ribbons trail and settle; no clothing clipping.

What stays still: face and eyes unchanged; beret and hair ornaments fixed;
background and camera completely static; body proportions unchanged.

Style: clean 2D anime cel shading, crisp line art, pastel palette, same character design.
Negative: no extra limbs, no deformed hands, no face morphing, no outfit change,
no missing hat or ornaments, no skirt clipping, no hair intersecting the body,
no foot sliding, no floating, no camera movement, no zoom, no crop,
no text, no watermark, no 3D, no photorealistic, no shadow, no floor.
```

### 4.2 短版（Kling 这类偏短提示的模型）

```text
The same 2D anime girl with pastel pink-cyan twin tails, blue beret, pink dress,
blue cardigan, white tights and white sneakers. Full body head-to-toe, camera locked off,
flat green background. She [ACTION], feet planted, no foot sliding; twin tails and skirt
lag behind the movement and settle; face, hat and ornaments stay unchanged.
No camera movement, no zoom, no crop, no clothing clipping, no extra limbs.
```

### 4.3 坐姿专用

> 必须先有该姿态的坐姿基准图；不要从站姿硬生成坐下。

```text
2D anime full-body character, seated upright on an invisible flat seat, same character...
Full body including shoes, camera locked off, green background.
She sits with weight on her hips, both feet planted on the ground, hands resting on her lap.
The skirt is compressed under her hips without clipping through the legs;
the twin tails hang behind her shoulders and settle; the cardigan falls naturally.
Motion: subtle breathing, blink, small weight shift; tails sway gently.
No standing up, no leg crossing, no floating, no foot sliding, no camera movement.
```

侧坐版本把 `seated upright` 换成 `seated sideways, one hand supporting her weight behind her, legs folded to one side`，并强调支撑手接触地面/坐面、裙摆覆盖腿部、脚不穿模。

---

## 5. 动作配方（第一批）

### 5.1 站姿待机（循环）

- 时长：3–4s，首尾姿态一致
- 动作：呼吸起伏 → 轻微重心左右转移 → 眨眼 → 双马尾延迟摆动 → 回到起始
- 重点：脚底完全不动；裙摆/开衫只做小幅次级运动

### 5.2 站姿撩头发

- 起始：自然站立
- 动作：右手抬起 → 指尖靠近侧发 → 头微低/侧倾 → 手放下 → 回正
- 重点：手不要穿过脸/头发；双马尾在头停止后继续摆 2–3 帧；开衫袖子跟随
- 时长：3–4s，末尾回待机

### 5.3 正坐待机

- 基准：正坐图
- 动作：呼吸、眨眼、手指轻动、双马尾垂落微摆
- 重点：脚/腿/裙摆接触稳定，不漂浮

### 5.4 侧坐单手撑

- 基准：侧坐图
- 动作：支撑手压地、肩部轻微起伏、双腿交叠微调、头发垂落
- 重点：支撑手不能滑动；裙摆遮腿不穿模；身体重心在支撑手和髋部之间

### 5.5 正坐慌张

- 基准：正坐图
- 动作：双手抬起、身体后仰、头快速左右看、双马尾甩动、裙摆抖动
- 重点：坐姿不变成站姿；手不穿脸；慌张 1–2 次循环后回正坐待机
- 后期按桌面端 1.2 倍速播放

### 5.6 其他动作（后续）

- 擦汗：抬手到额头 → 抹一下 → 松气；注意袖子/刘海
- 生气：抱臂/鼓起脸/扭头；双马尾甩动
- 捂嘴笑：手掩嘴、肩膀轻抖；手指不要糊
- 手机/书籍：需要道具图或单独参考；先做“手持道具的坐姿/站姿基准图”

---

## 6. 循环与一次性动作规则

### 循环（idle）

- 首帧和末帧尽量同姿态
- 动作幅度小，脚/坐姿接触点不变
- 3–4s 一段，后期可循环
- 不要在一次循环里换重心到另一只脚再换回来，容易滑步

### 一次性（emote/panic）

- 2–4s
- 结构：起势（anticipation）→ 主动作 → 回落（settle）→ 停 0.3–0.5s
- 最后一帧回到该姿态的待机附近，方便桌宠状态机切回 idle
- 不要在同一段里做两个情绪（例如又生气又笑）

---

## 7. 制作管线

1. **基准图**：至少准备站姿、正坐、侧坐三张同一角色的全身图；建议再加正面/侧面/背面转面图。
2. **生成**：优先用支持图生视频、能锁镜头、能接受较长提示的模型；一次只生成一个动作，固定 seed/参考图。
3. **选片**：先看脚、手、脸、裙摆、头发五处；有明显穿模/滑步/变形的直接弃。
4. **补帧**：模型原生 24fps → RIFE/FILM 补到 60fps；补帧后检查手/发尾/蕾丝是否出现拖影或果冻。
5. **抠像**：绿幕 key → despill → alpha matte → 去阴影/地面；白丝白鞋边缘要单独检查。
6. **规格化**：统一裁切、角色高度、脚底接地线；输出 768×768、VP9 alpha、60fps WebM；码率优先保头发/蕾丝边缘。
7. **接入**：登记 manifest 的 scale/offset/foot anchor；桌面端和 DSH 插件共用同一套素材。
8. **QA**：见下一节。

---

## 8. QA 检查表

- [ ] 身份：脸、发型、发色、瞳色、服装、饰物数量与参考图一致
- [ ] 比例：头身比、腿长、鞋大小不变
- [ ] 脚：脚底不滑动、不漂浮、不穿地
- [ ] 手：手指数量、手型、手与脸/头发/裙子的接触正确
- [ ] 头发：双马尾不穿身体、左右延迟自然、发尾不抖成噪点
- [ ] 裙子：不穿腿、蕾丝边不糊、裙摆惯性合理
- [ ] 开衫/缎带：不穿手臂、不消失、跟随有延迟
- [ ] 镜头：无推拉摇移、无裁脚、无缩放
- [ ] 背景：纯绿、无阴影、无地面、无文字
- [ ] 循环：首尾能接上；一次性动作能回待机
- [ ] 补帧：无手部/发尾/蕾丝果冻
- [ ] 透明：边缘无绿边、白鞋/白丝没有缺边

---

## 9. 下一步

1. 先确认这个粉蓝角色的名字/代号（她和现有黑红 Suki 不是同一套外观）。
2. 补 **正坐、侧坐** 两张全身基准图；没有这两张，坐姿动作不建议直接生成。
3. 选一个图生视频模型，先用本文模板做 **站姿待机** 和 **站姿撩头发** 两条测试片。
4. 测试片通过后，再批量做正坐/侧坐/慌张，最后进入抠像和桌宠接入。
