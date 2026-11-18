/**
 * 桌面漂浮角色窗口前端（Tauri 2）
 *
 * 职责：把主窗口（预览）广播的目标动作，在自己这边**走完整状态机**播放。
 *  · 姿态切换必须播完过渡动画（trans_*），再进入目标待机/一次性动作
 *  · 双击/拖动：按住拖动移动窗口；单击触发摸摸互动
 *  · 拖动结束按设置应用重力 / 吸附
 */

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

/** 弹弹配乐。启动就循环，默认静音；只有弹弹开着才出声。音量是 0–100，记在 localStorage。 */
const BOUNCE_MUSIC = 'assets/music/bounce.flac'
const BOUNCE_MUSIC_VOL = 'duo.bounceMusicVol'
let musicHeld = false
// shixiaoyu

function bounceMusicLevel() {
  try {
    const raw = localStorage.getItem(BOUNCE_MUSIC_VOL)
    const n = raw == null || raw === '' ? 70 : Number(raw)
    if (!isFinite(n)) return 0.7
    return Math.min(100, Math.max(0, n)) / 100
  } catch (e) {
    return 0.7
  }
}

function syncBounceMusic() {
  const audio = document.getElementById('bounceMusic')
  if (!audio) return
  audio.volume = bounceMusicLevel()
  audio.muted = musicHeld || !(window.PetBounce && PetBounce.enabled())
  if (audio.paused) {
    const p = audio.play()
    if (p && p.catch) p.catch((e) => reportError('music', e))
  }
}

function startBounceMusic() {
  const audio = document.getElementById('bounceMusic')
  if (!audio) return
  audio.loop = true
  audio.preload = 'auto'
  audio.src = BOUNCE_MUSIC
  audio.addEventListener('error', () => {
    const err = audio.error
    console.warn('[pet] 音乐加载失败', err && err.code, audio.src)
  })
  audio.addEventListener('canplay', () => syncBounceMusic())
  syncBounceMusic()
}

let character = null
let pool = []
let layers = []
let frontIdx = 0
/** 每层的代次。预加载或新播放会加一，过期的释放/解码不再动这一层。 */
const layerToken = [0, 0]
let current = null
let granular = 'stand'
let stateToken = 0
const idleByGranular = {}
/** 角色接地线在画面中的比例（manifest.groundRatio），吸附与下落靠它对齐 */
let groundRatio = 0.861

let bubbleTimer = null

/**
 * 调参覆盖值（由主窗口的开发者面板广播过来，也存在 localStorage 里）。
 * 结构 { 角色: { 动作id: { scale, offset } } } —— 动作 id 在角色之间会重名，必须按角色分表。
 * 主窗和桌面窗同源（tauri.localhost），所以启动时可以直接读同一份 localStorage，
 * 不用赌「主窗先发广播、桌面窗先启动」的时序。
 */
const DEV_STORE = 'duo.dev.v1'
const BUBBLE_STORE = 'duo.bubble.v1'
let devOverrides = {}
let bubbleOffset = 0
/** 每层当前承载的动作，调 scale 时要按动作查表 */
const layerItem = [null, null]

// 诊断标记（便于排查拖动/点击问题）
window.__petDiag = { dragStart: 0, dragErr: null, clicks: 0, pointerDown: 0, moves: 0 }

/**
 * 全屏静默：检测到用户在玩全屏游戏/看全屏视频时，Rust 会把窗口藏起来，
 * 并广播 `pet:fullscreen`。这边要做的是**真正把解码器还回去** ——
 * 只 pause() 不解码器，显存还是占着的；必须 removeAttribute('src') + load()，
 * 让浏览器回收那一套 768×768 alpha 视频的解码缓冲。
 * 退出全屏时再把全屏前那个动作原样接上。
 */
let suspended = false
let resumeState = null
/** bootstrap 拿到的配置（退出全屏后要不要立刻重新贴合用得上） */
let cfg = null

function reportError(tag, err) {
  console.error('[pet]', tag, err)
}

