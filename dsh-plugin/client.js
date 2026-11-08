/**
 * Raven pet — client half.
 *
 * Renders the pet inside `shell.overlay`. The layer is click-through, so only
 * the pet's own box opts back into pointer events. Action playback mirrors the
 * Tauri front end (two cross-faded <video> layers) without any Tauri calls.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-raven-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const ASSET_BASE = '/raven-winpet/assets'
    const STREAM_URL = '/raven-winpet/activity/stream'
    const STORE_KEY = 'ravenpet.v1'
    const FADE_MS = 320
    /** The action manifest's scale/offset are authored against this canvas. */
    const BASE = 1024
    /** Transition canvas offset: seated poses now land on the same feet line as
     * standing, so the transition needs no extra vertical shift. */
    const SIT_OFFSET = 0
    const SIZES = { large: 512, medium: 384, small: 288 }
    const SIZE_STEPS = [SIZES.small, SIZES.medium, SIZES.large]
    const SIZE_LABELS = ['小', '中', '大']
    /** Allow the pet to slide this far past the right viewport edge. */
    const EDGE_OVERFLOW = 120

    const HEAD_LINES = [
      '唔…好舒服',
      '再摸一下嘛',
      '嘿嘿，头要化了',
      '轻、轻一点…',
      '好暖和',
      '嗯…喜欢',
      '呼噜呼噜…',
      '今天也很努力了',
    ]
    const BELLY_LINES = [
      '哈哈，别挠！',
      '痒、痒啦！',
      '噗…忍不住了',
      '肚、肚子不行…',
      '嘻嘻，好痒',
      '再挠就笑给你看',
      '哈哈哈，停一下',
      '笑得肚子疼…',
    ]
    const LEG_LINES = [
      '呀！别碰那里…',
      '讨厌，腿很敏感啦',
      '你、你干嘛…',
      '不、不许摸腿！',
      '好害羞…',
      '再摸我要生气了',
      '哼…色狼',
    ]
    const pickLine = (lines) => lines[(Math.random() * lines.length) | 0]
    const TRANSITIONS = {
      'stand>sit_upright': 'trans_stand_to_upright',
      'stand>sit_side': 'trans_stand_to_side',
      'sit_upright>stand': 'trans_upright_to_stand',
      'sit_side>stand': 'trans_side_to_stand',
      'sit_side>sit_upright': 'trans_side_to_upright',
      'sit_upright>sit_side': 'trans_upright_to_side',
    }

    const CSS = `
      .ravenpet-root{position:fixed;inset:0;pointer-events:none;z-index:9999;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      .ravenpet-dragging,.ravenpet-dragging *{cursor:grabbing!important}
      .ravenpet-stage{position:absolute;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none}
      .ravenpet-stage:active{cursor:grabbing}
      .ravenpet-canvas{position:absolute;left:0;top:0;width:${BASE}px;height:${BASE}px;transform-origin:top left;pointer-events:none;overflow:hidden}
      .ravenpet-video{position:absolute;left:50%;top:50%;object-fit:contain;opacity:0;transition:opacity ${FADE_MS}ms ease;pointer-events:none;background:transparent}
      .ravenpet-video.ravenpet-on{opacity:1}
      .ravenpet-bubble{position:absolute;left:50%;bottom:calc(100% - 28px);transform:translateX(-50%);max-width:260px;padding:7px 11px;border-radius:12px;background:rgba(255,255,255,.94);color:#2b2f36;font-size:12px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none;opacity:0;transition:opacity 180ms ease}
      .ravenpet-bubble.ravenpet-on{opacity:1}
      .ravenpet-bubble:after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(255,255,255,.94)}
      .ravenpet-menu{position:fixed;width:152px;min-width:0;box-sizing:border-box;padding:6px;border-radius:10px;background:#20242c;color:#e8eaf0;box-shadow:0 12px 32px rgba(0,0,0,.35);pointer-events:auto;font-size:12px}
      .ravenpet-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:7px 9px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .ravenpet-menu button:hover{background:rgba(255,255,255,.1)}
      .ravenpet-menu .ravenpet-sep{height:1px;margin:5px 4px;background:rgba(255,255,255,.12)}
      .ravenpet-menu .ravenpet-dim{color:#9aa3b2}
      .ravenpet-choice{display:flex;align-items:center;gap:8px;padding:5px 9px;color:#e8eaf0}
      .ravenpet-choice > span{width:30px;flex:none;color:#9aa3b2}
      .ravenpet-seg{display:flex;flex:1;gap:2px;padding:2px;border-radius:6px;background:rgba(255,255,255,.06)}
      .ravenpet-seg button{display:block;width:auto;flex:1;gap:0;padding:4px 0;border:0;border-radius:4px;background:transparent;color:#9aa3b2;font:inherit;font-size:11px;text-align:center;cursor:pointer}
      .ravenpet-seg button:hover{background:rgba(255,255,255,.08)}
      .ravenpet-seg button.ravenpet-on{background:#2f7cf6;color:#fff}
      .ravenpet-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#5ad08a;margin-right:6px}
      .ravenpet-dot.ravenpet-off{background:#8a93a3}
      .ravenpet-dev{position:fixed;left:16px;top:16px;width:310px;max-height:calc(100vh - 32px);overflow:auto;padding:10px;border-radius:12px;background:#1c2028;color:#e8eaf0;box-shadow:0 16px 40px rgba(0,0,0,.45);pointer-events:auto;font-size:12px}
      .ravenpet-dev-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-weight:600}
      .ravenpet-dev-head button{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}
      .ravenpet-dev-list{max-height:36vh;overflow:auto;padding:4px;margin-bottom:8px;border:1px solid rgba(255,255,255,.09);border-radius:8px}
      .ravenpet-dev-group{padding:4px 6px;color:#8b95a7;font-size:11px}
      .ravenpet-dev-act{display:inline-block;margin:2px;padding:4px 7px;border:1px solid rgba(255,255,255,.13);border-radius:6px;background:transparent;color:inherit;font-size:11px;cursor:pointer}
      .ravenpet-dev-act.ravenpet-dev-on{background:#2f7cf6;border-color:#2f7cf6}
      .ravenpet-dev-row{display:flex;align-items:center;gap:8px;margin:6px 0}
      .ravenpet-dev-row span{width:30px;color:#9aa3b2}
      .ravenpet-dev-row input{flex:1;accent-color:#2f7cf6}
      .ravenpet-dev-row b{width:48px;text-align:right;font-weight:500}
      .ravenpet-dev-actions{display:flex;gap:6px;margin-top:8px}
      .ravenpet-dev-actions button{flex:1;padding:6px;border:1px solid rgba(255,255,255,.14);border-radius:6px;background:rgba(255,255,255,.06);color:inherit;font-size:11px;cursor:pointer}
      .ravenpet-dev-status{margin-top:6px;min-height:14px;color:#7fd18f;font-size:11px;word-break:break-all}
      .ravenpet-balance{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 9px 2px;color:#9aa3b2}
      .ravenpet-balance b{font-weight:600}
    `

    function readStore() {
      try {
        return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}
      } catch {
        return {}
      }
    }

    function writeStore(patch) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch }))
      } catch {
        // storage may be unavailable; the pet still works for this page
      }
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    function initialUi() {
      const saved = readStore()
      const size = typeof saved.size === 'number'
        ? clamp(saved.size, 220, 560)
        : SIZES[saved.size] ?? SIZES.medium
      const maxX = Math.max(8, window.innerWidth - size - 8 + EDGE_OVERFLOW)
      const maxY = Math.max(8, window.innerHeight - size - 8)
      const defaultX = Math.max(16, window.innerWidth - size - 24)
      // One-time nudge: move a previously saved position 100px further right,
      // now that the right edge allows overflow past the viewport.
      const savedX = Number.isFinite(saved.x)
        ? (saved.edgeVersion === 2 ? saved.x : saved.x + 100)
        : defaultX
      return {
        size,
        x: clamp(savedX, 0, maxX),
        y: Number.isFinite(saved.y) ? clamp(saved.y, 0, maxY) : Math.max(16, maxY - 40),
        random: true,
        interval: 60,
        react: true,
        edgeVersion: 2,
      }
    }

    function flattenPool(manifest) {
      const pool = []
      for (const key of Object.keys(manifest.pools || {})) {
        const group = manifest.pools[key]
        for (const item of group.items || []) {
          pool.push({
            ...item,
            loop: item.loop != null ? item.loop : group.loop !== false,
            playable: item.playable != null ? item.playable : group.playable !== false,
          })
        }
      }
      return pool
    }

    function urlOf(item) {
      const file = String(item.file || '').replace(/^assets\//, '')
      return `${ASSET_BASE}/${file.split('/').map(encodeURIComponent).join('/')}`
    }

    function postureOf(item) {
      if (!item) return 'stand'
      if (item.posture) return item.posture
      return /^sit/.test(item.id) ? 'sit' : 'stand'
    }

    function sitKindOf(item) {
      if (!item || postureOf(item) !== 'sit') return null
      return item.sitKind || (/lean/.test(item.id) ? 'side' : 'upright')
    }

    function granularOf(item) {
      if (postureOf(item) === 'stand') return 'stand'
      return sitKindOf(item) === 'side' ? 'sit_side' : 'sit_upright'
    }

    /** Imperative playback engine; React only owns placement and chrome. */
    function createEngine(videoA, videoB, hooks) {
      const layers = [videoA, videoB]
      let pool = []
      let playable = []
      let ambient = []
      let current = null
      let front = 0
      let granular = 'stand'
      let posture = 'stand'
      let destroyed = false
      let token = 0
      let busy = false

      const OVERRIDE_KEY = 'ravenpet.dev.v1'
      const readOverrides = () => {
        try {
          return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') || {}
        } catch {
          return {}
        }
      }
      let overrides = readOverrides()
      const saveOverrides = () => {
        try {
          localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides))
        } catch {
          // storage unavailable: the panel still works for this page
        }
      }
      /** Effective scale/offset: developer override, else the manifest value. */
      const effective = (item) => {
        const override = overrides[item.id]
        return {
          scale: Number(override?.scale ?? item.scale) || 1,
          offset: Number(override?.offset ?? item.offset) || 0,
        }
      }

      /** Keep the component's posture slider in sync with engine transitions. */
      const setPostureValue = (next) => {
        posture = next
        hooks.onPosture?.(next)
      }

      const pick = (list) => list[(Math.random() * list.length) | 0]
      const pickFor = (want) => {
        const same = playable.filter((item) => postureOf(item) === want)
        const others = same.filter((item) => !current || item.id !== current.id)
        return pick(others.length ? others : same) || null
      }
      const findTransition = (from, to) => {
        const id = TRANSITIONS[`${from}>${to}`]
        return id ? pool.find((item) => item.id === id) : null
      }

      /** Place one video exactly as the Tauri front end does: centered in the
       * 1024 canvas, sized by the action's scale, shifted by its sit offset. */
      const applyLayerStyle = (video, item) => {
        const { scale, offset } = effective(item)
        const px = BASE * scale
        video.style.width = `${px}px`
        video.style.height = `${px}px`
        video.style.transform = `translate(-50%, calc(-50% + ${offset}px))`
      }

      async function play(item, opts = {}) {
        if (!item || destroyed) return
        if (current && current.id === item.id && !opts.force) return
        const myToken = ++token
        const cur = layers[front]
        const nxt = layers[1 - front]
        nxt.classList.remove('ravenpet-on')
        applyLayerStyle(nxt, item)
        if (opts.offsetFrom !== undefined) {
          nxt.style.transform = `translate(-50%, calc(-50% + ${opts.offsetFrom}px))`
        }
        try {
          nxt.src = urlOf(item)
          nxt.loop = opts.loop != null ? opts.loop : item.loop !== false
          nxt.load()
          await new Promise((resolve) => {
            let settled = false
            const finish = () => {
              if (settled) return
              settled = true
              nxt.removeEventListener('loadeddata', finish)
              clearTimeout(timer)
              resolve()
            }
            const timer = setTimeout(finish, 1500)
            nxt.addEventListener('loadeddata', finish, { once: true })
          })
          if (myToken !== token || destroyed) return
          nxt.currentTime = 0
          await nxt.play().catch(() => {})
          if (myToken !== token || destroyed) return
          nxt.classList.add('ravenpet-on')
          cur.classList.remove('ravenpet-on')
          front = 1 - front
          const previous = cur
          setTimeout(() => {
            if (destroyed || previous === layers[front]) return
            previous.pause()
            previous.removeAttribute('src')
            previous.load()
          }, FADE_MS + 120)
          current = item
          if (opts.offsetFrom !== undefined && opts.offsetTo !== undefined) {
            const step = () => {
              if (destroyed || current !== item) return
              const duration = Number.isFinite(nxt.duration) && nxt.duration > 0 ? nxt.duration : 3
              const progress = Math.min(1, Math.max(0, nxt.currentTime / duration))
              const offset = opts.offsetFrom + (opts.offsetTo - opts.offsetFrom) * progress
              nxt.style.transform = `translate(-50%, calc(-50% + ${offset}px))`
              if (progress < 1) requestAnimationFrame(step)
            }
            requestAnimationFrame(step)
          }
          if (opts.onEnded) {
            const handler = () => {
              nxt.removeEventListener('ended', handler)
              if (current === item && !destroyed) opts.onEnded()
            }
            nxt.addEventListener('ended', handler, { once: true })
          }
        } finally {
          if (!opts.onEnded) busy = false
        }
      }

      function switchTo(item) {
        if (!item || destroyed) return
        const fromPosture = posture
        const to = granularOf(item)
        if (to === granular) {
          granular = to
            setPostureValue(postureOf(item))
          play(item, { loop: true })
          return
        }
        const transition = findTransition(granular, to)
        granular = to
          setPostureValue(postureOf(item))
        if (!transition) {
          play(item, { loop: true, force: true })
          return
        }
        busy = true
        setTimeout(() => { busy = false }, 4000)
        play(transition, {
          force: true,
          loop: false,
          offsetFrom: fromPosture === 'stand' ? 0 : SIT_OFFSET,
          offsetTo: posture === 'stand' ? 0 : SIT_OFFSET,
          onEnded: () => {
            busy = false
            play(item, { loop: true, force: true })
          },
        })
      }

      async function init() {
        const response = await fetch(`${ASSET_BASE}/manifest.json`, { cache: 'no-cache' })
        if (!response.ok) throw new Error(`manifest ${response.status}`)
        const manifest = await response.json()
        pool = flattenPool(manifest)
        playable = pool.filter((item) => item.playable)
        ambient = playable.filter((item) => item.ambient === true)
        if (ambient.length === 0) {
          const fallback = new Set(['stand_idle', 'sit_idle', 'sit_lean'])
          ambient = playable.filter((item) => fallback.has(item.id))
        }
        const first = playable.find((item) => item.id === manifest.defaultAction) || playable[0]
        if (!first) throw new Error('empty action pool')
        granular = granularOf(first)
        setPostureValue(postureOf(first))
        await play(first, { loop: true, force: true })
        hooks.onReady?.(manifest)
      }

      function setPosture(want) {
        if (want === posture) return
        const base = ambient.length ? ambient : playable
        const same = base.filter((item) => postureOf(item) === want)
        const others = same.filter((item) => !current || item.id !== current.id)
        const target = pick(others.length ? others : same)
        if (target) switchTo(target)
      }

      /** Idle behavior: only the three base idles (stand / upright sit / side sit). */
      function randomNext() {
        if (busy || destroyed) return
        const base = ambient.length ? ambient : playable
        const others = base.filter((item) => !current || item.id !== current.id)
        const target = pick(others.length ? others : base)
        if (target) switchTo(target)
      }

      /** Working pose: the phone for ordinary activity, the book for searches. */
      function work(search) {
        if (destroyed) return
        const id = search ? 'stand_book' : 'stand_phone'
        const item = playable.find((candidate) => candidate.id === id)
          ?? pool.find((candidate) => candidate.id === id)
        if (!item) return
        if (current && current.id === item.id) return
        switchTo(item)
      }

      /** Leaving work: drop the phone/book pose immediately, then let the 30s
       * idle timer rotate the three base idles. */
      function idle() {
        if (destroyed) return
        const ids = new Set(ambient.map((item) => item.id))
        if (current && !ids.has(current.id)) randomNext()
      }

      /** One-shot mood action (done/failed): transition to its posture when
       * needed, play the clip once, then return to idle rotation. */
      function once(id, options = {}) {
        if (destroyed) return
        const item = playable.find((candidate) => candidate.id === id)
          ?? pool.find((candidate) => candidate.id === id)
        if (!item) return
        const target = granularOf(item)
        if (target !== granular) {
          const transition = findTransition(granular, target)
          granular = target
          setPostureValue(postureOf(item))
          if (transition) {
            busy = true
            play(transition, {
              force: true,
              loop: false,
              offsetFrom: SIT_OFFSET,
              offsetTo: SIT_OFFSET,
              onEnded: () => {
                busy = false
                onceNow(item, options)
              },
            })
            return
          }
        }
        onceNow(item, options)
      }

      function onceNow(item, options = {}) {
        busy = true
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(fallback)
          busy = false
          if (options.settle) {
            const want = options.settle
            const candidates = ambient.filter((candidate) => (
              want === 'sit'
                ? postureOf(candidate) === 'sit'
                : granularOf(candidate) === want
            ))
            const target = pick(candidates)
            if (target) {
              switchTo(target)
              return
            }
          }
          randomNext()
        }
        const fallback = setTimeout(finish, 5000)
        play(item, {
          loop: false,
          force: true,
          onEnded: finish,
        })
      }

      /** Click interactions: head -> hair, belly -> giggle, leg (upright sit) -> panic. */
      function interact(zone) {
        if (destroyed || busy) return false
        const active = current ? granularOf(current) : granular
        if (zone === 'leg') {
          if (active !== 'sit_upright') return false
          once('sit_panic', { settle: 'sit_upright' })
          return true
        }
        const suffix = zone === 'head' ? 'hair' : 'giggle'
        const prefix = active === 'sit_side' ? 'sit_side' : active === 'sit_upright' ? 'sit' : 'stand'
        const id = `${prefix}_${suffix}`
        once(pool.some((item) => item.id === id) ? id : `sit_${suffix}`)
        return true
      }

      /** "搞定": stand -> transition into a random seat -> seated hair -> that seat idle. */
      function doneSequence() {
        if (destroyed) return
        const useUpright = Math.random() < 0.5
        const target = useUpright ? 'sit_upright' : 'sit_side'
        const hairId = useUpright ? 'sit_hair' : 'sit_side_hair'
        const idleId = useUpright ? 'sit_idle' : 'sit_lean'
        const hair = playable.find((candidate) => candidate.id === hairId)
          ?? pool.find((candidate) => candidate.id === hairId)
        const idle = ambient.find((candidate) => candidate.id === idleId)
          ?? playable.find((candidate) => candidate.id === idleId)
        if (!hair || !idle) {
          once('stand_hair', { settle: 'stand' })
          return
        }

        const playHair = () => {
          granular = target
          setPostureValue('sit')
          onceNow(hair, { settle: target })
        }

        const toSeat = () => {
          const transition = findTransition('stand', target)
          if (!transition) {
            playHair()
            return
          }
          busy = true
          play(transition, {
            force: true,
            loop: false,
            offsetFrom: 0,
            offsetTo: SIT_OFFSET,
            onEnded: () => {
              busy = false
              playHair()
            },
          })
        }

        if (granular === 'stand') {
          toSeat()
          return
        }

        const standUp = findTransition(granular, 'stand')
        if (!standUp) {
          granular = 'stand'
          setPostureValue('stand')
          toSeat()
          return
        }
        granular = 'stand'
        setPostureValue('stand')
        busy = true
        play(standUp, {
          force: true,
          loop: false,
          offsetFrom: SIT_OFFSET,
          offsetTo: 0,
          onEnded: () => {
            busy = false
            toSeat()
          },
        })
      }

      /** Map a semantic done/failed action to the current posture's variant. */
      function resolveOnce(base) {
        const suffix = base.endsWith('_hair') ? 'hair' : base.endsWith('_angry') ? 'angry' : null
        if (suffix === null) return base
        const candidates = granular === 'sit_side'
          ? ['sit_side', 'sit', 'stand']
          : granular === 'sit_upright'
            ? ['sit', 'stand']
            : ['stand']
        for (const prefix of candidates) {
          const id = `${prefix}_${suffix}`
          if (pool.some((item) => item.id === id)) return id
        }
        return base
      }

      /** Developer panel: every action in the manifest, grouped by posture. */
      function catalog() {
        return pool.map((item) => ({
          id: item.id,
          label: item.label || item.id,
          posture: postureOf(item),
          sitKind: sitKindOf(item),
          transition: item.transition || null,
          scale: effective(item).scale,
          offset: effective(item).offset,
        }))
      }

      function transformOf(id) {
        const item = pool.find((candidate) => candidate.id === id)
        return item ? effective(item) : null
      }

      function setTransform(id, patch) {
        const item = pool.find((candidate) => candidate.id === id)
        if (!item) return
        const next = { ...effective(item), ...patch }
        overrides = { ...overrides, [id]: { scale: next.scale, offset: next.offset } }
        saveOverrides()
        if (current && current.id === id) applyLayerStyle(layers[front], current)
      }

      function resetTransform(id) {
        if (overrides[id] === undefined) return
        const next = { ...overrides }
        delete next[id]
        overrides = next
        saveOverrides()
        if (current && current.id === id) applyLayerStyle(layers[front], current)
      }

      function allOverrides() {
        return { ...overrides }
      }

      /** Preview one action in a loop, independent of the idle/AI state. */
      function preview(id) {
        if (destroyed) return
        const item = pool.find((candidate) => candidate.id === id)
        if (!item) return
        busy = false
        granular = granularOf(item)
          setPostureValue(postureOf(item))
        play(item, { loop: true, force: true })
      }

      function currentView() {
        return current ? { id: current.id, label: current.label || current.id } : null
      }

      function state() {
        return { action: current?.id ?? null, posture, granular }
      }

      function destroy() {
        destroyed = true
        for (const video of layers) {
          try {
            video.pause()
            video.removeAttribute('src')
            video.load()
          } catch {
            // ignore
          }
        }
      }

      return {
        init, play, switchTo, setPosture, randomNext, work, idle, once, interact,
        doneSequence, resolveOnce, catalog, transformOf, setTransform, resetTransform, allOverrides, preview, currentView,
        state, destroy,
      }
    }

    function PetOverlay() {
      const [ui, setUi] = useState(initialUi)
      const [menu, setMenu] = useState(null)
      const [phase, setPhase] = useState('idle')
      const [bubble, setBubble] = useState(null)
      const [connected, setConnected] = useState(false)
      const [ready, setReady] = useState(false)
      const [working, setWorking] = useState(false)
      const [mode, setMode] = useState(null)
      const [petPosture, setPetPosture] = useState('stand')
      const [randomEpoch, setRandomEpoch] = useState(0)
      const [localBubble, setLocalBubble] = useState(null)
      const [devOpen, setDevOpen] = useState(false)
      const [devSelected, setDevSelected] = useState(null)
      const [devScale, setDevScale] = useState(1)
      const [devOffset, setDevOffset] = useState(0)
      const [devStatus, setDevStatus] = useState('')
      const [balance, setBalance] = useState({ loading: true })

      const uiRef = useRef(ui)
      const reactRef = useRef(ui.react)
      const workingRef = useRef(false)
      const devOpenRef = useRef(false)
      const dragRef = useRef(null)
      const menuRef = useRef(null)
      const rootRef = useRef(null)
      const stageRef = useRef(null)
      const hitCanvasRef = useRef(null)
      const videoARef = useRef(null)
      const videoBRef = useRef(null)
      const engineRef = useRef(null)
      const bubbleTimerRef = useRef(null)
      const activityRef = useRef(null)

      uiRef.current = ui
      reactRef.current = ui.react
      devOpenRef.current = devOpen

      useEffect(() => {
        const engine = createEngine(videoARef.current, videoBRef.current, {
          onReady: () => setReady(true),
          onPosture: setPetPosture,
        })
        engineRef.current = engine
        engine.init().catch((error) => {
          console.error('[raven-winpet] init failed', error)
        })
        return () => {
          engine.destroy()
          engineRef.current = null
        }
      }, [])

      // Position/size persistence (debounced so dragging does not write per frame).
      useEffect(() => {
        const timer = setTimeout(() => {
          writeStore({
            size: Math.round(ui.size),
            x: Math.round(ui.x),
            y: Math.round(ui.y),
            random: ui.random,
            interval: ui.interval,
            react: ui.react,
            edgeVersion: ui.edgeVersion,
          })
        }, 200)
        return () => clearTimeout(timer)
      }, [ui])

      // Bubble auto-hide.
      useEffect(() => {
        if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
        if (!bubble) return undefined
        bubbleTimerRef.current = setTimeout(() => setBubble(null), 9000)
        return () => {
          if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
        }
      }, [bubble])

      // Interaction bubble auto-hide; independent of the AI status bubble.
      useEffect(() => {
        if (!localBubble) return undefined
        const timer = setTimeout(() => setLocalBubble(null), 4500)
        return () => clearTimeout(timer)
      }, [localBubble])

      // Idle rotation: every idle posture, every 30s, paused while working or
      // while the developer panel is open.
      useEffect(() => {
        if (!ui.random || !ready || working || devOpen) return undefined
        const timer = setInterval(() => engineRef.current?.randomNext(), Math.max(5, ui.interval) * 1000)
        return () => clearInterval(timer)
      }, [ui.random, ui.interval, ready, working, devOpen, randomEpoch])

      // Activity subscription.
      useEffect(() => {
        let source
        let retry
        const apply = (payload) => {
          if (devOpenRef.current) return
          if (!reactRef.current) {
            setPhase('idle')
            setBubble(null)
            setWorking(false)
            setMode(null)
            workingRef.current = false
            engineRef.current?.idle()
            return
          }
          const nextPhase = payload.phase || 'idle'
          setPhase(nextPhase)
          setBubble(payload.line || null)
          if (nextPhase === 'idle') {
            const wasWorking = workingRef.current
            setWorking(false)
            setMode(null)
            workingRef.current = false
            if (wasWorking) engineRef.current?.idle()
            return
          }
          if (nextPhase === 'done' || nextPhase === 'failed') {
            setWorking(false)
            setMode(null)
            workingRef.current = false
            const engine = engineRef.current
            if (engine) {
              if (nextPhase === 'done') {
                engine.doneSequence()
              } else {
                engine.once(engine.resolveOnce(payload.action || 'stand_angry'))
              }
            }
            return
          }
          setWorking(true)
          setMode(payload.mode || 'work')
          workingRef.current = true
          engineRef.current?.work(payload.mode === 'search')
        }
        activityRef.current = apply
        const connect = () => {
          source?.close()
          source = new EventSource(STREAM_URL)
          source.onopen = () => setConnected(true)
          source.onmessage = (event) => {
            try {
              apply(JSON.parse(event.data))
            } catch {
              // ignore malformed frames
            }
          }
          source.onerror = () => {
            setConnected(false)
            source?.close()
            source = undefined
            clearTimeout(retry)
            retry = setTimeout(connect, 3000)
          }
        }
        connect()
        return () => {
          if (retry) clearTimeout(retry)
          source?.close()
        }
      }, [])

      // Close the menu on an outside press.
      useEffect(() => {
        if (!menu) return undefined
        const onDown = (event) => {
          if (menuRef.current && menuRef.current.contains(event.target)) return
          setMenu(null)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [menu])

      const clampInside = (next) => {
        const maxX = Math.max(0, window.innerWidth - next.size + EDGE_OVERFLOW)
        const maxY = Math.max(0, window.innerHeight - next.size - 4)
        return { ...next, x: clamp(next.x, 0, maxX), y: clamp(next.y, 0, maxY) }
      }

      const isOpaqueAt = (clientX, clientY) => {
        const stage = stageRef.current
        if (!stage) return false
        const stageRect = stage.getBoundingClientRect()
        if (
          clientX < stageRect.left ||
          clientX > stageRect.right ||
          clientY < stageRect.top ||
          clientY > stageRect.bottom
        ) return false
        const video = videoARef.current?.classList.contains('ravenpet-on')
          ? videoARef.current
          : videoBRef.current
        if (!video || video.readyState < 2) return false
        const rect = video.getBoundingClientRect()
        if (
          clientX < rect.left ||
          clientX > rect.right ||
          clientY < rect.top ||
          clientY > rect.bottom
        ) return false
        let canvas = hitCanvasRef.current
        if (!canvas) {
          canvas = document.createElement('canvas')
          canvas.width = 256
          canvas.height = 256
          hitCanvasRef.current = canvas
        }
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return false
        try {
          context.clearRect(0, 0, 256, 256)
          context.drawImage(video, 0, 0, 256, 256)
          const x = clamp(Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * 256), 0, 255)
          const y = clamp(Math.floor(((clientY - rect.top) / Math.max(1, rect.height)) * 256), 0, 255)
          return context.getImageData(x, y, 1, 1).data[3] > 24
        } catch {
          return false
        }
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        if (event.target?.closest?.('.ravenpet-menu,.ravenpet-dev')) return
        if (!isOpaqueAt(event.clientX, event.clientY)) return
        event.preventDefault()
        event.stopPropagation()
        document.body.style.cursor = 'grabbing'
        document.documentElement.classList.add('ravenpet-dragging')
        setMenu(null)
        const stage = stageRef.current
        if (!stage) return
        const rect = stage.getBoundingClientRect()
        dragRef.current = {
          pointerId: event.pointerId,
          dx: event.clientX - uiRef.current.x,
          dy: event.clientY - uiRef.current.y,
          startX: event.clientX,
          startY: event.clientY,
          relX: (event.clientX - rect.left) / Math.max(1, rect.width),
          relY: (event.clientY - rect.top) / Math.max(1, rect.height),
          moved: false,
        }
        try {
          document.documentElement.setPointerCapture?.(event.pointerId)
        } catch {}
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
          drag.moved = true
        }
        setUi((previous) => clampInside({
          ...previous,
          x: event.clientX - drag.dx,
          y: event.clientY - drag.dy,
        }))
      }

      const onPointerUp = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        dragRef.current = null
        document.body.style.cursor = ''
        document.documentElement.classList.remove('ravenpet-dragging')
        try {
          document.documentElement.releasePointerCapture?.(event.pointerId)
        } catch {}
        if (drag.moved) return
        if (devOpenRef.current) return
        if (drag.relX < 0.15 || drag.relX > 0.85) return
        if (drag.relY < 0.45) {
          if (engineRef.current?.interact('head')) {
            setLocalBubble({ text: pickLine(HEAD_LINES) })
            resetRandomTimer()
          }
        } else if (drag.relY < 0.72) {
          if (engineRef.current?.interact('belly')) {
            setLocalBubble({ text: pickLine(BELLY_LINES) })
            resetRandomTimer()
          }
        } else if (drag.relY < 0.9) {
          if (engineRef.current?.interact('leg')) {
            setLocalBubble({ text: pickLine(LEG_LINES) })
            resetRandomTimer()
          }
        }
      }

      const onContextMenu = (event) => {
        if (event.target?.closest?.('.ravenpet-menu,.ravenpet-dev')) return
        if (!isOpaqueAt(event.clientX, event.clientY)) return
        event.preventDefault()
        event.stopPropagation()
        setMenu({
          x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 160)),
          y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 260)),
        })
      }

      // Stage is pointer-events:none; listen at document level and only start
      // dragging / reactions when the current video frame is opaque there.
      useEffect(() => {
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('pointermove', onPointerMove, true)
        document.addEventListener('pointerup', onPointerUp, true)
        document.addEventListener('pointercancel', onPointerUp, true)
        document.addEventListener('contextmenu', onContextMenu, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('pointermove', onPointerMove, true)
          document.removeEventListener('pointerup', onPointerUp, true)
          document.removeEventListener('pointercancel', onPointerUp, true)
          document.removeEventListener('contextmenu', onContextMenu, true)
          document.documentElement.classList.remove('ravenpet-dragging')
          document.body.style.cursor = ''
        }
      }, [])

      const setPetSize = (value) => {
        const size = clamp(Number(value) || SIZES.medium, 220, 560)
        setUi((previous) => clampInside({ ...previous, size }))
      }

      /** Restart the idle rotation countdown after a manual interaction. */
      const resetRandomTimer = () => setRandomEpoch((value) => value + 1)

      const resetPosition = () => {
        setUi((previous) => clampInside({
          ...previous,
          x: window.innerWidth - previous.size - 32,
          y: window.innerHeight - previous.size - 44,
        }))
        setMenu(null)
      }

      const loadBalance = async () => {
        try {
          const response = await fetch('/raven-winpet/balance', { cache: 'no-store' })
          const data = await response.json()
          setBalance(data?.ok ? data : { ok: false, reason: data?.reason || 'error' })
        } catch {
          setBalance({ ok: false, reason: 'error' })
        }
      }

      useEffect(() => {
        loadBalance()
        const timer = setInterval(loadBalance, 60_000)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        if (menu) loadBalance()
      }, [menu])

      const selectDev = (id) => {
        if (!id) return
        setDevSelected(id)
        const transform = engineRef.current?.transformOf(id)
        if (transform) {
          setDevScale(transform.scale)
          setDevOffset(transform.offset)
        }
        engineRef.current?.preview(id)
        setDevStatus('')
      }

      const openDev = () => {
        setMenu(null)
        setDevOpen(true)
        selectDev(engineRef.current?.currentView()?.id || 'stand_idle')
      }

      const closeDev = () => {
        setDevOpen(false)
        engineRef.current?.idle()
      }

      const changeDevScale = (value) => {
        const next = Number(value)
        setDevScale(next)
        if (devSelected) engineRef.current?.setTransform(devSelected, { scale: next })
      }

      const changeDevOffset = (value) => {
        const next = Number(value)
        setDevOffset(next)
        if (devSelected) engineRef.current?.setTransform(devSelected, { offset: next })
      }

      const resetDev = () => {
        if (!devSelected) return
        engineRef.current?.resetTransform(devSelected)
        const transform = engineRef.current?.transformOf(devSelected)
        if (transform) {
          setDevScale(transform.scale)
          setDevOffset(transform.offset)
        }
        setDevStatus('已复位为 manifest 值')
      }

      const copyDev = () => {
        const json = JSON.stringify(engineRef.current?.allOverrides() || {}, null, 2)
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(json).then(
            () => setDevStatus('覆盖值已复制，发给我即可回填 manifest'),
            () => setDevStatus(json),
          )
        } else {
          setDevStatus(json)
        }
      }

      const devCatalog = ready ? engineRef.current?.catalog() || [] : []
      const devSelectedLabel = devCatalog.find((item) => item.id === devSelected)?.label
        || devSelected
        || '选择动作'
      const devGroupOf = (item) => {
        if (item.id === 'sit_panic') return 'panic'
        if (item.transition) return 'transition'
        return item.posture === 'stand' ? 'stand' : 'sit'
      }
      const devGroups = [
        { key: 'stand', label: '站姿' },
        { key: 'sit', label: '坐姿' },
        { key: 'transition', label: '过渡（循环预览）' },
        { key: 'panic', label: '慌张' },
      ]

      const balanceValue = balance?.ok
        ? Number(String(balance.balance ?? '').replace(/[^\d.-]/g, ''))
        : Number.NaN
      const balanceColor = !Number.isFinite(balanceValue)
        ? '#8a93a3'
        : balanceValue > 20
          ? '#4ade80'
          : balanceValue >= 8
            ? '#facc15'
            : '#f87171'
      const balanceText = balance?.loading
        ? '…'
        : balance?.ok
          ? `${balance.currency === 'USD' ? '$' : '¥'}${Number.isFinite(balanceValue) ? balanceValue.toFixed(2) : String(balance.balance ?? '--')}`
          : balance?.reason === 'signed-out'
            ? '未登录'
            : balance?.reason === 'account-unavailable'
              ? '不可用'
              : '获取失败'

      const sizeIndex = SIZE_STEPS.reduce((best, value, index) => (
        Math.abs(value - ui.size) < Math.abs(SIZE_STEPS[best] - ui.size) ? index : best
      ), 1)
      const bubbleText = localBubble?.text || bubble

      const menuItem = (label, action, right) => h('button', {
        key: label,
        type: 'button',
        onClick: action,
      }, h('span', null, label), right ? h('span', { className: 'ravenpet-dim' }, right) : null)

      return h('div', { className: 'ravenpet-root', ref: rootRef },
        h('style', null, CSS),
        h('div', {
          className: 'ravenpet-stage',
          ref: stageRef,
          style: {
            left: `${ui.x}px`,
            top: `${ui.y}px`,
            width: `${ui.size}px`,
            height: `${ui.size}px`,
          },
        },
          h('div', {
            className: 'ravenpet-canvas',
            style: { transform: `scale(${ui.size / BASE})` },
          },
            h('video', {
              ref: videoARef,
              className: 'ravenpet-video',
              muted: true,
              playsInline: true,
              preload: 'auto',
              disablePictureInPicture: true,
            }),
            h('video', {
              ref: videoBRef,
              className: 'ravenpet-video',
              muted: true,
              playsInline: true,
              preload: 'auto',
              disablePictureInPicture: true,
            })
          ),
          h('div', {
            className: `ravenpet-bubble${bubbleText ? ' ravenpet-on' : ''}`,
          }, bubbleText || '')
        ),
        menu ? h('div', {
          className: 'ravenpet-menu',
          ref: menuRef,
          style: { left: `${menu.x}px`, top: `${menu.y}px` },
          onPointerDown: (event) => event.stopPropagation(),
        },
          h('div', { className: 'ravenpet-balance' },
            h('span', null, '剩余余额'),
            h('b', { style: { color: balanceColor } }, balanceText)
          ),
          h('div', { className: 'ravenpet-sep' }),
          h('div', { className: 'ravenpet-choice' },
            h('span', null, '大小'),
            h('div', { className: 'ravenpet-seg' },
              SIZE_LABELS.map((label, index) => h('button', {
                key: label,
                type: 'button',
                className: index === sizeIndex ? 'ravenpet-on' : '',
                onClick: () => setPetSize(SIZE_STEPS[index]),
              }, label))
            )
          ),
          h('div', { className: 'ravenpet-choice' },
            h('span', null, '姿态'),
            h('div', { className: 'ravenpet-seg' },
              h('button', {
                type: 'button',
                className: petPosture === 'sit' ? '' : 'ravenpet-on',
                onClick: () => { engineRef.current?.setPosture('stand'); resetRandomTimer() },
              }, '站'),
              h('button', {
                type: 'button',
                className: petPosture === 'sit' ? 'ravenpet-on' : '',
                onClick: () => { engineRef.current?.setPosture('sit'); resetRandomTimer() },
              }, '坐')
            )
          ),
          h('div', { className: 'ravenpet-sep' }),
          menuItem('换一个动作', () => { engineRef.current?.randomNext(); resetRandomTimer(); setMenu(null) }, ''),
          h('div', { className: 'ravenpet-sep' }),
          menuItem('重置位置', resetPosition, ''),
          h('div', {
            className: 'ravenpet-dim',
            style: { padding: '6px 9px 2px', display: 'flex', alignItems: 'center' },
          }, h('span', { className: `ravenpet-dot${connected ? '' : ' ravenpet-off'}` }),
            connected
              ? `AI 活动流 · ${working ? (mode === 'search' ? '查资料' : '工作中') : '待机'}`
              : 'AI 活动流未连接')
        ) : null,
        devOpen ? h('div', {
          className: 'ravenpet-dev',
          onPointerDown: (event) => event.stopPropagation(),
        },
          h('div', { className: 'ravenpet-dev-head' },
            h('span', null, `开发者模式 · ${devSelectedLabel}`),
            h('button', { type: 'button', onClick: closeDev, title: '关闭' }, '×')
          ),
          ready
            ? h('div', { className: 'ravenpet-dev-list' },
                devGroups.map((group) => {
                  const items = devCatalog.filter((item) => devGroupOf(item) === group.key)
                  if (items.length === 0) return null
                  return h('div', { key: group.key },
                    h('div', { className: 'ravenpet-dev-group' }, group.label),
                    items.map((item) => h('button', {
                      key: item.id,
                      type: 'button',
                      className: `ravenpet-dev-act${devSelected === item.id ? ' ravenpet-dev-on' : ''}`,
                      onClick: () => selectDev(item.id),
                    }, item.label))
                  )
                })
              )
            : h('div', { className: 'ravenpet-dev-group' }, '动作加载中…'),
          h('label', { className: 'ravenpet-dev-row' },
            h('span', null, '缩放'),
            h('input', {
              type: 'range',
              min: '0.5',
              max: '1.2',
              step: '0.001',
              value: devScale,
              onChange: (event) => changeDevScale(event.target.value),
            }),
            h('b', null, devScale.toFixed(3))
          ),
          h('label', { className: 'ravenpet-dev-row' },
            h('span', null, '偏移'),
            h('input', {
              type: 'range',
              min: '-100',
              max: '100',
              step: '0.1',
              value: devOffset,
              onChange: (event) => changeDevOffset(event.target.value),
            }),
            h('b', null, devOffset.toFixed(1))
          ),
          h('div', { className: 'ravenpet-dev-actions' },
            h('button', { type: 'button', onClick: resetDev }, '复位'),
            h('button', { type: 'button', onClick: copyDev }, '复制覆盖值'),
            h('button', { type: 'button', onClick: closeDev }, '关闭')
          ),
          devStatus ? h('div', { className: 'ravenpet-dev-status' }, devStatus) : null
        ) : null
      )
    }

    /**
     * Resolve the Session the main view currently owns. The workspace UI
     * publishes that selection through the catalog's `retainedBy.mainView`
     * marker, the page-local "current session" signal.
     */
    function mainViewSessionId(sessions) {
      try {
        const byId = sessions?.list?.getSnapshot?.()?.byId
        if (!byId) return null
        for (const row of Object.values(byId)) {
          if (row && (row.retainedBy?.mainView ?? 0) > 0) return String(row.id)
        }
      } catch {
        // best-effort: a missing catalog only means the pet stays idle
      }
      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'raven-winpet',
          order: 100,
          label: 'Raven 桌宠',
        }, PetOverlay))

        // Tell the host which Session the main view shows, so only that
        // Session's activity drives the pet. Other workspaces/sessions keep
        // running normally and never move it.
        ctx.effect(() => {
          let disposed = false
          let lastReported = null
          const report = () => {
            if (disposed) return
            const sessionId = mainViewSessionId(ctx.get('sessions'))
            // 只在“当前主视图会话”真的变化时上报，避免 1s 轮询打爆宿主。
            if (sessionId === lastReported) return
            lastReported = sessionId
            fetch('/raven-winpet/active-session', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            }).catch(() => {})
          }
          report()
          const retries = [1200, 3000, 6000].map((ms) => setTimeout(report, ms))
          // catalog 的 retainedBy.mainView 更新不一定触发 subscribe；
          // 用低频轮询兜底，保证切换到空闲会话时宿主能收到新的 sessionId 并回到 idle。
          const poll = setInterval(report, 1000)
          const unsubscribe = ctx.get('sessions')?.list?.subscribe?.(report)
          const onVisible = () => {
            if (document.visibilityState === 'visible') report()
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            disposed = true
            clearInterval(poll)
            for (const timer of retries) clearTimeout(timer)
            unsubscribe?.()
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, 'raven-winpet: active session report')
      },
    }
  },
})
