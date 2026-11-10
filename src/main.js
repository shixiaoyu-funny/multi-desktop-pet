/**
 * Suki 透明 WebM 桌宠 —— 桌宠窗口前端（Tauri 2）
 *
 * 分工：
 *  · 本文件负责：选动作 / 双层视频交叉淡入 / 一次性过渡动画 / 算 alpha 掩膜 / 接收工具箱指令
 *  · Rust 负责：窗口位置、拖拽跟随、点击穿透开关、边界夹紧、配置落盘、托盘、工具箱窗口
 *  · 工具箱窗口（toolbox.html）：所有设置控件，通过 pet:command / pet:state 与这里通信
 *
 * 掩膜为什么要交给 Rust：
 * Windows 上 Tauri 的 set_ignore_cursor_events(true) 没有 forward 参数，
 * 一旦穿透，WebView 就再也收不到 mousemove。所以只能由 Rust 用全局光标
 * 坐标反查"此刻在不在角色身上"，命中判定用的就是这里算好的掩膜。
 *
 * 动画状态机：
 *  待机动作（站姿×4 / 正坐 / 侧坐）可手动播放、可随机切换。
 *  过渡动画（站↔坐、正坐↔侧坐）不可手动播放，只在姿态变化时自动播一次；
 *  慌张挥手（正坐慌张挥手）只在重力掉落到任务栏的瞬间触发。
 *  姿态用细分粒度 granular ∈ {stand, sit_upright, sit_side} 驱动过渡查表。
 */

const { invoke } = window.__TAURI__.core
const { listen, emit } = window.__TAURI__.event

// 事件 API 走 ACL 权限，失败时不要留 unhandled rejection
const safeListen = (name, cb) =>
  listen(name, cb).catch((e) => console.warn('[pet] 监听失败', name, e))
const safeEmit = (name, payload) =>
  emit(name, payload).catch((e) => console.warn('[pet] 发送失败', name, e))

const MASK_N = 192      // 掩膜分辨率（覆盖整个 1024 窗口）
const FADE_MS = 300
const HINT_MS = 6000

// 档位尺寸是「物理像素」，实际写 CSS 时要除以 devicePixelRatio。
// 大 768（视频 1:1）、中 512、小 384。
const SIZES = { large: 768, medium: 512, small: 384 }

// 过渡动画 id 映射：`from>to`。from/to ∈ {stand, sit_upright, sit_side}。
// 同姿态之间没有过渡（直接切）。慌张挥手是正坐姿态，任务栏落地后若要落到
// 侧坐，用 sit_upright>sit_side 这条。
const TRANSITION_IDS = {
  'stand>sit_upright': 'trans_stand_to_upright',
  'stand>sit_duck': 'trans_stand_to_duck',
  'sit_upright>stand': 'trans_upright_to_stand',
  'sit_duck>stand': 'trans_duck_to_stand',
  'sit_duck>sit_upright': 'trans_duck_to_upright',
  'sit_upright>sit_duck': 'trans_upright_to_duck',
}

let cfg = null
let pool = []          // 全部动作（待机 + 过渡 + 慌张），供开发者缩放与查表
let playablePool = []  // 可手动播放的动作（仅待机），供工具箱按钮与随机切换
let current = null     // 当前正在播的动作（可能是待机 / 过渡 / 慌张）
let layers = []
let frontIdx = 0
let switching = false      // 交叉淡入进行中（约 300ms）
let playToken = 0          // 抢占式播放：旧 play() 的异步结果作废
let duckLock = false       // 重力下落期间锁定鸭子坐
let transitioning = false  // 一次性动作（过渡）正在播放（约 2s），期间挡住姿态切换
let dragging = false
let randomTimer = null
let interactive = false
let aiBusy = false
let press = null
let bubbleTimer = null
let bubbleOffset = 150
let chatOpen = false
let ttsAudio = null
let ttsUrl = null
let ttsToken = 0
let touchOverrides = {}
let lastTouchLine = {}
let milkTeaPending = null

// 待机动画：随机到这些动作时保持完整间隔；其余动作播一次后回到待机
const IDLE_ACTIONS = new Set([
  'stand_idle',
  'sit_upright_idle',
  'sit_duck_idle',
])

const TOUCH_OVERRIDE_KEY = 'role7pet.touchReplies.v2'
const TOUCH_POOLS = window.SUKI_TOUCH_POOLS || {}

// 每个动作的相对缩放（1 = 铺满容器）。manifest 里的 scale 是出厂值，
// 工具箱里调过的数值存在 localStorage，优先级更高，方便随调随看。
let scales = {}
// 动作的上下偏移（CSS px，-20~20）。坐姿动画的偏移出厂值来自 manifest（定稿），
// 慌张挥手的偏移可在开发者模式调（存 localStorage）。用于校正视频素材的接地位差。
let offsets = {}
// 两层各自正在显示哪个动作、放大到多少 —— 交叉淡入时两层比例可能不同
let layerActionId = [null, null]
let layerScale = [1, 1]
let containerCss = 384

// 当前姿态：posture 是粗粒度（stand/sit，给工具箱显示），granular 是细分粒度
// （stand / sit_upright / sit_side），驱动过渡状态机。
let posture = 'stand'
let granular = 'stand'
let groundRatio = 0.861

boot()