function urlOf(item) {
  const rel = item.file.replace(/^assets\//, '')
  return 'assets/' + character + '/' + rel.split('/').map(encodeURIComponent).join('/')
}

function granularOf(item) {
  if (!item) return 'stand'
  if (item.transition) return item.transition.to
  if (item.posture !== 'sit') return 'stand'
  if (item.sitKind === 'side') return 'sit_side'
  if (item.sitKind === 'duck') return 'sit_duck'
  return 'sit_upright'
}

const transCursor = {}

/**
 * 找过渡动画。
 *
 * 两种匹配方式：
 *  1. `fromId/toId`：同姿态内部的过渡（站姿待机↔双手抱胸、坐→托腮、托腮→坐）。
 *     这几对的 granular 完全一样（都是 stand / sit_upright），只按 granular 判会直接硬切，
 *     所以必须按**动作 id** 精确匹配。
 *  2. `from/to`：跨姿态过渡（站↔坐），同一个 granular 之间不会误命中。
 *
 * 同一对端点有 A/B 两套时交替使用，避免每次切换都一模一样。
 */
function findTransition(from, to, fromId, toId) {
  const matches = pool.filter((i) => {
    const t = i.transition
    if (!t) return false
    if (t.fromId || t.toId) {
      if (t.fromId && t.fromId !== fromId) return false
      if (t.toId && t.toId !== toId) return false
      return true
    }
    return t.from === from && t.to === to
  })
  if (!matches.length) return null
  // 端点精确的片子优先：坐姿内部的托腮/打瞌睡/正坐待机 granular 都是 sit_upright，
  // 只写 from/to 的中性片（站→坐）也会命中，不过滤就会在「正坐→托腮」时播出「站→坐」。
  const exact = matches.filter((i) => i.transition.fromId || i.transition.toId)
  const list = exact.length ? exact : matches
  if (list.length === 1) return list[0]
  const key = fromId + ',' + toId
  const n = transCursor[key] || 0
  transCursor[key] = n + 1
  const a = list.find((i) => i.variant === 'a') || list[0]
  const b = list.find((i) => i.variant === 'b') || list[1] || list[0]
  return n % 2 === 0 ? a : b
}

function idleFor(g) {
  if (idleByGranular[g]) return idleByGranular[g]
  return (
    pool.find((i) => i.loop === true && granularOf(i) === g) ||
    pool.find((i) => i.loop === true) ||
    null
  )
}

// ————————————————————————— 调参：缩放 / 偏移 —————————————————————————

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
  applyBubbleOffset(bubbleOffset)
}

function devTable() {
  if (!character) return {}
  if (!devOverrides[character]) devOverrides[character] = {}
  return devOverrides[character]
}

function scaleOf(item) {
  if (!item) return 1
  const o = devTable()[item.id]
  if (o && typeof o.scale === 'number') return o.scale
  return typeof item.scale === 'number' ? item.scale : 1
}

function offsetOf(item) {
  if (!item) return 0
  const o = devTable()[item.id]
  if (o && typeof o.offset === 'number') return o.offset
  return typeof item.offset === 'number' ? item.offset : 0
}

function applyBubbleOffset(value) {
  const n = Math.round(Math.min(400, Math.max(-100, Number(value) || 0)))
  document.documentElement.style.setProperty('--bubble-offset', n + 'px')
}

/**
 * 按动作的 scale / offset 摆放一层视频。
 *
 * 关键语义（和主窗预览必须一致）：offset 是**视频在窗口内往下挪多少**。
 * 接触点由视频矩形算出（top + h*groundRatio），Rust 再把接触点落到任务栏/窗口上沿，
 * 窗口因此往上让 off —— 净效果是画面原地不动、窗口框动了。这就是「offset 只改落点」。
 * scale > 1 时视频会超出窗口，被窗口自身裁掉，和桌面上的真实表现一样。
 */
function applyLayerGeom(v, item) {
  if (!v) return
  const W = window.innerWidth || 384
  const H = window.innerHeight || 384
  const px = Math.max(1, W * scaleOf(item))
  const off = offsetOf(item)
  // 视频原本是 100% + 居中 translate，这里改成左上角定位，必须把 transform 关掉。
  // 弹弹开着时 transform 是挤压缩放，清掉会把这一帧打回原形。
  if (!(window.PetBounce && PetBounce.enabled())) v.style.transform = 'none'
  v.style.width = px + 'px'
  v.style.height = px + 'px'
  v.style.left = (W - px) / 2 + 'px'
  v.style.top = (H - px) / 2 + off + 'px'
}

