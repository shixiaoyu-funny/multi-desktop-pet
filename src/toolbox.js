/**
 * Suki 桌宠 —— 工具箱窗口前端
 *
 * 这个窗口只做 UI，不持有任何权威状态：
 *  · 全部状态从桌宠窗口通过 `pet:state` 事件同步过来
 *  · 所有操作通过 `pet:command` 事件发给桌宠窗口，由它落地并回推新状态
 *  · 窗口本身由 Rust 的 `open_toolbox` 命令按需创建/复用，关掉即销毁
 */

const { invoke } = window.__TAURI__.core
const { listen, emit } = window.__TAURI__.event

// 事件 API 走 ACL 权限，失败时不要留 unhandled rejection
const safeListen = (name, cb) =>
  listen(name, cb).catch((e) => console.warn('[toolbox] 监听失败', name, e))
const safeEmit = (name, payload) =>
  emit(name, payload).catch((e) => console.warn('[toolbox] 发送失败', name, e))

let state = null
let devOpen = false
let askTimer = null
let ttsEnabled = true
let milkTeaRemaining = 0
let milkTeaBusy = false

const $ = (sel) => document.querySelector(sel)

function setMilkTea(remaining) {
  milkTeaRemaining = Math.max(0, Math.min(2, Number(remaining) || 0))
  const button = $('#btnMilkTea')
  const count = $('#milkTeaCount')
  if (count) count.textContent = `今日 ${milkTeaRemaining}/2`
  if (button) button.disabled = milkTeaBusy || milkTeaRemaining <= 0
}

async function refreshMilkTea() {
  try {
    const status = await invoke('milk_tea_status')
    setMilkTea(status.remaining)
  } catch {
    setMilkTea(2)
  }
}

async function drinkMilkTea() {
  if (milkTeaBusy || milkTeaRemaining <= 0) return
  milkTeaBusy = true
  setMilkTea(milkTeaRemaining)
  try {
    const result = await invoke('drink_milk_tea')
    if (result && result.ok) {
      setMilkTea(result.remaining)
    } else {
      setMilkTea(0)
    }
  } catch (error) {
    console.warn('[toolbox] 喝奶茶失败', error)
    await refreshMilkTea()
  } finally {
    milkTeaBusy = false
    setMilkTea(milkTeaRemaining)
  }
}

function applyAffection(payload) {
  const badge = $('#affectionBadge')
  if (!badge) return
  const score = Number(payload && payload.score) || 0
  const stage = (payload && payload.stage) || 'guarded'
  badge.textContent = `好感度 ${score}`
  badge.className = `tb-affection stage-${stage}`
  badge.title = (payload && payload.label) || '好感度'
}

async function refreshAffection() {
  try {
    applyAffection(await invoke('affection_status'))
  } catch {}
}

boot()

function boot() {
  safeListen('pet:state', (e) => {
    state = e.payload
    ttsEnabled = !!(state.cfg && state.cfg.tts !== false)
    if (askTimer) { clearTimeout(askTimer); askTimer = null }
    render()
  })

  // 桌宠窗口可能比这里晚就绪，隔一会儿问一次，问到就停
  let tries = 0
  const ask = () => {
    if (state) return
    safeEmit('pet:request_state')
    if (++tries < 50) askTimer = setTimeout(ask, 300)
  }
  ask()

  bindEvents()
  $('#btnChat').addEventListener('click', openChat)
  $('#btnMilkTea').addEventListener('click', drinkMilkTea)
  safeListen('pet:affection', (event) => applyAffection(event.payload))
  safeListen('pet:milk-tea-status', (event) => {
    const payload = event.payload || {}
    if (typeof payload.remaining === 'number') setMilkTea(payload.remaining)
  })
  refreshAffection()
  refreshMilkTea()
}