async function boot() {
  const st = await invoke('bootstrap')
  cfg = st.cfg
  if (typeof st.groundRatio === 'number') groundRatio = st.groundRatio
  loadTouchOverrides()

  const man = await (await fetch('assets/manifest.json')).json()
  // 把所有池拍平成一份全量列表（待机 + 过渡 + 慌张），再挑出可手动播放的
  pool = []
  for (const key of Object.keys(man.pools || {})) {
    const p = man.pools[key]
    for (const it of (p.items || [])) {
      pool.push({
        ...it,
        loop: it.loop != null ? it.loop : p.loop !== false,
        playable: it.playable != null ? it.playable : p.playable !== false,
      })
    }
  }
  playablePool = pool.filter((i) => i.playable)
  if (!playablePool.length) {
    console.error('[pet] 动作池为空，检查 src/assets/manifest.json')
    return
  }
  // 慌张动画需要从 0.5s 起播；Tauri 资源协议没有 Range，先转成 Blob，
  // 让 <video> 具备完整 seekable 区间。启动时预取，落地时不用等。
  if (typeof man.groundRatio === 'number') groundRatio = man.groundRatio

  // 出厂缩放值来自 manifest；localStorage 里的调参结果覆盖它
  const saved = readDevScales()
  for (const item of pool) {
    const base = typeof item.scale === 'number' ? item.scale : 1
    scales[item.id] = saved[item.id] != null ? saved[item.id] : base
  }
  offsets = readActionOffsets()
  bubbleOffset = readBubbleOffset()
  applyBubbleOffset(bubbleOffset, false)

  layers = [document.getElementById('vidA'), document.getElementById('vidB')]
  for (const v of layers) {
    v.muted = true
    v.playsInline = true
    v.disablePictureInPicture = true
    v.addEventListener('error', () => console.warn('[pet] 视频加载失败', v.src))
    v.addEventListener('loadeddata', () => refreshMask())
  }

  applySize(cfg.size || 'medium')
  const first =
    playablePool.find((i) => i.id === cfg.action) ||
    playablePool.find((i) => i.id === man.defaultAction) ||
    playablePool[0]
  granular = granularOf(first)
  posture = postureOf(first)
  await play(first.id, { instant: true })

  bindInput()
  scheduleRandom()
  showHint()

  safeListen('pet:interactive', (e) => { interactive = !!e.payload })
  safeListen('pet:posture', (e) => { applyPosture(!!(e.payload && e.payload.sit)) })
  safeListen('pet:falling', () => { forceDuck() })
  safeListen('pet:tts', (e) => {
    if (!cfg) return
    cfg.tts = !!e.payload
    if (!cfg.tts) stopTts()
    broadcastState()
  })
  // AI 聊天返回的动作 / 台词
  safeListen('pet:ai-action', (e) => {
    const action = e.payload && e.payload.action
    if (action) playAiAction(action)
  })
  safeListen('pet:ai-reply', (e) => {
    const text = e.payload && e.payload.text
    if (text) showBubbleAfterSpeech(text, 9000)
  })
  // 主动陪伴：不吃聊天历史，只显示一条临时气泡
  safeListen('pet:ambient', (e) => {
    const text = e.payload && e.payload.text
    if (text && !chatOpen) showAmbientBubble(text)
  })
  safeListen('pet:milk-tea', (e) => {
    const variant = e.payload && e.payload.variant
    if (variant) playMilkTea(variant)
  })
  safeListen('pet:milk-tea-reply', (e) => {
    const text = e.payload && e.payload.text
    if (text) showBubbleAfterSpeech(text, 9000)
  })
  safeListen('pet:single-instance-warning', () => {
    invoke('open_single_instance_warning').catch(() => {})
  })
  safeListen('pet:chat-state', (e) => {
    chatOpen = !!(e.payload && e.payload.open)
    if (chatOpen) {
      if (randomTimer) {
        clearTimeout(randomTimer)
        randomTimer = null
      }
      aiBusy = false
      settleForChat()
    } else {
      scheduleRandom()
    }
    broadcastState()
  })
  // 工具箱刚打开时会主动要一次完整状态
  safeListen('pet:request_state', () => broadcastState())
  // 工具箱发来的操作指令
  safeListen('pet:command', (e) => handleCommand(e.payload))
  window.__pet = {
    state: () => ({
      action: current && current.id,
      granular,
      posture,
      size: cfg.size,
      random: cfg.random,
      interval: cfg.interval,
      alwaysOnTop: cfg.alwaysOnTop,
      snap: cfg.snap,
      gravity: cfg.gravity,
      tts: !!cfg.tts,
      snapOffsetUprightSmall: cfg.snapOffsetUprightSmall,
      snapOffsetUprightMedium: cfg.snapOffsetUprightMedium,
      snapOffsetUprightLarge: cfg.snapOffsetUprightLarge,
      snapOffsetDuckSmall: cfg.snapOffsetDuckSmall,
      snapOffsetDuckMedium: cfg.snapOffsetDuckMedium,
      snapOffsetDuckLarge: cfg.snapOffsetDuckLarge,
      pool: pool.map((i) => i.id),
      scales: { ...scales },
      offsets: { ...offsets },
      bubbleOffset,
      tts: !!cfg.tts,
      chatOpen,
      videos: layers.map((v, i) => ({
        src: v.getAttribute('src') ? decodeURIComponent(v.getAttribute('src').split('/').pop()) : null,
        readyState: v.readyState,
        paused: v.paused,
        w: v.videoWidth,
        h: v.videoHeight,
        scale: layerScale[i],
        cssW: Math.round(v.getBoundingClientRect().width * 10) / 10,
      })),
    }),
    play: (id) => play(id),
    setSize: (k) => setSize(k),
    setRandom: (on) => setRandom(on),
    setScale: (id, v) => setActionScale(id, v),
    resetScale: (id) => resetActionScale(id),
    toolbox: () => invoke('open_toolbox'),
  }

  broadcastState()
  console.log('[pet] ready:', current && current.label, 'size=' + cfg.size)
}

// ————————————————————————— 工具箱通信 —————————————————————————

