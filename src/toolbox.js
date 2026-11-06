/**
 * role2 桌宠 —— 工具箱窗口前端
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

const $ = (sel) => document.querySelector(sel)

boot()

function boot() {
  safeListen('pet:state', (e) => {
    state = e.payload
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
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest(
      '[data-play],[data-size],[data-interval],[data-toggle],[data-reset],[data-devall],[data-devcopy],[data-preview]'
    )
    if (!el) return
    if (el.disabled || el.closest('.row.disabled')) return

    if (el.dataset.play) return safeEmit('pet:command', { type: 'play', id: el.dataset.play })
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

    // 慌张挥手的上下偏移
    if (el.matches('[data-offset]')) {
      const id = el.dataset.offset
      const v = Number(el.value)
      const out = document.querySelector(`[data-offval="${id}"]`)
      if (out) out.textContent = (v > 0 ? '+' : '') + v + 'px'
      safeEmit('pet:command', { type: 'setOffset', id, value: v })
      return
    }

    if (!el.matches('[data-range]')) return
    const id = el.dataset.range
    const v = Number(el.value) / 100
    const out = document.querySelector(`[data-val="${id}"]`)
    if (out) out.textContent = (v * 100).toFixed(0) + '%'
    safeEmit('pet:command', { type: 'setScale', id, value: v })
  })

  $('#btnDev').addEventListener('click', () => toggleDev())
  $('#devClose').addEventListener('click', () => toggleDev(false))
  $('#btnQuit').addEventListener('click', () => invoke('quit_app'))

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && devOpen) toggleDev(false)
  })
}

/** 开关型指令：把当前值取反发给桌宠 */
function toggle(kind) {
  const c = state && state.cfg
  if (!c) return
  if (kind === 'random') safeEmit('pet:command', { type: 'random', on: !c.random })
  else if (kind === 'top') safeEmit('pet:command', { type: 'top', on: !c.alwaysOnTop })
  else if (kind === 'snap') safeEmit('pet:command', { type: 'snap', on: !c.snap })
  else if (kind === 'gravity') {
    if (c.snap) return // 吸附开着时不允许
    safeEmit('pet:command', { type: 'gravity', on: !c.gravity })
  }
}

// ————————————————————————— 渲染 —————————————————————————

/** 动作池分组：站姿 / 坐姿 / 慌张。过渡动画不展示（只在状态机内部自动播放）。 */
const POOL_GROUPS = [
  { key: 'stand', label: '站姿' },
  { key: 'sit', label: '坐姿' },
  { key: 'panic', label: '慌张' },
]

function render() {
  if (!state) return
  const c = state.cfg

  // 动作池：全部动作按四组展示
  const pool = $('#pool')
  const sig = state.pool.map((i) => i.id).join(',')
  if (pool.dataset.sig !== sig) {
    pool.dataset.sig = sig
    pool.innerHTML = POOL_GROUPS.map((g) => {
      const items = state.pool.filter((i) => i.group === g.key)
      if (!items.length) return ''
      const btns = items
        .map((i) => {
          // 待机动作点选走状态机（带过渡）；过渡/慌张点选循环预览（调大小）
          if (i.playable) return `<button class="act" data-play="${i.id}">${i.label}</button>`
          return `<button class="act act-one" data-preview="${i.id}" title="循环预览，调大小用">${i.label}</button>`
        })
        .join('')
      return `<div class="pool-group">
          <div class="pool-group-head">${g.label}<span class="pool-count">${items.length}</span></div>
          <div class="pool-set">${btns}</div>
        </div>`
    }).join('')
  }
  pool.querySelectorAll('[data-play]').forEach((el) => {
    el.classList.toggle('on', state.action === el.dataset.play)
  })
  pool.querySelectorAll('[data-preview]').forEach((el) => {
    el.classList.toggle('on', state.action === el.dataset.preview)
  })

  // 开关
  setSw($('#rowRandom .sw'), c.random)
  setSw($('#rowTop .sw'), c.alwaysOnTop)
  setSw($('#rowSnap .sw'), c.snap)
  setSw($('#rowGravity .sw'), c.gravity)

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

  $('#meta').textContent =
    `容器 ${state.containerPx}px · dpr ${state.dpr} · ` +
    `${state.action || '-'} · ${state.posture === 'sit' ? '坐姿' : '站姿'}`

  if (devOpen) renderDev()
}

