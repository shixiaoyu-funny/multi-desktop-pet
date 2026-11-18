/**
 * Multi_Pet —— 主窗口前端（Tauri 2）
 * shixiaoyu-funny
 *
 * Raven × Suki 共用同一套系统：
 *  · 角色切换 → 换 manifest / 换主题色 / 换人设
 *  · 双层 <video> 交叉淡入播放 WebM（含 Alpha）
 *  · 待机（循环）手动切换、姿态（站/坐）切换
 *  · AI 聊天触发一次性动作（站姿触发站姿、坐姿触发坐姿）
 *  · 设置：自启动 / 重力 / 窗口吸附 / 语音
 *  · 养成：好感度阶段、喝奶茶、触摸互动
 */

// —— 启动前自检：把运行时错误直接显示到窗口上，方便定位 ——
function reportError(tag, err) {
  const banner = document.getElementById('errBanner')
  if (banner) {
    banner.hidden = false
    banner.textContent = `[${tag}] ${err && err.message ? err.message : err}`
  }
  console.error('[duo]', tag, err)
}
window.addEventListener('error', (e) => reportError('error', e.message || e.error))
window.addEventListener('unhandledrejection', (e) => reportError('rejection', e.reason))

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const safeListen = (name, cb) =>
  listen(name, cb).catch((e) => console.warn('[duo] 监听失败', name, e))


// ————————————————————————— 全局状态 —————————————————————————

let cfg = null
let characters = []
let activeChar = 'raven'
let manifest = null
let pool = []          // 拍平后的全部动作
let idles = []         // loop=true 的循环待机
let current = null     // 当前动作
let granular = 'stand'
let posture = 'stand'

let layers = []
let frontIdx = 0
/** 每层当前承载的动作 id（调参时按动作查 scale / offset 用） */
const layerActionId = [null, null]
let switching = false
let playToken = 0
let oneShotBusy = false

// 舞台几何（预览）
let stage = null
let petSize = 340
let groundRatio = 0.861
let contact = { x: 0, y: 0 }
let groundY = 0

let ttsAudio = null
let ttsUrl = null
let bubbleTimer = null

/**
 * 全屏静默：用户在玩全屏游戏 / 看全屏视频时，桌宠窗口会被隐藏，
 * 主面板这边也要把预览用的 alpha 视频解码器还回去（显存占用的另一半在这）。
 * 恢复时把静默前那个动作接上。
 */
let suspended = false
let resumeState = null

const blobUrlCache = new Map()

// ————————————————————————— 工具函数 —————————————————————————