/** 把当前全部状态推给工具箱窗口 */
function broadcastState() {
  if (!cfg) return
  safeEmit('pet:state', {
    cfg: {
      size: cfg.size,
      random: cfg.random,
      interval: cfg.interval,
      alwaysOnTop: cfg.alwaysOnTop,
      action: cfg.action,
      snap: cfg.snap,
      gravity: cfg.gravity,
      tts: !!cfg.tts,
      snapOffsetUprightSmall: cfg.snapOffsetUprightSmall,
      snapOffsetUprightMedium: cfg.snapOffsetUprightMedium,
      snapOffsetUprightLarge: cfg.snapOffsetUprightLarge,
      snapOffsetDuckSmall: cfg.snapOffsetDuckSmall,
      snapOffsetDuckMedium: cfg.snapOffsetDuckMedium,
      snapOffsetDuckLarge: cfg.snapOffsetDuckLarge,
    },
    action: current && current.id,
    posture,
    sitting: posture === 'sit',
    sitKind: granular === 'sit_duck' ? 'duck' : granular === 'sit_upright' ? 'upright' : null,
    // 全部动作（工具箱动作池 + 开发者缩放面板共用）。
    // playable=true 是待机动作（点选走状态机）；false 是过渡/慌张（点选循环预览，调大小用）。
    pool: pool.map((i) => ({
      id: i.id,
      label: i.label,
      posture: postureOf(i),
      sitKind: sitKindOf(i),
      playable: i.playable,
      group: groupOf(i),
      scale: typeof i.scale === 'number' ? i.scale : 1,
      offset: offsetOf(i.id),
    })),
    scales: { ...scales },
    offsets: { ...offsets },
    containerPx: Math.round(containerCss * (window.devicePixelRatio || 1)),
    dpr: window.devicePixelRatio || 1,
    agentBusy: aiBusy,
    bubbleOffset,
    tts: !!cfg.tts,
    chatOpen,
  })
  // 让 Rust 侧的聊天知道当前姿态，用来限制 AI 可选动作
  invoke('report_posture', {
    posture,
    granular,
    action: current && current.id,
  }).catch(() => {})
  invoke('set_sit_kind', { kind: granular }).catch(() => {})
}

/** 工具箱发来的指令一律在这里落地 */
function handleCommand(cmd) {
  if (!cmd || !cfg) return
  switch (cmd.type) {
    case 'play':
      playManual(cmd.id)
      break
    case 'posture':
      setPostureTarget(cmd.value)
      break
    case 'preview':
      previewAction(cmd.id)
      break
    case 'size':
      setSize(cmd.key)
      break
    case 'random':
      setRandom(cmd.on)
      break
    case 'interval':
      setIntervalSec(cmd.seconds)
      break
    case 'top':
      setAlwaysOnTop(cmd.on)
      break
    case 'snap':
      setSnap(cmd.on)
      break
    case 'gravity':
      setGravity(cmd.on)
      break
    case 'snapOffset': {
      const kind = cmd.kind === 'duck' ? 'duck' : 'upright'
      const size = cmd.size === 'large' ? 'large' : cmd.size === 'medium' ? 'medium' : 'small'
      const suffix = size.charAt(0).toUpperCase() + size.slice(1)
      const field = `snapOffset${kind === 'duck' ? 'Duck' : 'Upright'}${suffix}`
      const value = Math.round(Math.min(150, Math.max(-150, Number(cmd.value) || 0)))
      cfg[field] = value
      invoke('set_snap_offset', { kind, size, value }).catch(() => {})
      broadcastState()
      break
    }
    case 'setScale':
      setActionScale(cmd.id, cmd.value)
      broadcastState()
      break
    case 'resetScale':
      resetActionScale(cmd.id)
      broadcastState()
      break
    case 'setOffset':
      setActionOffset(cmd.id, cmd.value)
      broadcastState()
      break
    case 'resetOffset':
      resetActionOffset(cmd.id)
      broadcastState()
      break
    case 'bubbleOffset':
      applyBubbleOffset(cmd.value)
      broadcastState()
      break
    case 'tts':
      setTts(cmd.on)
      break
    default:
      console.warn('[pet] 未知指令', cmd.type)
  }
}

// ————————————————————————— 动作播放 —————————————————————————

function urlOf(item) {
  return item.file.split('/').map(encodeURIComponent).join('/')
}

// ————————————————————————— 姿态（站 / 坐） —————————————————————————

/** manifest 里的 posture 字段；老配置没有就按 id 前缀猜 */
function postureOf(item) {
  if (!item) return 'stand'
  if (item.posture) return item.posture
  return /^sit/.test(item.id) ? 'sit' : 'stand'
}

/** 坐姿细分：正坐 / 鸭子坐。站姿返回 null。 */
function sitKindOf(item) {
  if (!item || postureOf(item) !== 'sit') return null
  return item.sitKind === 'duck' ? 'duck' : 'upright'
}

/** 细分姿态：stand / sit_upright / sit_duck。过渡动画按 transition.to 归属。 */
function granularOf(item) {
  if (!item) return 'stand'
  if (item.transition) return item.transition.to
  if (postureOf(item) !== 'sit') return 'stand'
  return sitKindOf(item) === 'duck' ? 'sit_duck' : 'sit_upright'
}

/** 工具箱分组：stand / sit / trans。 */
function groupOf(item) {
  if (!item) return 'stand'
  if (item.transition) return 'trans'
  return postureOf(item) === 'sit' ? 'sit' : 'stand'
}

/** 按细分姿态查过渡动画 */
function findTransition(from, to) {
  const id = TRANSITION_IDS[`${from}>${to}`]
  return id ? pool.find((i) => i.id === id) : null
}

/** 同姿态的候选动作；尽量不挑当前正在播的那个 */
function pickForPosture(want) {
  const same = playablePool.filter((i) => postureOf(i) === want && IDLE_ACTIONS.has(i.id))
  if (!same.length) return null
  const others = same.filter((i) => !current || i.id !== current.id)
  const list = others.length ? others : same
  return list[(Math.random() * list.length) | 0]
}

/** 在指定坐姿类型（upright / side）里挑一个**待机**动作，供慌张结束后回收。
 * 不能抽擦汗/撩头发/生气/捂嘴笑这些表情动作，否则落地后会莫名其妙自己演一段。 */