function reapplyGeom() {
  if (suspended) return
  for (let i = 0; i < layers.length; i++) applyLayerGeom(layers[i], layerItem[i])
}

async function loadManifest(char) {
  character = char
  granular = 'stand'
  for (const k of Object.keys(transCursor)) delete transCursor[k]
  for (const k of Object.keys(idleByGranular)) delete idleByGranular[k]
  const man = await (await fetch('assets/' + char + '/manifest.json')).json()
  if (typeof man.groundRatio === 'number') groundRatio = man.groundRatio
  pool = []
  layerItem[0] = null
  layerItem[1] = null
  for (const key of Object.keys(man.pools || {})) {
    const p = man.pools[key]
    for (const it of p.items || []) {
      pool.push({ ...it, loop: it.loop != null ? it.loop : p.loop !== false })
    }
  }
  const def = idleFor('stand')
  if (def) idleByGranular.stand = def
}

// ————————————————————————— 播放核心 —————————————————————————

function waitEvent(el, name, ms = 6000) {
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

/** 新层至少画出一帧再交棒。透明度 0 时 Chromium 仍会提交帧，rVFC 能等到。 */
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

/**
 * 非循环片停在结束前约一帧。
 * 等 ended 的话 Chromium 会把 WebM 当前帧清掉，下一层还没亮时桌面就穿出来。
 */
function waitUntilHold(video, ms) {
  return new Promise((resolve) => {
    if (!video) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('ended', onEnded)
      clearTimeout(timer)
      resolve()
    }
    const onEnded = () => {
      try { video.pause() } catch (e) { reportError('hold', e) }
      finish()
    }
    const arm = () => {
      if (done) return
      const dur = video.duration
      if (dur && isFinite(dur) && dur - video.currentTime <= 1.5 / 48) {
        try { video.pause() } catch (e) { reportError('hold', e) }
        finish()
        return
      }
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(arm)
      }
    }
    const timer = setTimeout(() => {
      try { video.pause() } catch (e) { reportError('hold', e) }
      finish()
    }, Math.max(600, ms || 6000))
    if (video.ended) {
      finish()
      return
    }
    video.addEventListener('ended', onEnded, { once: true })
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(arm)
    else {
      const tick = () => {
        if (done) {
          video.removeEventListener('timeupdate', tick)
          return
        }
        const dur = video.duration
        if (dur && isFinite(dur) && dur - video.currentTime <= 1.5 / 24) {
          video.removeEventListener('timeupdate', tick)
          try { video.pause() } catch (e) { reportError('hold', e) }
          finish()
        }
      }
      video.addEventListener('timeupdate', tick)
    }
  })
}

function clearOnEnded(v) {
  if (v._onEnded) {
    v.removeEventListener('ended', v._onEnded)
    v._onEnded = null
  }
}

let playSeq = 0

function layerIndex(el) {
  return layers[0] === el ? 0 : 1
}

/** 把隐藏层解码到第 0 帧并播起来，调用方决定何时亮出来。 */
async function ensureFrame(el, item, loop, still) {
  const url = urlOf(item)
  const idx = layerIndex(el)
  layerItem[idx] = item
  applyLayerGeom(el, item)
  if (el.getAttribute('src') !== url) {
    delete el.dataset.primed
    el.src = url
    el.load()
    await waitEvent(el, 'loadeddata')
    if (!still()) return false
  }
  // 刚 load() 完本来就在 0。只有复用同一条 src 时才 seek，避免把刚解码的帧作废。
  if (el.currentTime > 0.04) {
    el.pause()
    el.currentTime = 0
    await waitEvent(el, 'seeked', 2000)
    if (!still()) return false
  }
  el.loop = loop
  clearOnEnded(el)
  try {
    await el.play()
  } catch (e) {
    reportError('play', e)
  }
  if (!still()) return false
  await waitPresented(el)
  return still()
}

/** 同一帧硬切：新层已经有画面，旧层停在最后一帧，两边都不做透明度过渡。 */
function reveal(nxt, cur) {
  nxt.style.transition = 'none'
  nxt.classList.add('on')
  if (cur && cur !== nxt) {
    cur.style.transition = 'none'
    cur.classList.remove('on')
  }
}