async function openChat() {
  try {
    const status = await invoke('chat_status')
    if (status.configured) {
      await invoke('open_chat')
    } else {
      await invoke('open_chat_setup')
    }
  } catch (error) {
    console.warn('[toolbox] chat open failed', error)
    invoke('open_chat_setup').catch(() => {})
  }
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest(
      '[data-play],[data-posture],[data-size],[data-interval],[data-toggle],[data-reset],[data-devall],[data-devcopy],[data-preview]'
    )
    if (!el) return
    if (el.disabled || el.closest('.row.disabled')) return

    if (el.dataset.play) return safeEmit('pet:command', { type: 'play', id: el.dataset.play })
    if (el.dataset.posture) return safeEmit('pet:command', { type: 'posture', value: el.dataset.posture })
    if (el.dataset.preview) return safeEmit('pet:command', { type: 'preview', id: el.dataset.preview })
    if (el.dataset.size) return safeEmit('pet:command', { type: 'size', key: el.dataset.size })
    if (el.dataset.interval) {
      return safeEmit('pet:command', { type: 'interval', seconds: Number(el.dataset.interval) })
    }
    if (el.dataset.toggle) return toggle(el.dataset.toggle)
    if (el.dataset.reset) return safeEmit('pet:command', { type: 'resetScale', id: el.dataset.reset })
    if (el.dataset.devall) return resetAllScales()
    if (el.dataset.devcopy) return copyScales()
  })

  // 滑杆拖动：实时生效
  document.addEventListener('input', (e) => {
    const el = e.target
    if (!el.matches('[data-range]')) return
    const id = el.dataset.range
    const v = Number(el.value) / 100
    const out = document.querySelector(`[data-val="${id}"]`)
    if (out) out.textContent = (v * 100).toFixed(0) + '%'
    safeEmit('pet:command', { type: 'setScale', id, value: v })
  })

  const intervalRange = $('#intervalRange')
  if (intervalRange) {
    intervalRange.addEventListener('input', () => {
      const values = [180, 600, 900]
      const seconds = values[Number(intervalRange.value)] || 180
      safeEmit('pet:command', { type: 'interval', seconds })
    })
  }

  const devButton = $('#btnDev')
  if (devButton) devButton.addEventListener('click', () => toggleDev())
  $('#devClose').addEventListener('click', () => toggleDev(false))
  $('#devList').addEventListener('click', (e) => {
    const button = e.target.closest('[data-dev-id]')
    if (button) selectDev(button.dataset.devId)
  })
  $('#devPanel').addEventListener('click', (e) => {
    const button = e.target.closest('[data-snap-size]')
    if (!button) return
    safeEmit('pet:command', { type: 'size', key: button.dataset.snapSize })
    $('#devTip').textContent = `坐线档位：${button.textContent}；拖正坐/鸭子坐滑杆调整`
  })
  $('#devReset').addEventListener('click', resetDev)
  $('#devAll').addEventListener('click', resetAllDev)
  $('#devCopy').addEventListener('click', copyDev)
  $('#devScale').addEventListener('input', onDevScale)
  $('#devOffset').addEventListener('input', onDevOffset)
  $('#devBubble').addEventListener('input', onDevBubble)
  $('#devSnapUpright').addEventListener('input', () => onDevSnap('upright'))
  $('#devSnapDuck').addEventListener('input', () => onDevSnap('duck'))
  $('#btnQuit').addEventListener('click', () => invoke('quit_app'))

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && devOpen) toggleDev(false)
  })
}

/** 开关型指令：把当前值取反发给桌宠 */
function toggle(kind) {
  const c = state && state.cfg
  if (!c) return
  if (kind === 'autostart') {
    const next = !c.autostart
    invoke('set_autostart', { enabled: next })
      .then(() => {
        c.autostart = next
        render()
      })
      .catch((error) => console.warn('[toolbox] autostart toggle failed', error))
    return
  }
  if (kind === 'random') safeEmit('pet:command', { type: 'random', on: !c.random })
  else if (kind === 'top') safeEmit('pet:command', { type: 'top', on: !c.alwaysOnTop })
  else if (kind === 'snap') safeEmit('pet:command', { type: 'snap', on: !c.snap })
  else if (kind === 'tts') {
    ttsEnabled = !ttsEnabled
    c.tts = ttsEnabled
    render()
    safeEmit('pet:command', { type: 'tts', on: ttsEnabled })
    invoke('set_tts', { on: ttsEnabled }).catch(() => {})
  }
  else if (kind === 'gravity') {
    if (c.snap) return // 吸附开着时不允许
    safeEmit('pet:command', { type: 'gravity', on: !c.gravity })
  }
}