function pickSit(kind) {
  const same = playablePool.filter(
    (i) => postureOf(i) === 'sit' && sitKindOf(i) === kind && IDLE_ACTIONS.has(i.id)
  )
  if (!same.length) return null
  const others = same.filter((i) => !current || i.id !== current.id)
  const list = others.length ? others : same
  return list[(Math.random() * list.length) | 0]
}

/** 随机选最终坐姿：正坐 / 鸭子坐 */
function pickSitGranular() {
  return Math.random() < 0.5 ? 'sit_upright' : 'sit_duck'
}

/**
 * 切到目标待机动作。若当前 settled 姿态和目标姿态不同，先播过渡动画再切；
 * 相同则直接切（同姿态内切换无需过渡）。
 */
function switchTo(targetItem, opts = {}) {
  const to = granularOf(targetItem)
  const from = granular
  const setGranular = (value) => {
    granular = value
    posture = value === 'stand' ? 'stand' : 'sit'
    if (value === 'stand') duckLock = false
  }
  if (from === to) {
    setGranular(to)
    play(targetItem.id, opts)
    return
  }
  const transItem = findTransition(from, to)
  if (!transItem) {
    setGranular(to)
    play(targetItem.id, opts)
    return
  }
  if (switching) {
    // 上一次交叉淡入还没结束：稍后重试（granular 还没改，重试会重新走过渡，不会跳过）
    if (!opts._retry) {
      setTimeout(() => switchTo(targetItem, { ...opts, _retry: true }), 80)
    }
    return
  }
  setGranular(to)
  transitioning = true
  // 过渡是中间态：不落盘、不重置随机计时器
  play(transItem.id, {
    force: true,
    silent: true,
    keepTimer: true,
    onEnded: () => {
      play(targetItem.id, opts)
    },
  })
}

/**
 * 工具箱点选动作：
 *  · 待机动作 → 走状态机（站↔坐、正坐↔侧坐都播过渡动画）
 *  · 过渡/慌张 → 循环预览（临时调大小用，不触发状态机、不落盘）
 */
function playManual(id, attempt = 0) {
  const item = pool.find((i) => i.id === id)
  if (!item) return
  if (item.trigger === 'milk_tea') return
  if (!item.playable) {
    previewAction(id)
    return
  }
  if (switching) {
    if (attempt < 30) setTimeout(() => playManual(id, attempt + 1), 80)
    return
  }
  switchTo(item)
}

/** 只暴露三个姿态入口：站立 / 正坐 / 鸭子坐。 */
function setPostureTarget(value) {
  duckLock = false
  const target =
    value === 'stand'
      ? pickForPosture('stand')
      : pickSit(value === 'duck' ? 'duck' : 'upright')
  if (target) switchTo(target, { force: true })
}

/**
 * Rust 侧判断"该坐下了"或"该站起来了"。
 * 坐着时必须是坐姿类动作，站着时必须是站姿类动作；这里一旦姿态不匹配就
 * 用过渡动画换过去（不再渐入渐出）。坐下时在正坐/侧坐里随机挑一个。
 */
function applyPosture(sit, attempt = 0) {
  const want = sit ? 'sit' : 'stand'
  posture = want
  if (!sit) duckLock = false
  if (!current) return

  // 已经在目标姿态（含正在过渡过去）就不动
  const inWant = want === 'stand' ? granular === 'stand' : granular !== 'stand'
  if (inWant) return

  // 正在淡入 / 播过渡：等一小会再试（此时 granular 未变，重试会再次走到 inWant 检查）
  if (switching || transitioning) {
    if (attempt < 60) {
      setTimeout(() => applyPosture(sit, attempt + 1), 80)
    }
    return
  }

  if (want === 'sit') {
    // 重力下落锁定的鸭子坐优先，不能被随机坐姿覆盖
    if (duckLock) {
      const duck = pickSit('duck')
      if (duck) switchTo(duck)
      return
    }
    const g = pickSitGranular()
    const target = pickSit(g === 'sit_duck' ? 'duck' : 'upright')
    if (!target) return
    switchTo(target)
  } else {
    const target = pickForPosture('stand')
    if (!target) return
    switchTo(target)
  }
}

/**
 * 重力下落瞬间：不管当前是站姿、正坐还是过渡，直接抢占切到鸭子坐待机。
 * 不播过渡、不排队，保证掉落第一瞬间就是鸭子坐。
 */
function forceDuck() {
  const duck = pool.find((i) => i.id === 'sit_duck_idle')
  if (!duck) return
  duckLock = true
  posture = 'sit'
  granular = 'sit_duck'
  transitioning = false
  play(duck.id, {
    force: true,
    preempt: true,
    loop: true,
    silent: true,
    keepTimer: true,
  })
}

/**
 * 循环预览一次性动作（过渡/慌张）：临时调大小用。
 * 强制 loop，播多久都行；不落盘、不触发状态机、不打断随机计时器。
 * 用户点一个待机动作即可回到正常状态机。
 */
function previewAction(id) {
  const item = pool.find((i) => i.id === id)
  if (!item || item.trigger === 'milk_tea') return
  play(item.id, { loop: true, force: true, silent: true, keepTimer: true })
}

/**
 * 把当前动作的接触点几何告诉 Rust。
 *
 * 直接量视频元素的真实布局，而不是自己按 1024 推：
 * 显示尺寸 = 档位物理像素 × 动作缩放，容器永远是 1024 但视频不是，
 * 所以接地线距窗口顶部的距离必须实测。
 *
 *   offY  = 接地线距窗口顶部（物理像素）
 *   charH = 角色在屏幕上的实际高度（物理像素）
 *
 * 吸附/重力全靠这两个数，所以切动作、改档位、调缩放、换坐姿之后都要重新同步。
 */
function syncContact() {
  const v = layers[frontIdx]
  if (!v) return
  const r = v.getBoundingClientRect()
  if (!r.height) return
  const dpr = window.devicePixelRatio || 1
  const offY = (r.top + groundRatio * r.height) * dpr
  const charH = 0.68 * r.height * dpr
  invoke('set_contact', { offY, charH })
}