/** 新层已经在屏幕上之后再还解码器。代次变了说明这层已被预加载复用，不能清。 */
function releaseLater(el) {
  const idx = layerIndex(el)
  const gen = layerToken[idx]
  setTimeout(() => {
    if (layerToken[idx] !== gen) return
    if (layers[frontIdx] === el) return
    try {
      el.pause()
      clearOnEnded(el)
      el.removeAttribute('src')
      el.load()
    } catch (e) {
      reportError('release', e)
    }
    delete el.dataset.primed
    refreshMask()
    syncContact()
  }, 80)
}

/**
 * 过渡播放期间把下一条装进背后那层并停在第 0 帧。
 * 交棒时不用再等解码，旧画面也不必多停。
 */
async function prime(item) {
  if (!item || suspended) return
  const idx = 1 - frontIdx
  const el = layers[idx]
  const gen = ++layerToken[idx]
  const still = () => gen === layerToken[idx] && !suspended
  const ok = await ensureFrame(el, item, false, still)
  if (!ok) return
  el.pause()
  el.dataset.primed = item.id
}

/** 播放一个动作，返回承载它的 video 元素。 */
async function play(id, opts = {}) {
  // 全屏静默期间一律不开解码器：stateToken 已被打断，但过渡/一次性动作的
  // 收尾 await 还会回来调这里，必须在这里兜住。
  if (suspended) return null
  const item = pool.find((i) => i.id === id)
  if (!item) return null
  if (!opts.force && current && current.id === id) return null

  const seq = ++playSeq
  const cur = layers[frontIdx]
  const nxtIdx = 1 - frontIdx
  const nxt = layers[nxtIdx]
  const loop = opts.loop != null ? opts.loop : item.loop !== false
  const url = urlOf(item)
  const gen = ++layerToken[nxtIdx]
  const still = () => seq === playSeq && gen === layerToken[nxtIdx] && !suspended
  const primed = nxt.dataset.primed === item.id && nxt.getAttribute('src') === url && nxt.readyState >= 2

  if (primed) {
    layerItem[nxtIdx] = item
    applyLayerGeom(nxt, item)
    nxt.loop = loop
    clearOnEnded(nxt)
    try {
      await nxt.play()
    } catch (e) {
      reportError('play', e)
    }
    if (!still()) return null
  } else {
    const ok = await ensureFrame(nxt, item, loop, still)
    if (!ok) return null
  }

  delete nxt.dataset.primed
  reveal(nxt, cur)
  frontIdx = nxtIdx
  current = item

  if (cur !== nxt) releaseLater(cur)

  // 接地线/角色高度随动作变化，立刻同步给 Rust（吸附、下落都要用）
  syncContact()
  // 首帧可能还没稳定，再补一次掩膜采样，避免刚切完点不到
  setTimeout(() => {
    if (current === item) {
      refreshMask()
      syncContact()
    }
  }, 80)

  return nxt
}

function durationMs(item) {
  const d = typeof item.duration === 'number' && item.duration > 0 ? item.duration : 3.0
  return d * 1000 + 900
}

// ————————————————————————— 状态机 —————————————————————————

/** 切到某个循环待机：跨姿态时先播完过渡动画。 */
async function applyIdle(item, opts = {}) {
  const to = granularOf(item)
  idleByGranular[to] = item
  const token = ++stateToken
  const fromId = current ? current.id : null

  if (opts.instant) {
    granular = to
    await play(item.id, { loop: true, force: true })
    return
  }

  // 同姿态内部换待机（站姿待机↔抱胸、坐↔托腮）也有过渡，按动作 id 命中
  const trans = findTransition(granular, to, fromId, item.id)
  if (!trans) {
    granular = to
    await play(item.id, { loop: true, force: true })
    return
  }

  granular = to
  const v = await play(trans.id, { loop: false, force: true })
  if (token !== stateToken) {
    console.log('[pet] 过渡被打断')
    return
  }
  // 过渡播着的时候背后把目标待机的第 0 帧准备好，结束时同一帧切过去
  const priming = prime(item)
  if (v) await waitUntilHold(v, durationMs(trans))
  if (token !== stateToken) {
    console.log('[pet] 过渡被打断(ended)')
    return
  }
  await priming
  if (token !== stateToken) return
  await play(item.id, { loop: true, force: true })
}