function urlOf(item) {
  // manifest 里的 file 可能是 "assets/idle/xxx.webm"，去掉前缀统一归到角色目录
  const rel = item.file.replace(/^assets\//, '')
  return 'assets/' + activeChar + '/' + rel.split('/').map(encodeURIComponent).join('/')
}

function blobUrlOf(url) {
  if (!blobUrlCache.has(url)) {
    const pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`)
        return r.blob()
      })
      .then((blob) => URL.createObjectURL(blob))
    blobUrlCache.set(url, pending)
  }
  return blobUrlCache.get(url)
}

function granularOf(item) {
  if (!item) return 'stand'
  if (item.transition) return item.transition.to
  if (item.posture !== 'sit') return 'stand'
  if (item.sitKind === 'side') return 'sit_side'
  if (item.sitKind === 'duck') return 'sit_duck'
  return 'sit_upright'
}

function postureOf(item) {
  if (!item) return 'stand'
  if (item.posture) return item.posture
  return /^sit/.test(item.id) ? 'sit' : 'stand'
}

function granularLabel(g) {
  return { stand: '站姿', sit_upright: '正坐', sit_side: '侧坐', sit_duck: '鸭子坐' }[g] || '站姿'
}

function idleFor(g) {
  const found = idles.find((i) => granularOf(i) === g)
  return found || idles[0] || null
}

/**
 * 找过渡动画（和 pet.js 的 findTransition 保持同一套匹配规则）。
 *
 * 1. 带 `fromId/toId` 的按动作 id 精确匹配 —— 同姿态内部的过渡（站姿待机↔抱胸、正坐↔托腮）
 *    granular 完全一样，只按 granular 判会拿到「站→坐」那种跨姿态的片子，姿态端点不对。
 *    只写了 fromId 或只写了 toId 的片子按「任意另一端」算。
 * 2. 否则按 `from/to`（granular）匹配，跨姿态（站↔坐）走这条。
 */
function findTransition(from, to, fromId, toId) {
  const hit = pool.filter((i) => {
    const t = i.transition
    if (!t) return false
    if (t.fromId || t.toId) {
      if (t.fromId && t.fromId !== fromId) return false
      if (t.toId && t.toId !== toId) return false
      return true
    }
    return t.from === from && t.to === to
  })
  if (!hit.length) return null
  // 端点精确的优先，见 pet.js findTransition 的注释
  const exact = hit.filter((i) => i.transition.fromId || i.transition.toId)
  return (exact.length ? exact : hit)[0]
}

// ————————————————————————— 启动 —————————————————————————

async function boot() {
  stage = document.getElementById('stage')
  layers = [document.getElementById('vidA'), document.getElementById('vidB')]
  for (const v of layers) {
    v.muted = true
    v.playsInline = true
    v.disablePictureInPicture = true
    v.addEventListener('error', () => console.warn('[duo] 视频加载失败', v.src))
  }

  const st = await invoke('bootstrap')
  cfg = st.cfg
  characters = st.characters || []
  activeChar = cfg.activeChar || 'raven'
  // 调参覆盖值 / 气泡偏移要先读，layoutStage 里 placeAllLayers 就会用到 scale
  loadDevState()
  applyBubbleOffset(bubbleOffset, false)
  // 尺寸档也决定预览基准大小，得在第一次 layoutStage 之前同步
  refreshDevFromCfg()

  renderCharTabs()
  await switchCharacter(activeChar, { boot: true })

  bindListeners()
  bindBounce()
  refreshSettings()
  layoutStage()
  showHint()

  console.log('[duo] ready:', activeChar, current && current.id)
}

async function switchCharacter(charId, opts = {}) {
  if (!charId) return
  activeChar = charId
  if (!opts.boot) invoke('save_cfg', { patch: { activeChar: charId } }).catch(() => {})
  document.body.dataset.char = charId
  document.querySelectorAll('.char-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.char === charId)
  })
  updateAffinityBadge()
  // 切角色时立刻掐掉上一位还没念完的语音，并同步语音开关的可用性
  stopTts()
  refreshTtsRow()

  const man = await (await fetch('assets/' + charId + '/manifest.json')).json()
  manifest = man
  if (typeof man.groundRatio === 'number') groundRatio = man.groundRatio

  pool = []
  idles = []
  for (const key of Object.keys(man.pools || {})) {
    const p = man.pools[key]
    for (const it of p.items || []) {
      const item = { ...it, loop: it.loop != null ? it.loop : p.loop !== false }
      pool.push(item)
      if (item.loop === true) idles.push(item)
    }
  }

  // 重置姿态
  granular = 'stand'
  posture = 'stand'
  current = null
  oneShotBusy = false
  frontIdx = 0
  switching = false
  playToken++

  for (const v of layers) {
    v.removeAttribute('src')
    v.load()
    v.classList.remove('on')
    v.style.clipPath = ''
  }
  layerActionId[0] = null
  layerActionId[1] = null

  // 切角色后坐线表/尺寸档要按新角色重读，覆盖表也换一份推给桌面窗
  refreshDevFromCfg()
  applyBubbleOffset(bubbleOffset, false)
  broadcastDev()

  renderIdleList()
  layoutStage()

  // 只有带饮品动作的角色才显示这枚按钮；名称由角色决定（奶茶 / 茶饮）
  refreshDrinkButton()

  const first = idleFor('stand') || pool.find((i) => i.loop === true) || pool[0]
  if (first) await play(first.id, { instant: true })

  // 面板开着时切角色：动作列表、坐线滑杆、尺寸档都要按新角色重刷一遍
  if (devOpen) {
    devSelectedId = current ? current.id : null
    renderDev(true)
    syncDevValues()
  }

  invoke('report_posture', { posture, granular, action: current && current.id }).catch(() => {})
  loadChatHistory()
}

function renderCharTabs() {
  const tabs = document.getElementById('charTabs')
  tabs.innerHTML = ''
  for (const c of characters) {
    const btn = document.createElement('button')
    btn.className = 'char-tab' + (c.id === activeChar ? ' active' : '')
    btn.dataset.char = c.id
    const initial = (c.display || c.name || '?').slice(0, 1)
    btn.innerHTML = `<img src="${c.avatar}" alt="${c.name}" /><span>${c.name}</span>`
    // 头像资源缺失时退回首字圆章，避免破图
    const img = btn.querySelector('img')
    img.onerror = () => {
      const span = document.createElement('span')
      span.className = 'avatar-fallback'
      span.textContent = initial
      img.replaceWith(span)
    }
    btn.onclick = () => switchCharacter(c.id)
    tabs.appendChild(btn)
  }
}

// ————————————————————————— 全屏静默 —————————————————————————

/** 释放两层预览 video 的解码器（pause 不解码器，显存不会降） */
function releaseStageDecoders() {
  for (const v of layers) {
    try {
      v.pause()
      clearOnEnded(v)
      v.removeAttribute('src')
      v.load()
    } catch {}
    v.classList.remove('on')
  }
  frontIdx = 0
}

function suspendForFullscreen(title) {
  if (suspended) return
  suspended = true
  resumeState = current ? { id: current.id, loop: current.loop !== false } : null
  // 打断在飞的播放：token 作废，switching 别留成 true 卡住后续播放
  playToken++
  switching = false
  oneShotBusy = false
  stopTts()
  if (bubbleTimer) {
    clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  const b = document.getElementById('bubble')
  if (b) b.classList.remove('show')
  releaseStageDecoders()
  console.log('[duo] 全屏静默，已释放预览解码', title || '')
}

async function resumeFromFullscreen() {
  if (!suspended) return
  suspended = false
  const saved = resumeState
  resumeState = null
  try {
    const item = saved ? pool.find((i) => i.id === saved.id) : null
    if (item) {
      granular = granularOf(item)
      posture = granular === 'stand' ? 'stand' : 'sit'
      const badge = document.getElementById('postureBadge')
      if (badge) badge.textContent = granularLabel(granular)
      // 循环待机续上；一次性动作重播并自己收尾，避免停在最后一帧
      if (saved.loop) await play(item.id, { force: true, loop: true })
      else playOneshot(item.id, granular)
    } else {
      const back = idleFor(granular) || idleFor('stand')
      if (back) await play(back.id, { force: true, loop: true })
    }
    console.log('[duo] 退出全屏，恢复预览', current && current.id)
  } catch (e) {
    reportError('resume', e)
  }
}

// ————————————————————————— 舞台布局 / 物理 —————————————————————————

function layoutStage() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  groundY = h * 0.84
  // 预览也要能看出档位差别：中档基准 × 档位比例，再夹到舞台放得下的最大值。
  // 桌面窗那边是「窗口本身就是角色画布」，512 档的角色真的比 256 档大一倍，
  // 预览只画一个固定大小的框就完全看不出换档效果。
  const mediumBase = Math.min(420, Math.min(w, h) * 0.78)
  const want = mediumBase * (TIER_RATIO[devSize] || 1)
  const maxH = (groundY - 10) / groundRatio
  petSize = Math.max(150, Math.min(want, w * 0.96, maxH))
  document.documentElement.style.setProperty('--pet-size', petSize + 'px')
  // 恢复默认站位（居中、接地）
  contact.x = w / 2
  contact.y = groundY
  applyContact(contact.x, contact.y)
}

function applyContact(x, y) {
  contact.x = x
  contact.y = y
  placeAllLayers()
  const line = document.getElementById('groundLine')
  if (line) line.style.top = groundY + 'px'
}

/** 按「这一层正在播的动作」决定它的显示尺寸与位置，scale/offset 都从这里生效 */
function placeLayer(i) {
  const v = layers[i]
  if (!v) return
  const id = layerActionId[i]
  const item = id ? pool.find((x) => x.id === id) : null
  const px = petSize * scaleOf(item)
  const shift = snapShiftPreview()
  const left = contact.x - px / 2
  const top = contact.y - groundRatio * px + shift
  v.style.width = px + 'px'
  v.style.height = px + 'px'
  v.style.left = left + 'px'
  v.style.top = top + 'px'
  applyFrameClip(v, item, px, left, top, shift)
  // 窗口框永远跟着「当前动作」的 scale/offset 走，切动作时也要重画
  if (i === frontIdx) placePetFrame(item, px, shift)
}

function placeAllLayers() {
  for (let i = 0; i < layers.length; i++) placeLayer(i)
  placePetFrame(current, petSize * scaleOf(current), snapShiftPreview())
}

/**
 * 桌面窗只有 petSize 那么大，scale > 1 时视频是**被窗口裁掉的**。
 * 预览里不裁的话，用户会以为 1.2 没问题，回到桌面却看见角色被切边。
 * 这里按「窗口框 ⟂ 视频矩形」算一个 inset 裁剪，把预览还原成桌面上的样子。
 */
function applyFrameClip(v, item, px, left, top, shift = 0) {
  const off = offsetOf(item)
  const offY = (petSize - px) / 2 + off + groundRatio * px
  const frameLeft = contact.x - petSize / 2
  const frameTop = contact.y - offY + shift
  const clipTop = Math.max(0, frameTop - top)
  const clipLeft = Math.max(0, frameLeft - left)
  const clipRight = Math.max(0, left + px - (frameLeft + petSize))
  const clipBottom = Math.max(0, top + px - (frameTop + petSize))
  const any = clipTop + clipLeft + clipRight + clipBottom > 0.5
  v.style.clipPath = any
    ? `inset(${clipTop.toFixed(1)}px ${clipRight.toFixed(1)}px ${clipBottom.toFixed(1)}px ${clipLeft.toFixed(1)}px)`
    : ''
}

/**
 * 桌面窗口框（虚线）：offset 与落脚点微调的唯一可观察对象。
 * 角色脚底钉在接地线上，改 offset / 站姿落脚点动的是这个框 —— 和桌面上窗口真的挪了是一致的。
 * 虚线下面那条地线 = 任务栏 / 窗口上沿；落脚点为正时框和角色一起往下沉。
 */
function placePetFrame(item, px, shift = 0) {
  const frame = document.getElementById('petFrame')
  if (!frame) return
  const off = offsetOf(item)
  const offY = (petSize - px) / 2 + off + groundRatio * px
  frame.style.left = contact.x - petSize / 2 + 'px'
  frame.style.top = contact.y - offY + shift + 'px'
  frame.style.width = petSize + 'px'
  frame.style.height = petSize + 'px'
  const label = frame.firstElementChild
  if (label) {
    const tier = sizeLabel(devSize)
    label.textContent = `桌面窗口框 · ${tier}（物理）`
  }
}

// ————————————————————————— 动作播放 —————————————————————————

function waitEvent(el, name, ms = 5000) {
  return new Promise((resolve) => {
    let done = false
    const cleanup = () => {
      el.removeEventListener(name, fire)
      el.removeEventListener('error', fire)
      clearTimeout(t)
    }
    const fire = () => { if (!done) { done = true; cleanup(); resolve() } }
    const t = setTimeout(fire, ms)
    el.addEventListener(name, fire, { once: true })
    el.addEventListener('error', fire, { once: true })
  })
}

/** 新层画出一帧再硬切，避免透明窗口上两层同时半透明。 */
function waitPresented(video, ms = 700) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const t = setTimeout(finish, ms)
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        clearTimeout(t)
        finish()
      })
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(t)
        finish()
      }))
    }
  })
}

function clearOnEnded(v) {
  if (v._onEnded) {
    v.removeEventListener('ended', v._onEnded)
    v._onEnded = null
  }
}

async function play(id, opts = {}) {
  // 静默期间不开解码器；已经在跑的过渡/一次性动作的收尾会回到这里
  if (suspended) return
  const item = pool.find((i) => i.id === id)
  if (!item) return
  if (current && current.id === id && !opts.force) return
  if (switching && !opts.preempt) return
  const token = ++playToken
  switching = true

  const cur = layers[frontIdx]
  const nxt = layers[1 - frontIdx]

  try {
    const sourceUrl = urlOf(item)
    const url = sourceUrl
    if (nxt.getAttribute('src') !== url) {
      nxt.src = url
      nxt.load()
      await waitEvent(nxt, 'loadeddata')
      if (token !== playToken) return
    }
    if (nxt.currentTime > 0.04) {
      nxt.currentTime = 0
      await waitEvent(nxt, 'seeked', 2000)
      if (token !== playToken) return
    }
    const isOneShot = opts.loop != null ? !opts.loop : item.loop === false
    nxt.loop = !isOneShot
    clearOnEnded(nxt)
    if (isOneShot && opts.onEnded) {
      const handler = () => {
        clearOnEnded(nxt)
        if (current !== item) return
        opts.onEnded()
      }
      nxt._onEnded = handler
      nxt.addEventListener('ended', handler, { once: true })
    }
    await Promise.race([nxt.play().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
    if (token !== playToken) return
    await waitPresented(nxt)
    if (token !== playToken) return
    nxt.style.transition = 'none'
    cur.style.transition = 'none'
    nxt.classList.add('on')
    cur.classList.remove('on')
    frontIdx = 1 - frontIdx
    current = item
    layerActionId[frontIdx] = item.id
    placeLayer(frontIdx)
    highlightIdle()

    // 同步当前动作到桌面漂浮窗口；过渡动画只在桌面播，容器内直接切目标
    window.__TAURI__.event
      .emit('pet:action', {
        character: activeChar,
        action: item.id,
        loop: !isOneShot,
        transition: opts.transition || null,
      })
      .catch(() => {})

    setTimeout(() => {
      if (cur === layers[frontIdx]) return
      cur.pause()
      clearOnEnded(cur)
      cur.removeAttribute('src')
      cur.load()
    }, 80)

    if (item.playable !== false && item.loop !== false && !opts.silent) {
      invoke('save_cfg', { patch: {} }).catch(() => {})
    }
  } finally {
    if (token === playToken) switching = false
  }
}

function switchTo(item, opts = {}) {
  const to = granularOf(item)
  const from = granular
  const setG = (v) => {
    granular = v
    posture = v === 'stand' ? 'stand' : 'sit'
    document.getElementById('postureBadge').textContent = granularLabel(v)
    // 落脚点微调是按姿态取的：站/坐一换，两层都要按新姿态的下沉量重摆
    placeAllLayers()
  }
  setG(to)
  // 容器内不播过渡动画，直接切到目标姿态；把过渡动作交给桌面漂浮窗口播放。
  // 同姿态内部（托腮↔打瞌睡、正坐↔打瞌睡、托腮↔看电脑）granular 相同，必须带动作 id，
  // 否则 findTransition 会落到「站↔坐」中性片，或者干脆判成没有过渡。
  const fromId = current ? current.id : null
  const trans = fromId && fromId !== item.id ? findTransition(from, to, fromId, item.id) : null
  play(item.id, { ...opts, transition: trans ? trans.id : null })
}

function playOneshot(id, settleGranular) {
  const item = pool.find((i) => i.id === id)
  if (!item) return
  oneShotBusy = true
  const finish = () => {
    oneShotBusy = false
    // 动作可以声明自己的落点（比如悬浮冥想的最后一帧就是正坐姿，回托腮会跳一下）
    const back =
      (item.returnTo && pool.find((i) => i.id === item.returnTo)) || idleFor(settleGranular || granular)
    if (back && current && current.id !== back.id) switchTo(back, { force: true })
  }
  play(item.id, {
    loop: false,
    force: true,
    silent: true,
    onEnded: finish,
  })
  // 兜底：万一 ended 没触发，12 秒后强制回收
  setTimeout(() => { if (oneShotBusy && current === item) finish() }, 12000)
}

function playAiAction(action) {
  const item = pool.find((i) => i.id === action)
  if (!item) return
  if (granularOf(item) !== granular) {
    const settle = idleFor(granular)
    if (settle) switchTo(settle, { keepTimer: true })
    return
  }
  if (item.loop === true) {
    switchTo(item)
    return
  }
  playOneshot(action, granular)
}

// ————————————————————————— 待机 / 姿态面板 —————————————————————————

function renderIdleList() {
  const el = document.getElementById('idleList')
  el.innerHTML = ''
  // 按姿态分组
  const groups = {}
  for (const i of idles) {
    const g = granularOf(i)
    ;(groups[g] = groups[g] || []).push(i)
  }
  for (const g of Object.keys(groups)) {
    const label = document.createElement('div')
    label.className = 'idle-group-label'
    label.textContent = granularLabel(g)
    el.appendChild(label)
    for (const i of groups[g]) {
      const btn = document.createElement('button')
      btn.className = 'idle-item'
      btn.dataset.id = i.id
      btn.textContent = i.label || i.id
      btn.onclick = () => switchTo(i)
      el.appendChild(btn)
    }
  }
  highlightIdle()
}

function highlightIdle() {
  document.querySelectorAll('.idle-item').forEach((el) => {
    el.classList.toggle('active', current && el.dataset.id === current.id)
  })
}

// ————————————————————————— AI 聊天 —————————————————————————

function bindListeners() {
  safeListen('chat:delta', (e) => {
    const text = e.payload && e.payload.text
    if (text) streamText(text)
  })
  safeListen('chat:final', (e) => {
    const p = e.payload || {}
    if (p.character && p.character !== activeChar) return
    commitAssistant(p.reply, p.action)
  })
  safeListen('chat:error', (e) => {
    const p = e.payload || {}
    if (p.needSetup) {
      appendMsg('assistant', '还没有配置 DASHSCOPE_API_KEY。请先在系统环境变量中设置（详见说明）。')
    } else {
      appendMsg('assistant', '⚠ ' + (p.message || '出错了'))
    }
    setBusy(false)
  })
  safeListen('chat:ready', () => setBusy(false))
  safeListen('chat:affection', (e) => { if (e.payload) updateAffinityBadge(e.payload) })
  safeListen('pet:affection', (e) => { if (e.payload) updateAffinityBadge(e.payload) })
  safeListen('pet:ai-action', (e) => {
    const a = e.payload && e.payload.action
    if (a) playAiAction(a)
  })
  safeListen('pet:ai-reply', (e) => {
    const t = e.payload && e.payload.text
    if (t) showBubble(t, 9000)
  })
  safeListen('pet:milk-tea-reply', (e) => {
    const t = e.payload && e.payload.text
    if (t) showBubble(t, 7000)
  })
  safeListen('pet:tts', (e) => playTts(e.payload))
  safeListen('pet:tts-stop', () => stopTts())
  // 全屏静默：Rust 监视线程判定用户进入全屏后广播
  safeListen('pet:fullscreen', (e) => {
    const p = e.payload || {}
    if (p.hidden) suspendForFullscreen(p.title)
    else resumeFromFullscreen()
  })

  document.getElementById('chatSend').onclick = sendChat
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat()
  })

  // 设置
  document.getElementById('settingsBtn').onclick = openSettings
  document.getElementById('settingsClose').onclick = closeSettings
  document.getElementById('settingsDone').onclick = closeSettings
  document.getElementById('quitBtn').onclick = () => invoke('quit_app')

  document.getElementById('setAutostart').onchange = (e) => {
    invoke('set_autostart', { enabled: e.target.checked }).catch(() => {})
  }
  document.getElementById('setTts').onchange = (e) => {
    invoke('tts_set_enabled', { enabled: e.target.checked }).catch(() => {})
  }
  document.getElementById('setWebSearch').onchange = (e) => {
    cfg.webSearch = e.target.checked
    invoke('save_cfg', { patch: { webSearch: e.target.checked } }).catch(() => {})
  }
  document.getElementById('setFullscreenHide').onchange = (e) => {
    cfg.fullscreenHide = e.target.checked
    invoke('save_cfg', { patch: { fullscreenHide: e.target.checked } }).catch(() => {})
  }
  document.getElementById('clearMemoryBtn').onclick = clearMemory

  document.getElementById('gravityChip').onclick = () => {
    toggleGravity(!cfg.gravity)
    refreshSettings()
  }
  document.getElementById('snapChip').onclick = () => {
    toggleSnap(!cfg.snap)
    refreshSettings()
  }
  document.getElementById('bounceChip').onclick = () => {
    const next = !(window.PetBounce && PetBounce.enabled())
    if (window.PetBounce) PetBounce.setEnabled(next)
    const speed = window.PetBounce ? PetBounce.speed() : 2
    window.__TAURI__.event.emit('pet:bounce', { on: next, speed }).catch(() => {})
    refreshSettings()
  }
  document.getElementById('bounceSpeed').addEventListener('input', (e) => {
    if (!window.PetBounce) return
    const speed = PetBounce.setSpeed(e.target.value)
    syncBounceSpeedUi()
    window.__TAURI__.event
      .emit('pet:bounce', { on: PetBounce.enabled(), speed })
      .catch(() => {})
  })
  document.getElementById('bounceMusicVol').addEventListener('input', (e) => {
    const v = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0)))
    try { localStorage.setItem(BOUNCE_MUSIC_VOL, String(v)) } catch (err) {}
    syncBounceMusicUi()
    window.__TAURI__.event.emit('pet:music-volume', { volume: v }).catch(() => {})
  })
  document.getElementById('milkTeaBtn').onclick = offerDrink
  bindDev()
}

let streamEl = null
let streamBase = ''

function streamText(text) {
  if (!streamEl) {
    streamEl = document.createElement('div')
    streamEl.className = 'msg assistant'
    document.getElementById('chatLog').appendChild(streamEl)
    hideChatEmpty()
  }
  streamEl.textContent = text
  scrollChat()
}

function commitAssistant(reply, action) {
  // 如果正在流式输出，直接在该气泡上追加动作标签
  let el = streamEl
  streamEl = null
  if (!el) {
    el = document.createElement('div')
    el.className = 'msg assistant'
    document.getElementById('chatLog').appendChild(el)
  }
  el.textContent = reply
  const item = pool.find((i) => i.id === action)
  if (item && item.label) {
    const tag = document.createElement('span')
    tag.className = 'act-tag'
    tag.textContent = '动作 · ' + (item.label || action)
    el.appendChild(tag)
  }
  hideChatEmpty()
  scrollChat()
  setBusy(false)
}

function appendMsg(role, text) {
  const el = document.createElement('div')
  el.className = 'msg ' + role
  el.textContent = text
  document.getElementById('chatLog').appendChild(el)
  hideChatEmpty()
  scrollChat()
}

function hideChatEmpty() {
  const e = document.getElementById('chatEmpty')
  if (e) e.style.display = 'none'
}

function scrollChat() {
  const log = document.getElementById('chatLog')
  log.scrollTop = log.scrollHeight
}

function setBusy(busy) {
  const btn = document.getElementById('chatSend')
  btn.disabled = busy
  btn.textContent = busy ? '…' : '发送'
}

function sendChat() {
  const input = document.getElementById('chatInput')
  const text = input.value.trim()
  if (!text || document.getElementById('chatSend').disabled) return
  input.value = ''
  appendMsg('user', text)
  setBusy(true)
  invoke('chat_send', { text, character: activeChar }).catch((e) => {
    appendMsg('assistant', '⚠ ' + String(e))
    setBusy(false)
  })
}

async function loadChatHistory() {
  const log = document.getElementById('chatLog')
  log.querySelectorAll('.msg').forEach((m) => m.remove())
  const empty = document.getElementById('chatEmpty')
  if (empty) empty.style.display = ''
  try {
    const res = await invoke('chat_history', { character: activeChar })
    for (const m of res.messages || []) {
      if (m.role === 'user' || m.role === 'assistant') {
        appendMsg(m.role === 'user' ? 'user' : 'assistant', m.content)
      }
    }
  } catch {}
  // 拉取好感度
  try {
    const st = await invoke('affection_status', { character: activeChar })
    updateAffinityBadge(st)
  } catch {}
}

function updateAffinityBadge(status) {
  const badge = document.getElementById('affinityBadge')
  if (!badge) return
  if (!status) {
    badge.textContent = '好感 0'
    return
  }
  const score = typeof status.score === 'number' ? status.score : null
  if (score == null) return
  const label = status.label || ''
  badge.textContent = '好感 ' + score + (label ? ' · ' + label : '')
}

async function clearMemory() {
  await invoke('chat_clear', { character: activeChar }).catch(() => {})
  loadChatHistory()
  showBubble('记忆已清除，重新开始吧。', 3000)
  closeSettings()
}

// ————————————————————————— 设置 —————————————————————————

function openSettings() {
  refreshSettings()
  document.getElementById('settingsView').classList.add('open')
}

function closeSettings() {
  document.getElementById('settingsView').classList.remove('open')
}

const BOUNCE_MUSIC_VOL = 'duo.bounceMusicVol'

function bounceMusicPercent() {
  try {
    const raw = localStorage.getItem(BOUNCE_MUSIC_VOL)
    const n = raw == null || raw === '' ? 70 : Number(raw)
    if (!isFinite(n)) return 70
    return Math.min(100, Math.max(0, Math.round(n)))
  } catch (e) {
    return 70
  }
}

function syncBounceMusicUi() {
  const el = document.getElementById('bounceMusicVol')
  const label = document.getElementById('bounceMusicVolVal')
  if (!el) return
  const v = bounceMusicPercent()
  el.value = String(v)
  if (label) label.textContent = String(v)
}

/** 预览和桌面窗用同一套相位（Date.now），按钮管开关，滑动条管倍速。 */
function syncBounceSpeedUi() {
  const el = document.getElementById('bounceSpeed')
  const label = document.getElementById('bounceSpeedVal')
  if (!el || !window.PetBounce) return
  const s = PetBounce.speed()
  el.value = String(s)
  if (label) label.textContent = s.toFixed(2) + '×'
}

function bindBounce() {
  if (!window.PetBounce) return
  PetBounce.bind(() => ({
    els: layers,
    originY: groundRatio,
    onStop: () => placeAllLayers(),
  }))
  PetBounce.setEnabled(PetBounce.saved())
  syncBounceChip()
  syncBounceSpeedUi()
}

function syncBounceChip() {
  const btn = document.getElementById('bounceChip')
  if (btn && window.PetBounce) btn.classList.toggle('active', PetBounce.enabled())
}

function refreshSettings() {
  document.getElementById('setAutostart').checked = !!cfg.autostart
  document.getElementById('setWebSearch').checked = !!cfg.webSearch
  document.getElementById('setFullscreenHide').checked = cfg.fullscreenHide !== false
  document.getElementById('gravityChip').classList.toggle('active', !!cfg.gravity)
  document.getElementById('snapChip').classList.toggle('active', !!cfg.snap)
  syncSizeButtons()
  syncBounceChip()
  syncBounceSpeedUi()
  syncBounceMusicUi()
  refreshTtsRow()
}

// 语音开关只对有官方声线的角色出现。林德维恩的原声是官方版权素材，
// 既不能合成，也不能换个声线冒充，所以这一行对她整行收起。
function charMeta(id) {
  return characters.find((c) => c.id === id) || null
}

function refreshTtsRow() {
  const meta = charMeta(activeChar)
  const hasVoice = !meta || meta.voice !== false
  const row = document.getElementById('ttsRow')
  const box = document.getElementById('setTts')
  const desc = document.getElementById('ttsDesc')
  if (!row || !box || !desc) return
  row.classList.toggle('is-hidden', !hasVoice)
  if (!hasVoice) {
    box.checked = false
    desc.textContent = '该角色没有可用的官方声线，仅以文字陪伴'
    return
  }
  box.checked = cfg.tts !== false
  desc.textContent = 'AI 回复时用语音朗读台词'
}

function toggleGravity(on) {
  if (on && cfg.snap) {
    cfg.snap = false
    invoke('save_cfg', { patch: { snap: false, gravity: true } })
      .then(() => invoke('pet_physics'))
      .catch(() => {})
  } else {
    invoke('save_cfg', { patch: { gravity: on } })
      .then(() => invoke('pet_physics'))
      .catch(() => {})
  }
  cfg.gravity = on
  refreshSettings()
}

function toggleSnap(on) {
  if (on) {
    cfg.gravity = false
    invoke('save_cfg', { patch: { snap: true, gravity: false } })
      .then(() => invoke('pet_physics'))
      .catch(() => {})
  } else {
    invoke('save_cfg', { patch: { snap: false } })
      .then(() => invoke('pet_physics'))
      .catch(() => {})
  }
  cfg.snap = on
  refreshSettings()
}

// ————————————————————————— 饮品互动 —————————————————————————

/** 饮品按钮：只有该角色有饮品动作时才出现，名称跟角色走（蕾文/Suki 是奶茶，林德维恩是茶饮）。 */
function refreshDrinkButton() {
  const btn = document.getElementById('milkTeaBtn')
  if (!btn) return
  const meta = characters.find((c) => c.id === activeChar) || {}
  const actions = meta.drinkActions || []
  const hasAction =
    actions.some((id) => pool.some((i) => i.id === id)) || pool.some((i) => i.drink === true)
  const label = meta.drinkLabel || '茶饮'
  btn.style.display = hasAction ? '' : 'none'
  // 各角色的饮品名字和图标都不一样：蕾文/Suki 奶茶、林德维恩茶饮、阿哈气泡饮料
  const emoji = { 奶茶: '🧋', 茶饮: '🍵', 气泡饮料: '🥤' }[label] || '🥤'
  btn.textContent = `${emoji} 请喝${label}`
  btn.dataset.drink = label
}

async function offerDrink() {
  const res = await invoke('drink_milk_tea', { character: activeChar }).catch(() => null)
  if (!res) return
  if (!res.ok) {
    if (res.reason === 'no_drink_action') return
    const label = document.getElementById('milkTeaBtn').dataset.drink || '茶饮'
    showBubble(`今天的${label}已经喝够啦，明天再来吧～`, 4000)
    return
  }
  if (res.action) playOneshot(res.action, 'stand')
  invoke('milk_tea_reply', { character: activeChar }).catch(() => {})
}

// ————————————————————————— 语音 —————————————————————————

function playTts(payload) {
  if (!payload || !payload.base64) return
  stopTts()
  try {
    const binary = atob(payload.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    ttsUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mime || 'audio/mpeg' }))
    ttsAudio = new Audio(ttsUrl)
    ttsAudio.volume = 0.92
    ttsAudio.onended = stopTts
    const ack = () => { if (payload.generation) invoke('tts_ack', { generation: payload.generation }).catch(() => {}) }
    ttsAudio.play().then(ack).catch(ack)
  } catch { stopTts() }
}

function stopTts() {
  if (ttsAudio) {
    ttsAudio.onended = null
    ttsAudio.pause()
    ttsAudio = null
  }
  if (ttsUrl) {
    URL.revokeObjectURL(ttsUrl)
    ttsUrl = null
  }
}

// ————————————————————————— 开发者模式（调参） —————————————————————————

/*
 * 参数语义（与单体桌宠 role2 / role7 完全一致）：
 *   scale   这一层在容器里的相对大小，1 = 铺满。桌面窗 base = 窗口边长，预览 base = petSize。
 *   offset  这个动作的"接触线"补偿，正数往下。它决定窗口落在哪 ——
 *           桌面窗那边按视频矩形算接触点，offset 加进去后窗口跟着让位，
 *           所以画面位置不动、窗口框动。**别在预览里再平移一次**，否则两边对不上。
 *   bubble  气泡整体下移的 px，走 CSS 变量 --bubble-offset。
 *   snap    坐姿吸附到任务栏/窗口上沿时的落脚点微调，按 角色 × 坐姿 × 三档尺寸 存在 config.json。
 */

const DEV_STORE = 'duo.dev.v1'
const BUBBLE_STORE = 'duo.bubble.v1'
/** 尺寸档 → 物理边长，和后端 size_physical 一一对应 */
const DEV_SIZES = { small: 256, medium: 384, large: 512 }

/** 尺寸档 → 相对中档的视觉比例（预览用；桌面窗是直接换物理像素） */
const TIER_RATIO = { small: 256 / 384, medium: 1, large: 512 / 384 }

const DEV_GROUPS = [
  { key: 'stand', label: '站姿' },
  { key: 'sit_upright', label: '正坐' },
  { key: 'sit_side', label: '侧坐' },
  { key: 'sit_duck', label: '鸭子坐' },
  { key: 'trans', label: '过渡' },
  { key: 'other', label: '一次性 / 其它' },
]

let devOpen = false
let devSelectedId = null
let devSize = 'medium'
/** 当前角色的落脚点表：{ stand:[小,中,大], upright:[...], side:[...], duck:[...] } */
let devSnap = {
  stand: [0, 0, 0],
  upright: [0, 0, 0],
  side: [0, 0, 0],
  duck: [0, 0, 0],
}
/** 覆盖表：{ 角色: { 动作id: { scale, offset } } } —— 动作 id 在角色之间会重名 */
let devOverrides = {}
let bubbleOffset = 0

/** 落脚点微调的四行：姿态键 / 中文名 / range 输入框 id（数字框 = id + 'Num'） */
const SNAP_KINDS = [
  ['stand', '站姿', 'devSnapStand'],
  ['upright', '正坐', 'devSnapUpright'],
  ['side', '侧坐', 'devSnapSide'],
  ['duck', '鸭子坐', 'devSnapDuck'],
]

/** 把后端返回（或 cfg 里）的 snapOffsets 归一化成四键数组表 */
function readSnapFrom(set) {
  const pick = (key) => {
    const arr = set && set[key]
    if (!Array.isArray(arr) || arr.length < 3) return [0, 0, 0]
    return arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
  }
  return {
    stand: pick('stand'),
    upright: pick('upright'),
    side: pick('side'),
    duck: pick('duck'),
  }
}

function loadDevState() {
  try {
    const raw = localStorage.getItem(DEV_STORE)
    const parsed = raw ? JSON.parse(raw) : {}
    devOverrides = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    devOverrides = {}
  }
  try {
    const raw = localStorage.getItem(BUBBLE_STORE)
    const n = raw == null ? NaN : Number(raw)
    if (Number.isFinite(n)) bubbleOffset = Math.round(n)
  } catch {}
}

function saveDevState() {
  try {
    localStorage.setItem(DEV_STORE, JSON.stringify(devOverrides))
  } catch {}
}

function factoryScale(item) {
  return item && typeof item.scale === 'number' ? item.scale : 1
}

function factoryOffset(item) {
  return item && typeof item.offset === 'number' ? item.offset : 0
}

function devTable(charId = activeChar) {
  if (!devOverrides[charId]) devOverrides[charId] = {}
  return devOverrides[charId]
}

function scaleOf(item) {
  if (!item) return 1
  const o = devTable()[item.id]
  return o && typeof o.scale === 'number' ? o.scale : factoryScale(item)
}

function offsetOf(item) {
  if (!item) return 0
  const o = devTable()[item.id]
  return o && typeof o.offset === 'number' ? o.offset : factoryOffset(item)
}

function isTuned(id) {
  const o = devTable()[id]
  return !!o && (typeof o.scale === 'number' || typeof o.offset === 'number')
}

/** 覆盖值写回/擦除：和 manifest 出厂值一致就删掉记录，不留噪音 */
function writeDevValue(id, patch) {
  const item = pool.find((x) => x.id === id)
  if (!item) return
  const table = devTable()
  const cur = table[id] || { scale: factoryScale(item), offset: factoryOffset(item) }
  const next = { ...cur, ...patch }
  const same =
    Math.abs(next.scale - factoryScale(item)) < 1e-4 &&
    Math.abs(next.offset - factoryOffset(item)) < 1e-4
  if (same) delete table[id]
  else table[id] = next
  saveDevState()
  if (layerActionId[0] === id) placeLayer(0)
  if (layerActionId[1] === id) placeLayer(1)
  // 拖滑杆时只切 class，不重建列表，否则 chip 会在拖动中消失
  markDevChips()
  broadcastDev()
}

/** 把当前角色的覆盖表 + 气泡值推给桌面窗（它自己按角色判断要不要吃） */
function broadcastDev() {
  window.__TAURI__.event
    .emit('pet:dev', {
      character: activeChar,
      overrides: devTable(),
      bubbleOffset,
    })
    .catch(() => {})
}

function applyBubbleOffset(value, persist = true) {
  bubbleOffset = Math.round(Math.min(400, Math.max(-100, Number(value) || 0)))
  document.documentElement.style.setProperty('--bubble-offset', bubbleOffset + 'px')
  if (persist) {
    try {
      localStorage.setItem(BUBBLE_STORE, String(bubbleOffset))
    } catch {}
  }
  const input = document.getElementById('devBubble')
  if (input && document.activeElement !== input) input.value = String(bubbleOffset)
  writeControl('devBubbleNum', bubbleOffset)
}

function devGroupOf(item) {
  if (item.transition) return 'trans'
  // 只有**循环待机**才按姿态归类：主界面「待机动画」里展示的就是这几条。
  // 坐姿的一次性动作（敲键盘、补妆、凭空坐下…）是 oneshot，归到「一次性 / 其它」，
  // 否则正坐分组里会混进一堆只播一次的动作，和主界面列表对不上。
  if (item.loop !== true) return 'other'
  if (item.posture === 'sit') {
    if (item.sitKind === 'side') return 'sit_side'
    if (item.sitKind === 'duck') return 'sit_duck'
    return 'sit_upright'
  }
  return 'stand'
}

/** 这个角色有哪些姿态（决定哪几行落脚点滑杆要显示；站姿永远有） */
function devSitKinds() {
  const kinds = new Set(['stand'])
  for (const item of pool) {
    if (item.loop === true && item.posture === 'sit') {
      kinds.add(item.sitKind === 'side' ? 'side' : item.sitKind === 'duck' ? 'duck' : 'upright')
    }
  }
  if (kinds.size === 1) kinds.add('upright')
  return kinds
}

/** 从后端配置同步尺寸档和落脚点表（切角色 / 打开面板时调用） */
function refreshDevFromCfg() {
  if (!cfg) return
  devSize = DEV_SIZES[cfg.size] ? cfg.size : 'medium'
  devSnap = readSnapFrom(cfg.snapOffsets && cfg.snapOffsets[activeChar])
}

function openDev() {
  refreshDevFromCfg()
  devOpen = true
  document.getElementById('devView').classList.add('open')
  document.body.classList.add('show-pet-frame')
  // 档位可能和上次打开时不同（比如退出时是别的档），先按当前档重算预览基准
  layoutStage()
  document.getElementById('devCharTag').textContent = (charMeta(activeChar) || {}).name || activeChar
  renderDev(true)
  applyBubbleOffset(bubbleOffset, false)
  syncDevValues()
  broadcastDev()
  placeAllLayers()
  const start = current && current.id ? current.id : idles[0] && idles[0].id
  if (start) selectDev(start, { preview: false })
  document.getElementById('devTip').textContent = suspended
    ? '全屏静默中：桌面角色已隐藏、预览也暂停，先把游戏退出全屏再调'
    : '点动作试播；拖滑杆实时生效，数值自动记住 · Ctrl+Shift+D 开关本面板'
}

function closeDev() {
  devOpen = false
  document.getElementById('devView').classList.remove('open')
  document.body.classList.remove('show-pet-frame')
}

function renderDev(force = false) {
  const list = document.getElementById('devList')
  if (!list) return
  const sig = activeChar + '|' + pool.map((i) => i.id).join(',')
  if (force || list.dataset.sig !== sig) {
    list.dataset.sig = sig
    list.innerHTML = DEV_GROUPS.map((group) => {
      const items = pool.filter((i) => devGroupOf(i) === group.key)
      if (!items.length) return ''
      return `<div class="dev-group">
        <div class="dev-group-title">${group.label}<span>${items.length}</span></div>
        <div class="dev-chips">${items
          .map(
            (i) =>
              `<button type="button" class="dev-chip${devSelectedId === i.id ? ' on' : ''}${
                isTuned(i.id) ? ' tuned' : ''
              }" data-dev-id="${i.id}">${i.label || i.id}</button>`
          )
          .join('')}</div>
      </div>`
    }).join('')
  }
  markDevChips()
}

function markDevChips() {
  document.querySelectorAll('#devList [data-dev-id]').forEach((btn) => {
    const id = btn.dataset.devId
    btn.classList.toggle('on', id === devSelectedId)
    btn.classList.toggle('tuned', isTuned(id))
  })
}

function selectDev(id, opts = {}) {
  const item = pool.find((i) => i.id === id)
  if (!item) return
  devSelectedId = id
  markDevChips()
  document.getElementById('devSelectedLabel').textContent = item.label || item.id
  syncDevValues()
  if (opts.preview === false) return
  // 预览 + 同步到桌面窗：桌面那边会按自己的状态机走过渡
  play(id, { force: true }).catch(() => {})
  document.getElementById('devTip').textContent = suspended
    ? `「${item.label || item.id}」暂时播不了（全屏静默中），数值照样会保存`
    : `正在试播「${item.label || item.id}」`
}

/** 把滑杆、读数、尺寸档按钮刷成当前值；force = 连正在编辑的输入框也一起覆盖 */
function syncDevValues(force = false) {
  const item = devSelectedId ? pool.find((i) => i.id === devSelectedId) : null

  const scaleVal = item ? scaleOf(item) : 1
  writeControl('devScale', scaleVal, true)
  writeControl('devScaleNum', Number(scaleVal).toFixed(3), force)

  const offVal = item ? offsetOf(item) : 0
  writeControl('devOffset', offVal, true)
  writeControl('devOffsetNum', Number(offVal).toFixed(1), force)

  const note = document.getElementById('devOffsetNote')
  if (note) note.textContent = devOffsetNote(item)

  applyBubbleOffset(bubbleOffset, false)

  const kinds = devSitKinds()
  const idx = snapIndex()
  for (const [kind, , id] of SNAP_KINDS) {
    const row = document.querySelector(`[data-dev-kind="${kind}"]`)
    if (row) row.classList.toggle('is-off', !kinds.has(kind))
    const value = devSnap[kind][idx]
    writeControl(id, value, true)
    writeControl(id + 'Num', value, force)
  }

  syncSizeButtons()
}

function syncSizeButtons() {
  document.querySelectorAll('[data-dev-size]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.devSize === devSize)
  })
  const desc = document.getElementById('petSizeDesc')
  if (desc) desc.textContent = `当前 ${sizeLabel(devSize)}。换档同时改变桌面窗口大小`
}

/** 写控件值：正在编辑的那个不覆盖，否则打字会被自己刷掉 */
function writeControl(id, value, force = false) {
  const el = document.getElementById(id)
  if (!el) return
  if (!force && document.activeElement === el) return
  const s = String(value)
  if (el.value !== s) el.value = s
}

function snapIndex() {
  return devSize === 'small' ? 0 : devSize === 'large' ? 2 : 1
}

/** 当前姿态在当前档位的落脚点微调（逻辑像素，正数往下） */
function snapShiftLogical(g) {
  const arr = devSnap[g || 'stand']
  if (!Array.isArray(arr)) return 0
  return Number(arr[snapIndex()] || 0)
}

/**
 * 落脚点微调在预览里的像素量。
 *
 * 桌面窗里这个值是「逻辑像素 = 窗口内的 CSS 像素」，窗口边长 = 档位物理边长 / dpr；
 * 预览里扮演窗口的是 petSize。按比例换算，换档前后预览和桌面的下沉比例一致。
 */
function snapShiftPreview() {
  const logical = snapShiftLogical(granular)
  if (!logical) return 0
  const dpr = window.devicePixelRatio || 1
  const winCss = (DEV_SIZES[devSize] || 512) / dpr
  return logical * (petSize / winCss)
}

/**
 * 偏移读数：接触线 = 窗口内视频的 (H-h)/2 + groundRatio*h + offset。
 * 站姿和坐姿的接触线差得越少，坐下/站起时窗口越不跳 —— 这就是这个参数的用法。
 */
function devOffsetNote(item) {
  if (!item) return '偏移只改这个动作的接触线（窗口落点），不改画面位置'
  const dpr = window.devicePixelRatio || 1
  const H = (DEV_SIZES[devSize] || 512) / dpr
  const contactOf = (it) => {
    const px = H * scaleOf(it)
    return (H - px) / 2 + groundRatio * px + offsetOf(it)
  }
  const mine = contactOf(item)
  const ref = pool.find((i) => i.loop === true && devGroupOf(i) === 'stand') || pool[0]
  if (!ref || ref.id === item.id) {
    return `接触线 ${mine.toFixed(1)}px（窗口 ${H.toFixed(0)}px）`
  }
  const delta = mine - contactOf(ref)
  const flag = Math.abs(delta) > 2 ? '⚠ ' : ''
  return `${flag}接触线 ${mine.toFixed(1)}px · 站姿基准 ${contactOf(ref).toFixed(1)}px · 差 ${
    delta > 0 ? '+' : ''
  }${delta.toFixed(1)}px`
}

function onDevScale(opts = {}) {
  const id = devSelectedId
  if (!id) return
  const src = document.getElementById(opts.fromNum ? 'devScaleNum' : 'devScale')
  const raw = src ? Number(src.value) : NaN
  if (!Number.isFinite(raw)) return
  const value = Math.round(Math.min(1.2, Math.max(0.5, raw)) * 1000) / 1000
  writeControl('devScale', value, true)
  writeControl('devScaleNum', value.toFixed(3), opts.force)
  writeDevValue(id, { scale: value })
  const note = document.getElementById('devOffsetNote')
  if (note) note.textContent = devOffsetNote(pool.find((i) => i.id === id))
}

function onDevOffsetValue(opts = {}) {
  const id = devSelectedId
  if (!id) return
  const src = document.getElementById(opts.fromNum ? 'devOffsetNum' : 'devOffset')
  const raw = src ? Number(src.value) : NaN
  if (!Number.isFinite(raw)) return
  const value = Math.round(Math.min(200, Math.max(-200, raw)) * 10) / 10
  writeControl('devOffset', value, true)
  writeControl('devOffsetNum', value.toFixed(1), opts.force)
  writeDevValue(id, { offset: value })
  const note = document.getElementById('devOffsetNote')
  if (note) note.textContent = devOffsetNote(pool.find((i) => i.id === id))
}

function onDevSnap(kind, opts = {}) {
  const row = SNAP_KINDS.find((r) => r[0] === kind)
  if (!row) return
  const id = row[2]
  const src = document.getElementById(opts.fromNum ? id + 'Num' : id)
  const raw = src ? Number(src.value) : NaN
  if (!Number.isFinite(raw)) return
  // 滑杆范围 ±150，输入框允许到 ±300（和 Rust 端 SNAP_LIMIT 一致）
  const value = Math.round(Math.min(300, Math.max(-300, raw)))
  writeControl(id, value, true)
  writeControl(id + 'Num', value, opts.force)
  devSnap[kind][snapIndex()] = value
  // 预览按当前姿态的下沉量重摆一遍，拖滑杆时能直接看见脚在动
  placeAllLayers()
  invoke('set_snap_offset', { kind, size: devSize, value, character: activeChar })
    .then((res) => {
      if (!res || !res.snapOffsets) return
      devSnap = readSnapFrom(res.snapOffsets)
      // cfg 也要跟着更新：切角色/重开面板都从 cfg 读，不更新就会拿回旧值
      if (cfg) {
        cfg.snapOffsets = cfg.snapOffsets || {}
        cfg.snapOffsets[res.character || activeChar] = res.snapOffsets
      }
    })
    .catch((e) => console.warn('[duo] set_snap_offset 失败', e))
  document.getElementById('devTip').textContent = `${row[1]}落脚点已写入 config.json（${
    value > 0 ? '+' : ''
  }${value}px · ${sizeLabel(devSize)}）`
}

/** 尺寸档 → 「小 256」这种给提示文案用的标签 */
function sizeLabel(key) {
  const px = DEV_SIZES[key]
  const name = { small: '小', medium: '中', large: '大' }[key]
  return px ? `${name} ${px}` : key
}

function onDevSize(sizeKey) {
  if (!DEV_SIZES[sizeKey]) return
  invoke('set_pet_size', { size: sizeKey })
    .then((res) => {
      const ok = !res || res.ok !== false
      if (cfg) cfg.size = sizeKey
      devSize = sizeKey
      // 预览基准跟着档位变，否则换档在预览里完全看不出来
      layoutStage()
      placeAllLayers()
      syncDevValues()
      const tip = document.getElementById('devTip')
      const text = ok
        ? `桌面窗已切到 ${sizeLabel(sizeKey)}`
        : '桌面窗切换失败：找不到桌面角色窗口，请重开桌宠再试'
      if (tip) tip.textContent = text
      const desc = document.getElementById('petSizeDesc')
      if (desc) desc.textContent = text
    })
    .catch((e) => {
      console.warn('[duo] set_pet_size 失败', e)
      const text = '桌面窗切换失败：' + String(e)
      const tip = document.getElementById('devTip')
      if (tip) tip.textContent = text
      const desc = document.getElementById('petSizeDesc')
      if (desc) desc.textContent = text
    })
}

function resetDevAction() {
  const id = devSelectedId
  if (!id) return
  delete devTable()[id]
  saveDevState()
  if (layerActionId[0] === id) placeLayer(0)
  if (layerActionId[1] === id) placeLayer(1)
  broadcastDev()
  syncDevValues(true)
  markDevChips()
  document.getElementById('devTip').textContent = '已把这个动作的 scale/offset 复位成 manifest 出厂值'
}

function resetDevAll() {
  devOverrides[activeChar] = {}
  saveDevState()
  for (let i = 0; i < layers.length; i++) placeLayer(i)
  broadcastDev()
  syncDevValues(true)
  markDevChips()
  document.getElementById('devTip').textContent = '已清空当前角色的全部覆盖；落脚点与气泡不受影响'
}

function devOverridesJson() {
  const actions = {}
  for (const item of pool) {
    actions[item.id] = {
      scale: Math.round(scaleOf(item) * 1000) / 1000,
      offset: Math.round(offsetOf(item) * 10) / 10,
    }
  }
  const round = (arr) => arr.map((v) => Math.round(v * 10) / 10)
  return JSON.stringify(
    {
      character: activeChar,
      actions,
      snapOffsets: {
        stand: round(devSnap.stand),
        upright: round(devSnap.upright),
        side: round(devSnap.side),
        duck: round(devSnap.duck),
      },
      bubbleOffset,
    },
    null,
    2
  )
}

function copyDevOverrides() {
  const text = devOverridesJson()
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {})
    }
  } catch {}
  console.log('[duo] 全部动作调参值:\n' + text)
  document.getElementById('devTip').textContent = `已生成 ${pool.length} 个动作的 scale/offset（已尝试复制，也打印在控制台）`
}

/** 数字框：input 防抖 220ms 生效，change（回车/失焦）立即生效并回写规范化值 */
function bindNumberInput(id, handler) {
  const el = document.getElementById(id)
  if (!el) return
  let timer = null
  el.addEventListener('input', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      handler({ fromNum: true })
    }, 220)
  })
  el.addEventListener('change', () => {
    if (timer) clearTimeout(timer)
    timer = null
    handler({ fromNum: true, force: true })
  })
  // 回车不提交任何东西，只是让 change 立刻发生，手感更利落
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      el.blur()
    }
  })
}

function bindDev() {
  document.getElementById('devClose').onclick = closeDev
  document.getElementById('devView').addEventListener('click', (e) => {
    if (e.target.id === 'devView') closeDev()
  })
  document.getElementById('devList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dev-id]')
    if (btn) selectDev(btn.dataset.devId)
  })
  document.querySelectorAll('[data-dev-size]').forEach((btn) => {
    btn.onclick = () => onDevSize(btn.dataset.devSize)
  })
  // ——— 滑杆：拖动手感 ———
  document.getElementById('devScale').addEventListener('input', () => onDevScale())
  document.getElementById('devOffset').addEventListener('input', () => onDevOffsetValue())
  document.getElementById('devBubble').addEventListener('input', (e) => {
    applyBubbleOffset(Number(e.target.value))
    broadcastDev()
  })
  for (const [kind, , id] of SNAP_KINDS) {
    const rangeEl = document.getElementById(id)
    if (rangeEl) rangeEl.addEventListener('input', () => onDevSnap(kind))
  }

  // ——— 数字框：直接打字要一个准确值 ———
  // input 防抖（边打边生效），change 兜底并回写规范化后的值（打完回车/失焦时对齐）
  bindNumberInput('devScaleNum', (opts) => onDevScale(opts))
  bindNumberInput('devOffsetNum', (opts) => onDevOffsetValue(opts))
  bindNumberInput('devBubbleNum', (opts) => {
    applyBubbleOffset(Number(document.getElementById('devBubbleNum').value))
    broadcastDev()
    if (opts && opts.force) writeControl('devBubbleNum', bubbleOffset, true)
  })
  for (const [kind, , id] of SNAP_KINDS) {
    bindNumberInput(id + 'Num', (opts) => onDevSnap(kind, opts))
  }

  document.getElementById('devReset').onclick = resetDevAction
  document.getElementById('devAll').onclick = resetDevAll
  document.getElementById('devCopy').onclick = copyDevOverrides

  window.addEventListener('keydown', (e) => {
    // Ctrl+Shift+D 开关（Escape 只在面板打开时关它）
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault()
      devOpen ? closeDev() : openDev()
      return
    }
    if (e.key === 'Escape' && devOpen) closeDev()
  })
}

// ————————————————————————— 气泡 / 提示 —————————————————————————

function showBubble(text, ms = 4500) {
  const el = document.getElementById('bubble')
  if (!el || !text) return
  el.textContent = text
  el.classList.add('show')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    el.classList.remove('show')
    bubbleTimer = null
  }, ms)
}

function showHint() {
  const h = document.getElementById('stageHint')
  setTimeout(() => h.classList.add('fade'), 6000)
}

window.addEventListener('resize', () => layoutStage())

boot().catch((e) => reportError('boot', e))