// ————————————————————————— 渲染 —————————————————————————

/** 主界面只给三个姿态入口；其余动作保留在隐藏的开发者面板/随机/AI 里。 */
const POSTURE_BUTTONS = [
  { key: 'stand', label: '站立' },
  { key: 'upright', label: '正坐' },
  { key: 'duck', label: '鸭子坐' },
]

function render() {
  if (!state) return
  const c = state.cfg

  // 姿态：站立 / 正坐 / 鸭子坐
  const pool = $('#pool')
  if (pool.dataset.sig !== 'postures') {
    pool.dataset.sig = 'postures'
    pool.innerHTML = `<div class="pool-group">
        <div class="pool-group-head">姿态</div>
        <div class="pool-set">${POSTURE_BUTTONS.map(
          (item) => `<button class="act" data-posture="${item.key}">${item.label}</button>`
        ).join('')}</div>
      </div>`
  }
  const activePosture = state.posture === 'stand' ? 'stand' : state.sitKind === 'duck' ? 'duck' : 'upright'
  pool.querySelectorAll('[data-posture]').forEach((el) => {
    el.classList.toggle('on', el.dataset.posture === activePosture)
  })

  // 开关
  setSw($('#rowRandom .sw'), c.random)
  setSw($('#rowTop .sw'), c.alwaysOnTop)
  setSw($('#rowSnap .sw'), c.snap)
  setSw($('#rowGravity .sw'), c.gravity)
  setSw($('#rowTts .sw'), c.tts !== false)
  setSw($('#rowAutostart .sw'), c.autostart)

  const gRow = $('#rowGravity')
  gRow.classList.toggle('disabled', !!c.snap)
  $('#gravityNote').textContent = c.snap ? '（吸附开启时不可用）' : ''

  // 大小 / 间隔
  document.querySelectorAll('[data-size]').forEach((el) => {
    el.classList.toggle('on', c.size === el.dataset.size)
  })
  document.querySelectorAll('[data-interval]').forEach((el) => {
    el.classList.toggle('on', Number(c.interval) === Number(el.dataset.interval))
  })
  const intervalValues = [180, 600, 900]
  const intervalRange = $('#intervalRange')
  if (intervalRange && document.activeElement !== intervalRange) {
    const index = intervalValues.indexOf(Number(c.interval))
    intervalRange.value = String(index >= 0 ? index : 0)
  }

  const meta = $('#meta')
  if (meta) {
    meta.textContent =
      `容器 ${state.containerPx}px · dpr ${state.dpr} · ` +
      `${state.action || '-'} · ${state.posture === 'sit' ? '坐姿' : '站姿'}`
  }

  if (devOpen) renderDev()
}

function setSw(el, on) {
  if (el) el.classList.toggle('on', !!on)
}

// ————————————————————————— 开发者面板（DSH 风格） —————————————————————————

const DEV_GROUPS = [
  { key: 'stand', label: '站姿' },
  { key: 'sit_upright', label: '正坐' },
  { key: 'sit_duck', label: '鸭子坐' },
  { key: 'trans', label: '过渡' },
]

let devSelected = null

function devGroupOf(item) {
  if (item.group === 'trans') return 'trans'
  if (item.posture === 'sit') return item.sitKind === 'duck' ? 'sit_duck' : 'sit_upright'
  return 'stand'
}

function toggleDev(on) {
  devOpen = typeof on === 'boolean' ? on : !devOpen
  $('#devPanel').classList.toggle('hidden', !devOpen)
  const devButton = $('#btnDev')
  if (devButton) devButton.classList.toggle('on', devOpen)
  if (devOpen) {
    renderDev(true)
    const start = state && state.pool.some((i) => i.id === state.action) ? state.action : 'stand_idle'
    selectDev(start)
  } else if (state && state.action) {
    safeEmit('pet:command', { type: 'play', id: state.action })
  }
}