/** 播一次性动作，播完回到当前姿态的循环待机。 */
async function playOneShot(item) {
  const token = ++stateToken
  const g = granularOf(item)
  const fromId = current ? current.id : null

  const trans = findTransition(granular, g, fromId, item.id)
  if (trans) {
    granular = g
    const tv = await play(trans.id, { loop: false, force: true })
    if (token !== stateToken) return
    const priming = prime(item)
    if (tv) await waitUntilHold(tv, durationMs(trans))
    if (token !== stateToken) return
    await priming
    if (token !== stateToken) return
  } else if (g !== granular) {
    granular = g
  }

  const v = await play(item.id, { loop: false, force: true })
  if (token !== stateToken) return
  // 动作可以声明自己的落点：悬浮冥想的最后一帧就是正坐姿，回托腮会肉眼可见地跳一下
  const back =
    (item.returnTo && pool.find((i) => i.id === item.returnTo)) || idleFor(granular)
  const primingBack = back ? prime(back) : null
  if (v) await waitUntilHold(v, durationMs(item))
  if (token !== stateToken) return
  if (primingBack) await primingBack
  if (token !== stateToken) return
  if (back) await play(back.id, { loop: true, force: true })
}

// ————————————————————————— 事件 —————————————————————————

async function switchCharacter(char) {
  try {
    await loadManifest(char)
    reapplyGeom()
    const def = idleFor('stand')
    if (def) await applyIdle(def, { instant: true })
  } catch (e) {
    reportError('switchCharacter', e)
  }
}

function onAction(payload) {
  const p = payload || {}
  if (p.character && p.character !== character) {
    switchCharacter(p.character)
    return
  }
  if (!p.action) return
  const item = pool.find((i) => i.id === p.action)
  if (!item) return
  if (p.loop) applyIdle(item)
  else playOneShot(item)
}

/**
 * 主窗开发者面板推过来的调参值。
 * 只吃自己这个角色的那份；吃完要重新摆层、重采掩膜、重同步接触点 ——
 * 否则点选区域还停在旧尺寸上，改完 scale 会「看着变大、点着还是原来那块」。
 */
async function onDev(payload) {
  const p = payload || {}
  if (p.character) {
    devOverrides[p.character] = p.overrides && typeof p.overrides === 'object' ? p.overrides : {}
    if (p.character !== character) return
  }
  if (typeof p.bubbleOffset === 'number') {
    bubbleOffset = Math.round(p.bubbleOffset)
    applyBubbleOffset(bubbleOffset)
  }
  reapplyGeom()
  refreshMask()
  await syncContact()
  if (cfg && (cfg.snap || cfg.gravity)) invoke('pet_physics').catch(() => {})
}

// ————————————————————————— 全屏静默 —————————————————————————

/** 真正释放两层 video 的解码器（只 pause 不释放，显存不会降下来） */
function releaseDecoders() {
  for (let i = 0; i < layers.length; i++) {
    const v = layers[i]
    layerToken[i]++
    try {
      v.pause()
      clearOnEnded(v)
      v.removeAttribute('src')
      v.load()
    } catch (e) {
      reportError('release', e)
    }
    delete v.dataset.primed
    v.classList.remove('on')
  }
  frontIdx = 0
  current = null
}