function setSw(el, on) {
  if (el) el.classList.toggle('on', !!on)
}

// ————————————————————————— 开发者面板 —————————————————————————

function toggleDev(on) {
  devOpen = typeof on === 'boolean' ? on : !devOpen
  $('#devPanel').classList.toggle('hidden', !devOpen)
  $('#btnDev').classList.toggle('on', devOpen)
  if (devOpen) renderDev(true)
}

function renderDev(force = false) {
  if (!state) return
  const wrap = $('#devRows')
  const sig = state.pool.map((i) => i.id).join(',')
  if (force || wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig
    wrap.innerHTML = state.pool
      .map((i) => {
        const base = typeof i.scale === 'number' ? i.scale : 1
        // 慌张挥手额外给一个上下偏移滑杆（-20~20px），校准接地位差
        const offset = i.group === 'panic'
          ? `<div class="d-off">
              <div class="d-off-head">
                <span>上下偏移</span>
                <span class="d-off-val" data-offval="${i.id}"></span>
              </div>
              <input class="d-range" type="range" min="-20" max="20" step="0.5" value="0" data-offset="${i.id}" />
            </div>`
          : ''
        return `<div class="d-row">
          <div class="d-head">
            <span class="d-name">${i.label}</span>
            <span class="d-val" data-val="${i.id}"></span>
          </div>
          <input class="d-range" type="range" min="30" max="150" step="0.5" value="100" data-range="${i.id}" />
          ${offset}
          <div class="d-foot">
            <span class="d-base">出厂 ${Math.round(base * 100)}%</span>
            <button class="d-reset" data-reset="${i.id}">复位</button>
          </div>
        </div>`
      })
      .join('')
  }
  syncDevValues()
}

/** 只同步数值，不重建 DOM —— 否则拖滑杆拖到一半会被冲掉 */
function syncDevValues() {
  for (const i of state.pool) {
    const base = typeof i.scale === 'number' ? i.scale : 1
    const v = state.scales[i.id] != null ? state.scales[i.id] : base

    const out = document.querySelector(`[data-val="${i.id}"]`)
    if (out) {
      out.textContent = (v * 100).toFixed(0) + '%'
      out.classList.toggle('chg', Math.abs(v - base) > 0.0005)
    }
    const rng = document.querySelector(`[data-range="${i.id}"]`)
    if (rng && document.activeElement !== rng) rng.value = (v * 100).toFixed(1)

    // 慌张挥手的上下偏移
    const offVal = document.querySelector(`[data-offval="${i.id}"]`)
    const offRng = document.querySelector(`[data-offset="${i.id}"]`)
    if (offVal && offRng) {
      const ov = state.offsets && state.offsets[i.id] != null ? state.offsets[i.id] : 0
      offVal.textContent = (ov > 0 ? '+' : '') + ov + 'px'
      if (document.activeElement !== offRng) offRng.value = ov
    }
  }
}

function resetAllScales() {
  if (!state) return
  for (const i of state.pool) {
    safeEmit('pet:command', { type: 'resetScale', id: i.id })
    if (i.group === 'panic') safeEmit('pet:command', { type: 'resetOffset', id: i.id })
  }
}

function copyScales() {
  if (!state) return
  const data = {}
  for (const i of state.pool) data[i.id] = state.scales[i.id]
  const text = JSON.stringify(data, null, 2)
  navigator.clipboard?.writeText(text).catch(() => {})
  console.log('[toolbox] 缩放数值:\n' + text)
  const tip = document.querySelector('.dev-tip')
  if (tip) {
    tip.textContent = '已复制：' + text.replace(/\s+/g, ' ')
    setTimeout(() => { tip.textContent = '拖动滑杆实时生效，数值会自动记住' }, 4000)
  }
}