function waitEvent(el, name, ms = 5000) {
  return new Promise((resolve) => {
    let done = false
    const fire = () => { if (!done) { done = true; cleanup(); resolve() } }
    const cleanup = () => {
      el.removeEventListener(name, fire)
      el.removeEventListener('error', fire)
      clearTimeout(t)
    }
    const t = setTimeout(fire, ms)
    el.addEventListener(name, fire, { once: true })
    el.addEventListener('error', fire, { once: true })
  })
}

/** 给可能永远不 settle 的 promise 加个上限，避免整套切换流程被卡死 */
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))])
}

function clearOnEnded(v) {
  if (v._onEnded) {
    v.removeEventListener('ended', v._onEnded)
    v._onEnded = null
  }
}

async function play(id, opts = {}) {
  const item = pool.find((i) => i.id === id)
  if (!item) return
  if (current && current.id === id && !opts.force) return
  if (switching && !opts.preempt) return
  const token = ++playToken
  switching = true
  if (opts.preempt) {
    clearOnEnded(layers[0])
    clearOnEnded(layers[1])
  }

  const cur = layers[frontIdx]
  const nxt = layers[1 - frontIdx]

  try {
    const url = urlOf(item)
    if (token !== playToken) return
    if (nxt.getAttribute('src') !== url) {
      nxt.src = url
      nxt.load()
      await waitEvent(nxt, 'loadeddata')
      if (token !== playToken) return
    }
    nxt.currentTime = 0
    // opts.loop 可覆盖：预览过渡时强制循环，方便调大小
    const isOneShot = opts.loop != null ? !opts.loop : item.loop === false
    nxt.loop = !isOneShot
    nxt.playbackRate = 1
    // 一旦播到循环动作（待机 / 强制循环预览），就说明已"落定"，清掉过渡进行中标记。
    // 收口在这里比各回调里手动清更稳：即使过渡被中断也能保证不卡死。
    if (!isOneShot) transitioning = false
    clearOnEnded(nxt)
    if (isOneShot && opts.onEnded) {
      const handler = () => {
        clearOnEnded(nxt)
        // 已经被别的动作顶掉就不触发后续，避免在错误时机再切一次
        if (current !== item) return
        opts.onEnded()
      }
      nxt._onEnded = handler
      nxt.addEventListener('ended', handler, { once: true })
    }
    layerActionId[1 - frontIdx] = item.id
    applyLayerScale(1 - frontIdx)
    // play() 在媒体被阻塞时可能永远不 resolve，加个上限兜底
    await withTimeout(nxt.play().catch(() => {}), 3000)
    if (token !== playToken) return
    nxt.classList.add('on')
    cur.classList.remove('on')
    frontIdx = 1 - frontIdx
    current = item

    setTimeout(() => {
      // 只有真的退到后面的层才动它；连续快切时前面那层可能又被顶回前台
      if (cur === layers[frontIdx]) return
      cur.pause()
      clearOnEnded(cur)
      // 释放闲置层的解码帧：只 pause() 不摘 src 的话，Chromium 会继续为
      // 这个 <video> 保留整份已解码帧缓冲（显存），切得越多叠得越厚。
      // removeAttribute + load() 把帧缓冲彻底还回去，长期只占当前层一份。
      cur.removeAttribute('src')
      cur.load()
      refreshMask()
    }, FADE_MS + 80)

    // 首帧可能还没稳定，再补一次掩膜采样，避免刚切完点不到
    setTimeout(() => {
      if (current === item) refreshMask()
    }, 900)

    // 只有可手动播放的待机动作才落盘为"恢复动作"；过渡/慌张是瞬态，不落盘
    if (!opts.silent && item.playable) {
      cfg.action = id
      invoke('save_cfg', { patch: { action: id } })
    }
    syncContact()
    if (!opts.keepTimer) scheduleRandom()
    broadcastState()
  } finally {
    if (token === playToken) switching = false
  }
}

function pickRandomTarget() {
  // 随机池包含除慌张外的全部可播放动作：待机会保持所选间隔，其余播一次
  const base = playablePool
  if (!base.length) return null
  const others = base.filter((i) => !current || i.id !== current.id)
  const list = others.length ? others : base
  return list[(Math.random() * list.length) | 0]
}

function scheduleRandom() {
  if (randomTimer) { clearTimeout(randomTimer); randomTimer = null }
  if (!cfg.random || chatOpen) return
  const intervalSec = Math.max(60, Number(cfg.interval) || 180)
  randomTimer = setTimeout(() => {
    if (chatOpen) return
    if (aiBusy || switching || transitioning) {
      randomTimer = setTimeout(scheduleRandom, 1000)
      return
    }
    const target = pickRandomTarget()
    if (!target) {
      scheduleRandom()
      return
    }
    if (IDLE_ACTIONS.has(target.id)) {
      // 待机动画完整显示一个间隔后再换
      switchTo(target, { keepTimer: true })
      scheduleRandom()
    } else {
      // 一次性动作播完回到待机，再重新开始计时
      playOneShot(target.id, idleIdFor(granularOf(target)))
      if (!aiBusy) scheduleRandom()
    }
  }, intervalSec * 1000)
}

function setRandom(on) {
  cfg.random = !!on
  invoke('save_cfg', { patch: { random: cfg.random } })
  scheduleRandom()
  broadcastState()
}

function setIntervalSec(seconds) {
  const allowed = [180, 600, 900]
  const value = Number(seconds)
  cfg.interval = allowed.includes(value) ? value : 180
  invoke('save_cfg', { patch: { interval: cfg.interval } })
  scheduleRandom()
  broadcastState()
}

function setAlwaysOnTop(on) {
  cfg.alwaysOnTop = !!on
  invoke('set_always_on_top', { on: cfg.alwaysOnTop })
  broadcastState()
}