function currentScale(id) {
  const item = state && state.pool.find((i) => i.id === id)
  if (!item) return 1
  const value = state.scales && state.scales[id]
  return typeof value === 'number' ? value : (typeof item.scale === 'number' ? item.scale : 1)
}

function currentOffset(id) {
  const item = state && state.pool.find((i) => i.id === id)
  if (!item) return 0
  const value = state.offsets && state.offsets[id]
  return typeof value === 'number' ? value : (typeof item.offset === 'number' ? item.offset : 0)
}

function setScaleUi(value) {
  const input = $('#devScale')
  if (input) input.value = String(value)
  const out = $('#devScaleVal')
  if (out) out.textContent = Number(value).toFixed(3)
}

function setOffsetUi(value) {
  const input = $('#devOffset')
  if (input) input.value = String(value)
  const out = $('#devOffsetVal')
  if (out) out.textContent = (value > 0 ? '+' : '') + Number(value).toFixed(1)
}

function renderDev(force = false) {
  if (!state) return
  const list = $('#devList')
  const sig = state.pool.map((i) => i.id).join(',')
  if (force || list.dataset.sig !== sig) {
    list.dataset.sig = sig
    list.innerHTML = DEV_GROUPS.map((group) => {
      const items = state.pool.filter((i) => devGroupOf(i) === group.key)
      if (!items.length) return ''
      return `<div class="dev-group">
        <div class="dev-group-title">${group.label}<span>${items.length}</span></div>
        <div class="dev-chips">${items.map((i) =>
          `<button type="button" class="dev-chip${devSelected === i.id ? ' on' : ''}" data-dev-id="${i.id}">${i.label}</button>`
        ).join('')}</div>
      </div>`
    }).join('')
  }
  syncDevValues()
}

function selectDev(id) {
  if (!state) return
  const item = state.pool.find((i) => i.id === id)
  if (!item) return
  devSelected = id
  $('#devSelectedLabel').textContent = item.label
  document.querySelectorAll('#devList [data-dev-id]').forEach((button) => {
    button.classList.toggle('on', button.dataset.devId === id)
  })
  setScaleUi(currentScale(id))
  setOffsetUi(currentOffset(id))
  safeEmit('pet:command', { type: 'preview', id })
  syncDevValues()
  $('#devTip').textContent = `正在预览 ${item.label}；拖滑杆实时生效`
}

function syncDevValues() {
  if (!devSelected || !state) return
  const scale = currentScale(devSelected)
  const offset = currentOffset(devSelected)
  const scaleInput = $('#devScale')
  const offsetInput = $('#devOffset')
  if (scaleInput && document.activeElement !== scaleInput) scaleInput.value = String(scale)
  if (offsetInput && document.activeElement !== offsetInput) offsetInput.value = String(offset)
  const scaleOut = $('#devScaleVal')
  if (scaleOut) scaleOut.textContent = Number(scale).toFixed(3)
  const offsetOut = $('#devOffsetVal')
  if (offsetOut) offsetOut.textContent = (offset > 0 ? '+' : '') + Number(offset).toFixed(1)
  const bubble = state && typeof state.bubbleOffset === 'number' ? state.bubbleOffset : 0
  const bubbleInput = $('#devBubble')
  if (bubbleInput && document.activeElement !== bubbleInput) bubbleInput.value = String(bubble)
  const bubbleOut = $('#devBubbleVal')
  if (bubbleOut) bubbleOut.textContent = (bubble > 0 ? '+' : '') + bubble + 'px'
  const sizeSuffix = state && state.cfg && state.cfg.size === 'large'
    ? 'Large' : state && state.cfg && state.cfg.size === 'medium' ? 'Medium' : 'Small'
  const snapUpright = state && state.cfg && typeof state.cfg[`snapOffsetUpright${sizeSuffix}`] === 'number'
    ? state.cfg[`snapOffsetUpright${sizeSuffix}`] : 61
  const snapDuck = state && state.cfg && typeof state.cfg[`snapOffsetDuck${sizeSuffix}`] === 'number'
    ? state.cfg[`snapOffsetDuck${sizeSuffix}`] : 20
  const snapUprightInput = $('#devSnapUpright')
  const snapDuckInput = $('#devSnapDuck')
  if (snapUprightInput && document.activeElement !== snapUprightInput) snapUprightInput.value = String(snapUpright)
  if (snapDuckInput && document.activeElement !== snapDuckInput) snapDuckInput.value = String(snapDuck)
  const snapUprightOut = $('#devSnapUprightVal')
  const snapDuckOut = $('#devSnapDuckVal')
  if (snapUprightOut) snapUprightOut.textContent = (snapUpright > 0 ? '+' : '') + snapUpright + 'px'
  if (snapDuckOut) snapDuckOut.textContent = (snapDuck > 0 ? '+' : '') + snapDuck + 'px'
  document.querySelectorAll('[data-snap-size]').forEach((button) => {
    button.classList.toggle('on', !!state && !!state.cfg && button.dataset.snapSize === state.cfg.size)
  })
  const label = state.pool.find((i) => i.id === devSelected)
  if (label) $('#devSelectedLabel').textContent = label.label
}