function suspendForFullscreen(title) {
  if (suspended) return
  suspended = true
  musicHeld = true
  syncBounceMusic()
  resumeState = current ? { id: current.id, loop: current.loop !== false } : null
  // 打断还没走完的过渡/一次性动作：它们的 token 全部作废
  stateToken++
  playSeq++
  if (bubbleTimer) {
    clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  const b = document.getElementById('bubble')
  if (b) b.classList.remove('show')
  releaseDecoders()
  console.log('[pet] 全屏静默，已释放视频解码', title || '')
}

async function resumeFromFullscreen() {
  if (!suspended) return
  suspended = false
  musicHeld = false
  syncBounceMusic()
  const saved = resumeState
  resumeState = null
  try {
    if (saved) {
      const item = pool.find((i) => i.id === saved.id)
      if (item) {
        granular = granularOf(item)
        // 循环待机直接续上；一次性动作重新播一遍并自己收尾回待机，
        // 否则会停在那条动作的最后一帧上不动
        if (saved.loop) await play(item.id, { loop: true, force: true })
        else await playOneShot(item)
      }
    }
    // 记录的动作在新 manifest 里找不到（极少见）→ 退回当前姿态待机
    if (!current) {
      const back = idleFor(granular) || idleFor('stand')
      if (back) await applyIdle(back, { instant: true })
    }
    await syncContact()
    setTimeout(refreshMask, 500)
    if (cfg && (cfg.snap || cfg.gravity)) invoke('pet_physics').catch(() => {})
    console.log('[pet] 退出全屏，恢复播放', current && current.id)
  } catch (e) {
    reportError('resume', e)
  }
}

// ————————————————————————— 拖动 / 点击 —————————————————————————

// 拖拽本身由 Rust 轮询线程按全局光标驱动（16ms 一帧，跟手且不占 IPC）。
// 前端只负责三件事：判定这次按下是“拖”还是“点”、开始/结束拖拽、以及喂掩膜。

let press = null

function beginRustDrag(offX, offY) {
  window.__petDiag.dragStart++
  window.__petDiag.dragOff = { x: offX, y: offY }
  invoke('pet_drag_start', { offX, offY }).catch((err) => {
    window.__petDiag.dragErr = String(err && err.message ? err.message : err)
  })
}

function endRustDrag() {
  invoke('pet_drag_end').catch((err) => {
    window.__petDiag.dragErr = String(err && err.message ? err.message : err)
  })
}

/** 各角色被摸时的动作偏好（按部位），命中不到就退回随机候选。 */
const TOUCH_KINDS = {
  aha: {
    // 站姿与坐姿共用一张表：命中不到的键会自然落到候选里的第一条。
    // 注意这里用整段 id：'sit_chair_vanish' 里含 "chair"，而 "chair" 又含 "hair"，
    // 用 'hair' 去 includes 会把「键帽崩脸」误判成撩头发。
    head: ['stand_hair', 'makeup', 'prayer', 'bow'],
    belly: ['laugh', 'balloon', 'juggle', 'air_sit', 'code_type'],
    leg: ['faceplant', 'jump', 'chair_vanish'],
  },
  lindverne: {
    head: ['hair', 'makeup'],
    belly: ['laugh', 'static', 'balloon'],
    leg: ['cross', 'faceplant', 'code_rage'],
  },
  default: {
    head: ['wipe', 'hair'],
    belly: ['giggle'],
    leg: ['angry'],
  },
}

function pickTouch(zone) {
  const table = TOUCH_KINDS[character] || TOUCH_KINDS.default
  const kinds = table[zone] || table.belly
  // 当前姿态下可用的一次性动作（排除过渡）
  const cands = pool.filter(
    (i) => i.loop === false && !i.transition && i.playable !== false && granularOf(i) === granular
  )
  const tagged = cands.filter((i) => i.trigger === 'touch')
  const src = tagged.length ? tagged : cands
  for (const k of kinds) {
    const hit = src.find((i) => i.id.includes(k))
    if (hit) return hit
  }
  return src.length ? src[0] : null
}

function onPetClick(e) {
  window.__petDiag.clicks++
  const stage = document.getElementById('stage')
  const rect = stage.getBoundingClientRect()
  const ry = (e.clientY - rect.top) / Math.max(1, rect.height)
  const zone = ry < 0.4 ? 'head' : ry < 0.7 ? 'belly' : 'leg'

  const item = pickTouch(zone)
  if (!item) return
  playOneShot(item)
  invoke('generate_touch_reply', {
    zone,
    pose: granular,
    action: item.id,
    character,
  })
    .then((res) => {
      const text = res && res.text
      if (!text) return
      // 触摸带的少量好感也在这里回显，让玩家知道点了有用
      const delta = res && Number(res.delta)
      showBubble(delta > 0 ? `${text}　(+${delta} 好感)` : text, 4200)
    })
    .catch(() => {})
}

function bindInput() {
  const stage = document.getElementById('stage')

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    window.__petDiag.pointerDown++
    const dpr = window.devicePixelRatio || 1
    // 抓取偏移（物理像素）：窗口内坐标就是光标相对窗口左上角的位置。
    // 在按下这一帧记下来，拖拽启动时直接交给 Rust，避免“阈值位移”造成的滞后。
    press = {
      x: e.clientX,
      y: e.clientY,
      offX: e.clientX * dpr,
      offY: e.clientY * dpr,
      moved: false,
      dragging: false,
      id: e.pointerId,
    }
    // 捕获指针，鼠标移出窗口后仍能收到 move / up
    try { stage.setPointerCapture(e.pointerId) } catch {}
  })

  stage.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return
    // 按键已经松开（比如 up 丢在窗口外）→ 收尾，避免“粘手”
    if (e.buttons === 0) {
      if (press.dragging) endRustDrag()
      press = null
      return
    }
    if (press.moved) return
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 4) return
    press.moved = true
    window.__petDiag.moves = (window.__petDiag.moves || 0) + 1
    press.dragging = true
    // 位置由 Rust 接管，前端不再需要 pointermove
    beginRustDrag(press.offX, press.offY)
  })

  const release = (e, allowClick) => {
    if (!press) return
    if (e && e.pointerId != null && e.pointerId !== press.id) return
    const p = press
    press = null
    try { stage.releasePointerCapture(p.id) } catch {}
    if (p.dragging) endRustDrag()
    else if (allowClick && e && e.button === 0) onPetClick(e)
  }

  stage.addEventListener('pointerup', (e) => release(e, true))
  stage.addEventListener('pointercancel', (e) => release(e, false))

  // 窗口失去焦点时兜底收尾：拖拽中途失焦不能把状态留在 Drag
  window.addEventListener('blur', () => {
    if (press && press.dragging) endRustDrag()
    press = null
  })

  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    invoke('show_main').catch((err) => reportError('show_main', err))
  })

  // 窗口尺寸/缩放变化时重新同步：档位切换（set_pet_size）也是走这条路径，
  // 视频的内联 px 是按 resize 前的 innerWidth 算的，不重摆就是「窗口变了、角色没变」。
  window.addEventListener('resize', () => {
    reapplyGeom()
    refreshMask()
    syncContact()
  })
}