/** 吸附与重力互斥：开吸附就自动关重力 */
function setSnap(on) {
  cfg.snap = !!on
  if (cfg.snap) cfg.gravity = false
  invoke('save_cfg', { patch: { snap: cfg.snap, gravity: cfg.gravity } })
  broadcastState()
}

function setGravity(on) {
  if (cfg.snap) return // 吸附开着时不允许
  cfg.gravity = !!on
  invoke('save_cfg', { patch: { gravity: cfg.gravity } })
  broadcastState()
}

// ————————————————————————— 大小档位 —————————————————————————

function setSize(key) {
  if (!SIZES[key]) return
  // 先改 cfg.size：syncContact 要靠它查下沉表，顺序反了会按旧档位算
  cfg.size = key
  applySize(key)
  invoke('save_cfg', { patch: { size: key } })
  broadcastState()
}

function applySize(key) {
  const physical = SIZES[key] || SIZES.medium
  const dpr = window.devicePixelRatio || 1
  containerCss = physical / dpr
  for (let i = 0; i < layers.length; i++) applyLayerScale(i)
  refreshMask()
  syncContact()
}

/** 按「该层正在播的动作」的缩放系数，单独决定这一层的显示尺寸与上下偏移 */
function applyLayerScale(i) {
  const v = layers[i]
  if (!v) return
  const id = layerActionId[i]
  const s = id && scales[id] != null ? scales[id] : 1
  layerScale[i] = s
  const px = containerCss * s
  v.style.width = px + 'px'
  v.style.height = px + 'px'
  // 垂直偏移：坐姿/慌张可调（-20~20 CSS px），用于校正视频素材的接地位差
  const off = id ? offsetOf(id) : 0
  if (off === 0) {
    v.style.transform = 'translate(-50%, -50%)'
  } else {
    v.style.transform = `translate(-50%, calc(-50% + ${off}px))`
  }
}

// ————————————————————————— 缩放调参 —————————————————————————

// v3：13 个动作的缩放已实测定稿写进 manifest（定稿值），v2 里存的是调参过程
// 留下的中间值，继续沿用会盖掉定稿值，所以换键作废。
const SCALE_STORE = 'sukipet.devScales.v4'

function readDevScales() {
  try {
    return JSON.parse(localStorage.getItem(SCALE_STORE) || '{}') || {}
  } catch {
    return {}
  }
}

/** 改某个动作的缩放，立刻生效（当前正在播的话） */
function setActionScale(id, value) {
  const v = Math.round(Math.min(1.5, Math.max(0.3, Number(value))) * 1000) / 1000
  scales[id] = v

  const store = readDevScales()
  store[id] = v
  try {
    localStorage.setItem(SCALE_STORE, JSON.stringify(store))
  } catch {}

  const i = layerActionId.indexOf(id)
  if (i >= 0) {
    applyLayerScale(i)
    refreshMask()
    syncContact()
  }
  return v
}

function resetActionScale(id) {
  const item = pool.find((i) => i.id === id)
  const base = item && typeof item.scale === 'number' ? item.scale : 1
  const store = readDevScales()
  delete store[id]
  try {
    localStorage.setItem(SCALE_STORE, JSON.stringify(store))
  } catch {}
  scales[id] = base
  const i = layerActionId.indexOf(id)
  if (i >= 0) {
    applyLayerScale(i)
    refreshMask()
    syncContact()
  }
  return base
}

// ————————————————————————— 动作上下偏移调参 —————————————————————————

// 坐姿动画的偏移出厂值来自 manifest（定稿）；慌张挥手可在开发者模式调，
// 覆盖值存 localStorage（键为动作 id → CSS px）。范围 -20~20。
const OFFSET_STORE = 'sukipet.actionOffsets.v2'
const BUBBLE_STORE = 'sukipet.bubbleOffset.v2'

function readActionOffsets() {
  try {
    return JSON.parse(localStorage.getItem(OFFSET_STORE) || '{}') || {}
  } catch {
    return {}
  }
}

/** 某动作当前的垂直偏移：localStorage 覆盖值优先，否则用 manifest 出厂 offset。 */
function offsetOf(id) {
  const o = offsets[id]
  if (typeof o === 'number') return o
  const item = pool.find((i) => i.id === id)
  return item && typeof item.offset === 'number' ? item.offset : 0
}

/** 调某个动作的上下偏移，立刻生效（当前正在播的话） */
function setActionOffset(id, value) {
  // 开发者面板用 0.1px 精度，范围放宽到 ±100px，方便校准不同动作的接地位差
  const v = Math.round(Math.min(100, Math.max(-100, Number(value) || 0)) * 10) / 10
  offsets[id] = v

  const store = readActionOffsets()
  store[id] = v
  try {
    localStorage.setItem(OFFSET_STORE, JSON.stringify(store))
  } catch {}

  const i = layerActionId.indexOf(id)
  if (i >= 0) {
    applyLayerScale(i)
    refreshMask()
    syncContact()
  }
  return v
}

function resetActionOffset(id) {
  const store = readActionOffsets()
  delete store[id]
  try {
    localStorage.setItem(OFFSET_STORE, JSON.stringify(store))
  } catch {}
  delete offsets[id]
  const i = layerActionId.indexOf(id)
  if (i >= 0) {
    applyLayerScale(i)
    refreshMask()
    syncContact()
  }
  const item = pool.find((it) => it.id === id)
  return item && typeof item.offset === 'number' ? item.offset : 0
}

// ————————————————————————— alpha 掩膜 —————————————————————————

const maskCanvas = document.createElement('canvas')
maskCanvas.width = MASK_N
maskCanvas.height = MASK_N
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })

/**
 * 按需刷新（不再 200ms 定时）：只在切动作 / 改档位 / 调缩放时采一次样。
 * 待机动画摆动只有几像素，192² 掩膜下对命中判定没有影响。
 */