function onDevScale() {
  if (!devSelected) return
  const value = Number($('#devScale').value)
  $('#devScaleVal').textContent = value.toFixed(3)
  safeEmit('pet:command', { type: 'setScale', id: devSelected, value })
}

function onDevOffset() {
  if (!devSelected) return
  const value = Number($('#devOffset').value)
  $('#devOffsetVal').textContent = (value > 0 ? '+' : '') + value.toFixed(1)
  safeEmit('pet:command', { type: 'setOffset', id: devSelected, value })
}

function onDevBubble() {
  const value = Number($('#devBubble').value)
  $('#devBubbleVal').textContent = (value > 0 ? '+' : '') + value + 'px'
  safeEmit('pet:command', { type: 'bubbleOffset', value })
}

function onDevSnap(kind) {
  const input = kind === 'duck' ? $('#devSnapDuck') : $('#devSnapUpright')
  const out = kind === 'duck' ? $('#devSnapDuckVal') : $('#devSnapUprightVal')
  const value = Number(input.value)
  out.textContent = (value > 0 ? '+' : '') + value + 'px'
  const size = state && state.cfg && state.cfg.size ? state.cfg.size : 'small'
  safeEmit('pet:command', { type: 'snapOffset', kind, size, value })
}

function resetDev() {
  if (!devSelected || !state) return
  const item = state.pool.find((i) => i.id === devSelected)
  safeEmit('pet:command', { type: 'resetScale', id: devSelected })
  safeEmit('pet:command', { type: 'resetOffset', id: devSelected })
  setScaleUi(item && typeof item.scale === 'number' ? item.scale : 1)
  setOffsetUi(item && typeof item.offset === 'number' ? item.offset : 0)
  $('#devTip').textContent = '已复位为 manifest 出厂值'
}

function resetAllDev() {
  if (!state) return
  for (const item of state.pool) {
    safeEmit('pet:command', { type: 'resetScale', id: item.id })
    safeEmit('pet:command', { type: 'resetOffset', id: item.id })
  }
  syncDevValues()
  $('#devTip').textContent = '已复位全部动作'
}

function copyDev() {
  if (!state) return
  const out = {}
  for (const item of state.pool) {
    out[item.id] = {
      scale: Math.round(currentScale(item.id) * 1000) / 1000,
      offset: Math.round(currentOffset(item.id) * 10) / 10,
    }
  }
  const text = JSON.stringify(out, null, 2)
  copyText(text)
  console.log('[toolbox] 全部动作数值:\n' + text)
  $('#devTip').textContent = `已生成 ${state.pool.length} 个动作的 scale/offset（已尝试复制，也打印在控制台）`
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {})
  }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try { document.execCommand('copy') } catch {}
  area.remove()
  return Promise.resolve()
}
// shixiaoyu-funny原创，详见bilibili：https://space.bilibili.com/517323821?spm_id_from=333.337.0.0，仅供学习，严禁商用