// ————————————————————————— 掩膜 / 接触点（供 Rust 物理用） —————————————————————————

/** 前端掩膜分辨率，与 Rust 侧无耦合，192² 足够判定“光标在不在角色像素上” */
const MASK_N = 192
/** 角色在画面里的高度比例（站姿）。用来告诉 Rust 下落/坐边时头顶还剩多少空间 */
const CHAR_H_RATIO = 0.68

const maskCanvas = document.createElement('canvas')
maskCanvas.width = MASK_N
maskCanvas.height = MASK_N
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })

/**
 * 按需采样当前前景层的 alpha 掩膜。
 * 只在切动作、换角色、窗口尺寸变化时采一次 —— 待机摆动只有几像素，
 * 192² 掩膜下对命中判定没有影响。
 */
function refreshMask() {
  // 静默期间没有解码器可采样
  if (suspended) return
  const v = layers[frontIdx]
  if (!v || v.readyState < 2 || !v.videoWidth) return

  const W = window.innerWidth || 340
  const H = window.innerHeight || 340
  const r = v.getBoundingClientRect()
  const gw = Math.max(1, Math.round(((r.width || W) / W) * MASK_N))
  const gh = Math.max(1, Math.round(((r.height || H) / H) * MASK_N))
  const gx = Math.round((r.left / W) * MASK_N)
  const gy = Math.round((r.top / H) * MASK_N)

  maskCtx.clearRect(0, 0, MASK_N, MASK_N)
  try {
    maskCtx.drawImage(v, gx, gy, gw, gh)
  } catch (e) {
    console.warn('[pet] 掩膜采样失败', e)
    return
  }

  const data = maskCtx.getImageData(0, 0, MASK_N, MASK_N).data
  const out = new Array(MASK_N * MASK_N)
  let any = 0
  for (let i = 0; i < out.length; i++) {
    const on = data[i * 4 + 3] > 40 ? 1 : 0
    out[i] = on
    any += on
  }
  // 空白帧（刚 seek 完还没画出第一帧）别把掩膜刷成空的，否则整窗立刻穿透、点不到
  if (!any) return

  invoke('set_pet_mask', { w: MASK_N, h: MASK_N, data: out }).catch(() => {})
}