function refreshMask() {
  const v = layers[frontIdx]
  if (!v || v.readyState < 2 || !v.videoWidth) return

  // 用实际布局矩形，这样动作缩放、大小档位变化都能自动跟随
  const W = window.innerWidth
  const H = window.innerHeight
  const r = v.getBoundingClientRect()
  const px = r.width || W
  const py = r.height || H

  const gw = Math.max(1, Math.round((px / W) * MASK_N))
  const gh = Math.max(1, Math.round((py / H) * MASK_N))
  const gx = Math.round((r.left / W) * MASK_N)
  const gy = Math.round((r.top / H) * MASK_N)

  maskCtx.clearRect(0, 0, MASK_N, MASK_N)
  try {
    maskCtx.drawImage(v, gx, gy, gw, gh)
  } catch (e) {
    console.warn('[pet] 掩膜采样失败:', e.message)
    return
  }

  const data = maskCtx.getImageData(0, 0, MASK_N, MASK_N).data
  const out = new Array(MASK_N * MASK_N)
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] > 40 ? 1 : 0

  invoke('set_mask', { w: MASK_N, h: MASK_N, data: out })
}

// ————————————————————————— 输入 —————————————————————————

function bindInput() {
  const beginDrag = async () => {
    if (dragging) return
    dragging = true
    document.body.classList.add('dragging')
    try {
      await invoke('start_drag')
    } catch (e) {
      console.warn('[pet] start_drag failed', e)
    }
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
    try { e.target.setPointerCapture?.(e.pointerId) } catch {}
  })

  window.addEventListener('pointermove', (e) => {
    if (!press || press.id !== e.pointerId) return
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) {
      press.moved = true
      beginDrag()
    }
  })

  const finish = async (e) => {
    if (!press || (e && e.pointerId !== press.id)) return
    const p = press
    press = null
    if (p.moved || dragging) {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('dragging')
      try {
        await invoke('end_drag')
      } catch {}
      return
    }
    handlePetClick(p.x, p.y)
  }

  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  window.addEventListener('blur', () => { if (press) finish() })

  // 右键 → 打开独立工具箱窗口（不再就地弹菜单）
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    invoke('open_toolbox')
  })
}

// ————————————————————————— 点击互动 / AI 动作 —————————————————————————

const pick = (list) => list[(Math.random() * list.length) | 0]

function loadTouchOverrides() {
  try {
    const raw = localStorage.getItem(TOUCH_OVERRIDE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    touchOverrides = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    touchOverrides = {}
  }
}

function saveTouchOverrides() {
  try {
    localStorage.setItem(TOUCH_OVERRIDE_KEY, JSON.stringify(touchOverrides))
  } catch {}
}

function touchPoolKey(pose, zone) {
  return `${pose}.${zone}`
}

function effectiveTouchPool(pose, zone) {
  const key = touchPoolKey(pose, zone)
  const base = TOUCH_POOLS[key] || []
  const overrides = touchOverrides[key] || {}
  return base.map((line, index) => {
    const replacement = overrides[index]
    return typeof replacement === 'string' && replacement.trim() ? replacement : line
  })
}

function pickTouchLine(pose, zone) {
  const key = touchPoolKey(pose, zone)
  const lines = effectiveTouchPool(pose, zone)
  if (!lines.length) return '嘿嘿……'
  let line = pick(lines)
  if (lines.length > 1 && line === lastTouchLine[key]) {
    line = lines[(lines.indexOf(line) + 1) % lines.length]
  }
  lastTouchLine[key] = line
  return line
}

function storeGeneratedTouchReply(pose, zone, raw) {
  const key = touchPoolKey(pose, zone)
  const base = TOUCH_POOLS[key] || []
  if (!base.length) return
  const clean = String(raw || '')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean || clean.length > 80) return
  if (effectiveTouchPool(pose, zone).includes(clean)) return
  const index = Math.floor(Math.random() * base.length)
  if (!touchOverrides[key] || typeof touchOverrides[key] !== 'object') touchOverrides[key] = {}
  touchOverrides[key][index] = clean
  saveTouchOverrides()
}

function requestGeneratedTouchReply(pose, zone, action) {
  invoke('generate_touch_reply', { zone, pose, action })
    .then((text) => storeGeneratedTouchReply(pose, zone, text))
    .catch(() => {})
}

function afterStand(callback, attempt = 0) {
  if (switching || transitioning || granular !== 'stand') {
    if (attempt < 100) setTimeout(() => afterStand(callback, attempt + 1), 80)
    return
  }
  callback()
}

function playMilkTea(variant) {
  const item = pool.find((i) => i.id === variant && i.trigger === 'milk_tea')
  if (!item) return
  if (aiBusy || switching || transitioning) {
    if (!milkTeaPending) {
      milkTeaPending = variant
      setTimeout(() => {
        const next = milkTeaPending
        milkTeaPending = null
        if (next) playMilkTea(next)
      }, 300)
    }
    return
  }
  const returnIdle = idleIdFor(granular)
  if (granular === 'stand') {
    invoke('milk_tea_reply').catch(() => {})
    playOneShot(variant, 'stand_idle')
    return
  }
  aiBusy = true
  const stand = pool.find((i) => i.id === 'stand_idle')
  if (!stand) {
    aiBusy = false
    return
  }
  switchTo(stand, { force: true, keepTimer: true })
  setTimeout(() => {
    afterStand(() => {
      aiBusy = false
      invoke('milk_tea_reply').catch(() => {})
      playOneShot(variant, returnIdle)
    })
  }, 80)
}

function idleIdFor(granularValue) {
  if (granularValue === 'sit_duck') return 'sit_duck_idle'
  if (granularValue === 'sit_upright') return 'sit_upright_idle'
  return 'stand_idle'
}

function settleIdFor() {
  return idleIdFor(granular)
}

function readBubbleOffset() {
  // 固定 150px；不再受 localStorage / 旧值影响
  return 150
}

/** 气泡整体上下偏移：正数向下，范围 ±400px */
function applyBubbleOffset(value, persist = true) {
  const offset = Math.round(Math.min(400, Math.max(-400, Number(value) || 0)))
  bubbleOffset = offset
  document.documentElement.style.setProperty('--bubble-offset', `${offset}px`)
  if (persist) {
    try { localStorage.setItem(BUBBLE_STORE, String(offset)) } catch {}
  }
  return offset
}

/** 只给主动陪伴气泡用：换行/连续空白归一化，过长截断。 */
function normalizeBubbleText(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(text)
  return chars.length > 120 ? chars.slice(0, 120).join('') + '…' : text
}

function stopTts() {
  ttsToken += 1
  if (ttsAudio) {
    try { ttsAudio.pause() } catch {}
    ttsAudio = null
  }
  if (ttsUrl) {
    try { URL.revokeObjectURL(ttsUrl) } catch {}
    ttsUrl = null
  }
}

function setTts(on) {
  cfg.tts = !!on
  if (!cfg.tts) stopTts()
  invoke('save_cfg', { patch: { tts: cfg.tts } }).catch(() => {})
  broadcastState()
}

/** 用 Qwen-Audio-TTS 合成并播放；只播放最新一句，避免叠音。 */
async function speak(text) {
  const clean = String(text || '').trim()
  if (!clean) return
  if (!cfg || !cfg.tts) {
    safeEmit('pet:tts-started', { text: clean })
    return
  }
  stopTts()
  const token = ttsToken
  try {
    const audioUrl = await invoke('tts_speak', { text: clean })
    if (token !== ttsToken || !cfg.tts) return
    const comma = audioUrl.indexOf(',')
    if (comma < 0) return
    const meta = audioUrl.slice(0, comma)
    const base64 = audioUrl.slice(comma + 1)
    const mime = (meta.match(/^data:([^;]+)/) || [])[1] || 'audio/mpeg'
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    ttsUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
    const audio = new Audio(ttsUrl)
    audio.volume = 0.9
    ttsAudio = audio
    audio.addEventListener('ended', () => {
      if (ttsAudio === audio) stopTts()
    }, { once: true })
    await audio.play().catch((error) => {
      console.warn('[pet] TTS play failed', error)
    })
    if (token === ttsToken) safeEmit('pet:tts-started', { text: clean })
  } catch (error) {
    console.warn('[pet] TTS failed', error)
    if (token === ttsToken) safeEmit('pet:tts-started', { text: clean })
  }
}

/** AI 聊天/互动台词原样显示，不做换行或长度处理。 */
function showBubble(text, ms = 4500, opts = {}) {
  const el = document.getElementById('bubble')
  if (!el || !text) return
  el.textContent = text
  el.classList.add('show')
  if (opts.speakNow !== false) speak(text)
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    el.classList.remove('show')
    bubbleTimer = null
  }, ms)
}

async function showBubbleAfterSpeech(text, ms) {
  await speak(text)
  showBubble(text, ms, { speakNow: false })
}

function showAmbientBubble(text) {
  const clean = normalizeBubbleText(text)
  if (clean) showBubble(clean, 8000)
}

/** 打开聊天时回到当前姿态的待机；已经在待机就保持原样。 */
function settleForChat(attempt = 0) {
  if (!chatOpen || !cfg) return
  const currentIdle =
    current && IDLE_ACTIONS.has(current.id) && granularOf(current) === granular
  const target = currentIdle ? current : pool.find((i) => i.id === idleIdFor(granular))
  if (!target) return
  if (switching) {
    if (attempt < 40) setTimeout(() => settleForChat(attempt + 1), 80)
    return
  }
  transitioning = false
  if (!current || current.id !== target.id) {
    switchTo(target, { keepTimer: true })
  }
}

function playOneShot(id, settle, onDone) {
  if (switching || transitioning) return
  const item = pool.find((i) => i.id === id)
  if (!item) return
  aiBusy = true
  scheduleRandom()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(fallback)
    aiBusy = false
    const back = pool.find((i) => i.id === settle)
    if (back) {
      switchTo(back, { keepTimer: true })
    } else {
      scheduleRandom()
    }
    if (typeof onDone === 'function') onDone()
  }
  const fallback = setTimeout(finish, 12000)
  switchTo(item, {
    loop: false,
    force: true,
    silent: true,
    keepTimer: true,
    onEnded: finish,
  })
}

function handlePetClick(cx, cy) {
  if (aiBusy || switching || transitioning) return
  const w = window.innerWidth || 1
  const h = window.innerHeight || 1
  const rx = cx / w
  const ry = cy / h
  if (rx < 0.15 || rx > 0.85) return

  let zone = null
  if (ry < 0.45) zone = 'head'
  else if (ry < 0.72) zone = 'belly'
  else if (ry < 0.90) zone = 'leg'
  if (!zone) return

  const suffix = zone === 'head' ? pick(['wipe', 'hair']) : zone === 'belly' ? 'giggle' : 'angry'
  const actionId = `${granular}_${suffix}`
  if (!pool.some((i) => i.id === actionId)) return

  showBubble(pickTouchLine(granular, zone), 4500)
  playOneShot(actionId, idleIdFor(granular))
  requestGeneratedTouchReply(granular, zone, suffix)
}

function playAiAction(action) {
  if (!action || aiBusy || switching || transitioning) return
  const item = pool.find((i) => i.id === action)
  if (!item || item.trigger) return
  // 只允许当前姿态的动作；不匹配就回到当前姿态待机
  if (granularOf(item) !== granular) {
    const settle = pool.find((i) => i.id === settleIdFor())
    if (settle) switchTo(settle, { keepTimer: true })
    return
  }
  playOneShot(action, settleIdFor())
}

// ————————————————————————— 提示 —————————————————————————

function showHint() {
  const h = document.getElementById('hint')
  h.classList.add('show')
  setTimeout(() => h.classList.remove('show'), HINT_MS)
}

// shixiaoyu-funny原创，详见bilibili：https://space.bilibili.com/517323821?spm_id_from=333.337.0.0，仅供学习，严禁商用