/** 把接地线 / 角色高度 / DPI 同步给 Rust，吸附与下落全靠这三个数 */
function syncContact() {
  const v = layers[frontIdx]
  const W = window.innerWidth || 340
  const H = window.innerHeight || 340
  const dpr = window.devicePixelRatio || 1

  let offY = H * groundRatio
  let charH = H * CHAR_H_RATIO
  if (v && v.getBoundingClientRect) {
    const r = v.getBoundingClientRect()
    if (r.height > 4) {
      offY = r.top + r.height * groundRatio
      charH = r.height * CHAR_H_RATIO
    }
  }

  return invoke('set_pet_contact', {
    offY: offY * dpr,
    charH: charH * dpr,
    dpi: dpr,
    granular,
  }).catch(() => {})
}

// ————————————————————————— 气泡 —————————————————————————

function bindBounce() {
  if (!window.PetBounce) return
  PetBounce.bind(() => ({ els: layers, originY: groundRatio }))
  if (PetBounce.saved()) PetBounce.setEnabled(true)
}

function showBubble(text, ms = 4200) {
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

// ————————————————————————— 启动 —————————————————————————

async function boot() {
  layers = [document.getElementById('vidA'), document.getElementById('vidB')]
  for (const v of layers) {
    v.muted = true
    v.playsInline = true
    v.disablePictureInPicture = true
    v.addEventListener('error', () => console.warn('[pet] 视频加载失败', v.src))
    v.addEventListener('loadeddata', () => refreshMask())
  }

  const st = await invoke('bootstrap')
  cfg = (st && st.cfg) || null
  loadDevState()
  const char = (cfg && cfg.activeChar) || 'raven'
  await loadManifest(char)
  const def = idleFor('stand')
  if (def) await applyIdle(def, { instant: true })
  refreshMask()
  await syncContact()

  // 接触点几何刚同步完，按设置摆一次：吸附就精确坐到任务栏/窗口上沿，
  // 重力就从当前位置开始掉。否则启动落点是按 Rust 的默认接地线比例估的，
  // 碰上 groundRatio 不同的角色（比如 suki 是 0.9）会差十几像素。
  if (cfg && (cfg.snap || cfg.gravity)) {
    invoke('pet_physics').catch(() => {})
  }

  bindBounce()
  startBounceMusic()

  await listen('pet:action', (e) => onAction(e.payload)).catch((e) => reportError('listen', e))
  await listen('pet:bounce', (e) => {
    const p = e.payload || {}
    if (!window.PetBounce) return
    if (p.speed != null) PetBounce.setSpeed(p.speed)
    if (p.on != null) PetBounce.setEnabled(!!p.on)
    syncBounceMusic()
  }).catch((e) => reportError('listen', e))
  await listen('pet:music-volume', () => syncBounceMusic()).catch((e) => reportError('listen', e))
  // 主窗开发者面板：按动作缩放/偏移 + 气泡位置
  await listen('pet:dev', (e) => onDev(e.payload)).catch((e) => reportError('listen', e))
  // 尺寸档切换：窗口尺寸由 Rust 改，前端必须按新的 innerWidth 重摆视频。
  // set_size 之后 innerWidth 不一定立刻更新，所以 rAF + 150ms 各补一次。
  await listen('pet:size', () => {
    const sync = () => {
      reapplyGeom()
      refreshMask()
      syncContact()
    }
    requestAnimationFrame(sync)
    setTimeout(sync, 150)
  }).catch((e) => reportError('listen', e))
  // 全屏静默：Rust 监视线程判定用户进入全屏后广播
  await listen('pet:fullscreen', (e) => {
    const p = e.payload || {}
    if (p.hidden) suspendForFullscreen(p.title)
    else resumeFromFullscreen()
  }).catch((e) => reportError('listen', e))

  bindInput()

  console.log('[pet] ready', character, def && def.id)
}

boot().catch((e) => reportError('boot', e))
