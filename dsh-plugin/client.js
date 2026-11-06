/**
 * role2 pet — client half.
 *
 * Renders the pet inside `shell.overlay`. The layer is click-through, so only
 * the pet's own box opts back into pointer events. Action playback mirrors the
 * Tauri front end (two cross-faded <video> layers) without any Tauri calls.
 */

window.__ModuleLoader__.load({
  id: '@local/role2-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const ASSET_BASE = '/role2-pet/assets'
    const STREAM_URL = '/role2-pet/activity/stream'
    const STORE_KEY = 'role2pet.v1'
    const FADE_MS = 320
    /** The action manifest's scale/offset are authored against this canvas. */
    const BASE = 1024
    const SIZES = { large: 512, medium: 384, small: 288 }
    const TRANSITIONS = {
      'stand>sit_upright': 'trans_stand_to_upright',
      'stand>sit_side': 'trans_stand_to_side',
      'sit_upright>stand': 'trans_upright_to_stand',
      'sit_side>stand': 'trans_side_to_stand',
      'sit_side>sit_upright': 'trans_side_to_upright',
      'sit_upright>sit_side': 'trans_upright_to_side',
    }

    const CSS = `
      .role2pet-root{position:fixed;inset:0;pointer-events:none;z-index:9999;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      .role2pet-stage{position:absolute;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
      .role2pet-stage:active{cursor:grabbing}
      .role2pet-canvas{position:absolute;left:0;top:0;width:${BASE}px;height:${BASE}px;transform-origin:top left;pointer-events:none}
      .role2pet-video{position:absolute;left:50%;top:50%;object-fit:contain;opacity:0;transition:opacity ${FADE_MS}ms ease;pointer-events:none;background:transparent}
      .role2pet-video.role2pet-on{opacity:1}
      .role2pet-bubble{position:absolute;left:50%;bottom:calc(100% - 28px);transform:translateX(-50%);max-width:260px;padding:7px 11px;border-radius:12px;background:rgba(255,255,255,.94);color:#2b2f36;font-size:12px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none;opacity:0;transition:opacity 180ms ease}
      .role2pet-bubble.role2pet-on{opacity:1}
      .role2pet-bubble:after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(255,255,255,.94)}
      .role2pet-menu{position:fixed;min-width:168px;padding:6px;border-radius:10px;background:#20242c;color:#e8eaf0;box-shadow:0 12px 32px rgba(0,0,0,.35);pointer-events:auto;font-size:12px}
      .role2pet-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:7px 9px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .role2pet-menu button:hover{background:rgba(255,255,255,.1)}
      .role2pet-menu .role2pet-sep{height:1px;margin:5px 4px;background:rgba(255,255,255,.12)}
      .role2pet-menu .role2pet-dim{color:#9aa3b2}
      .role2pet-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#5ad08a;margin-right:6px}
      .role2pet-dot.role2pet-off{background:#8a93a3}
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
      const size = SIZES[saved.size] ? SIZES[saved.size] : SIZES.medium
      const maxX = Math.max(8, window.innerWidth - size - 8)
      const maxY = Math.max(8, window.innerHeight - size - 8)
      return {
        sizeKey: SIZES[saved.size] ? saved.size : 'medium',
        size,
        x: Number.isFinite(saved.x) ? clamp(saved.x, 0, maxX) : Math.max(16, maxX - 24),
        y: Number.isFinite(saved.y) ? clamp(saved.y, 0, maxY) : Math.max(16, maxY - 40),
        random: saved.random !== false,
        interval: Number(saved.interval) || 30,
        react: saved.react !== false,
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
      let current = null
      let front = 0
      let granular = 'stand'
      let posture = 'stand'
      let destroyed = false
      let token = 0
      let busy = false

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
        const scale = Number(item.scale) || 1
        const offset = Number(item.offset) || 0
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
        nxt.classList.remove('role2pet-on')
        applyLayerStyle(nxt, item)
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
          nxt.classList.add('role2pet-on')
          cur.classList.remove('role2pet-on')
          front = 1 - front
          const previous = cur
          setTimeout(() => {
            if (destroyed || previous === layers[front]) return
            previous.pause()
            previous.removeAttribute('src')
            previous.load()
          }, FADE_MS + 120)
          current = item
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
        const to = granularOf(item)
        if (to === granular) {
          granular = to
          posture = postureOf(item)
          play(item, { loop: true })
          return
        }
        const transition = findTransition(granular, to)
        granular = to
        posture = postureOf(item)
        if (!transition) {
          play(item, { loop: true, force: true })
          return
        }
        busy = true
        setTimeout(() => { busy = false }, 4000)
        play(transition, {
          force: true,
          loop: false,
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
        const first = playable.find((item) => item.id === manifest.defaultAction) || playable[0]
        if (!first) throw new Error('empty action pool')
        granular = granularOf(first)
        posture = postureOf(first)
        await play(first, { loop: true, force: true })
        hooks.onReady?.(manifest)
      }

      function setPosture(want) {
        if (want === posture) return
        const target = want === 'sit'
          ? pick(playable.filter((item) => postureOf(item) === 'sit'))
          : pickFor('stand')
        if (target) switchTo(target)
      }

      /** Idle behavior: rotate through every idle posture (stand / sit / side-sit). */
      function randomNext() {
        if (busy || destroyed) return
        const others = playable.filter((item) => !current || item.id !== current.id)
        const target = pick(others.length ? others : playable)
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
       * idle timer rotate the normal poses. */
      function idle() {
        if (destroyed) return
        if (current && (current.id === 'stand_phone' || current.id === 'stand_book')) randomNext()
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

      return { init, play, switchTo, setPosture, randomNext, work, idle, state, destroy }
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

      const uiRef = useRef(ui)
      const reactRef = useRef(ui.react)
      const workingRef = useRef(false)
      const dragRef = useRef(null)
      const menuRef = useRef(null)
      const rootRef = useRef(null)
      const videoARef = useRef(null)
      const videoBRef = useRef(null)
      const engineRef = useRef(null)
      const bubbleTimerRef = useRef(null)
      const activityRef = useRef(null)

      uiRef.current = ui
      reactRef.current = ui.react

      useEffect(() => {
        const engine = createEngine(videoARef.current, videoBRef.current, {
          onReady: () => setReady(true),
        })
        engineRef.current = engine
        engine.init().catch((error) => {
          console.error('[role2-pet] init failed', error)
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
            size: ui.sizeKey,
            x: Math.round(ui.x),
            y: Math.round(ui.y),
            random: ui.random,
            interval: ui.interval,
            react: ui.react,
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

      // Idle rotation: every idle posture, every 30s, paused while working.
      useEffect(() => {
        if (!ui.random || !ready || working) return undefined
        const timer = setInterval(() => engineRef.current?.randomNext(), Math.max(5, ui.interval) * 1000)
        return () => clearInterval(timer)
      }, [ui.random, ui.interval, ready, working])

      // Activity subscription.
      useEffect(() => {
        let source
        let retry
        const apply = (payload) => {
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
          if (nextPhase === 'failed') {
            setWorking(false)
            setMode(null)
            workingRef.current = false
            engineRef.current?.idle()
            return
          }
          setWorking(true)
          setMode(payload.mode || 'work')
          workingRef.current = true
          engineRef.current?.work(payload.mode === 'search')
        }
        activityRef.current = apply
        const connect = () => {
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
            // EventSource reconnects by itself; this only reflects the state.
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
        const maxX = Math.max(0, window.innerWidth - next.size - 4)
        const maxY = Math.max(0, window.innerHeight - next.size - 4)
        return { ...next, x: clamp(next.x, 0, maxX), y: clamp(next.y, 0, maxY) }
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        setMenu(null)
        dragRef.current = {
          pointerId: event.pointerId,
          dx: event.clientX - uiRef.current.x,
          dy: event.clientY - uiRef.current.y,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        setUi((previous) => clampInside({
          ...previous,
          x: event.clientX - drag.dx,
          y: event.clientY - drag.dy,
        }))
      }

      const onPointerUp = (event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
      }

      const onContextMenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({
          x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 190)),
          y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 260)),
        })
      }

      const setSize = (sizeKey) => {
        const size = SIZES[sizeKey]
        setUi((previous) => clampInside({ ...previous, sizeKey, size }))
        setMenu(null)
      }

      const resetPosition = () => {
        setUi((previous) => clampInside({
          ...previous,
          x: window.innerWidth - previous.size - 32,
          y: window.innerHeight - previous.size - 44,
        }))
        setMenu(null)
      }

      const toggleReact = () => {
        setUi((previous) => ({ ...previous, react: !previous.react }))
        setMenu(null)
      }

      const toggleRandom = () => {
        setUi((previous) => ({ ...previous, random: !previous.random }))
        setMenu(null)
      }

      const menuItem = (label, action, right) => h('button', {
        key: label,
        type: 'button',
        onClick: action,
      }, h('span', null, label), right ? h('span', { className: 'role2pet-dim' }, right) : null)

      return h('div', { className: 'role2pet-root', ref: rootRef },
        h('style', null, CSS),
        h('div', {
          className: 'role2pet-stage',
          style: {
            left: `${ui.x}px`,
            top: `${ui.y}px`,
            width: `${ui.size}px`,
            height: `${ui.size}px`,
          },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onContextMenu,
        },
          h('div', {
            className: 'role2pet-canvas',
            style: { transform: `scale(${ui.size / BASE})` },
          },
            h('video', {
              ref: videoARef,
              className: 'role2pet-video',
              muted: true,
              playsInline: true,
              preload: 'auto',
              disablePictureInPicture: true,
            }),
            h('video', {
              ref: videoBRef,
              className: 'role2pet-video',
              muted: true,
              playsInline: true,
              preload: 'auto',
              disablePictureInPicture: true,
            })
          ),
          h('div', {
            className: `role2pet-bubble${bubble ? ' role2pet-on' : ''}`,
          }, bubble || '')
        ),
        menu ? h('div', {
          className: 'role2pet-menu',
          ref: menuRef,
          style: { left: `${menu.x}px`, top: `${menu.y}px` },
          onPointerDown: (event) => event.stopPropagation(),
        },
          menuItem('大', () => setSize('large'), ui.sizeKey === 'large' ? '✓' : ''),
          menuItem('中', () => setSize('medium'), ui.sizeKey === 'medium' ? '✓' : ''),
          menuItem('小', () => setSize('small'), ui.sizeKey === 'small' ? '✓' : ''),
          h('div', { className: 'role2pet-sep' }),
          menuItem('坐下', () => { engineRef.current?.setPosture('sit'); setMenu(null) }, ''),
          menuItem('站起', () => { engineRef.current?.setPosture('stand'); setMenu(null) }, ''),
          menuItem('换一个动作', () => { engineRef.current?.randomNext(); setMenu(null) }, ''),
          menuItem('随机切换', toggleRandom, ui.random ? '开' : '关'),
          menuItem('响应 AI', toggleReact, ui.react ? '开' : '关'),
          h('div', { className: 'role2pet-sep' }),
          menuItem('重置位置', resetPosition, ''),
          h('div', {
            className: 'role2pet-dim',
            style: { padding: '6px 9px 2px', display: 'flex', alignItems: 'center' },
          }, h('span', { className: `role2pet-dot${connected ? '' : ' role2pet-off'}` }),
            connected
              ? `已连接 · ${working ? (mode === 'search' ? '查资料' : '工作中') : '待机'}`
              : '未连接')
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
          id: 'role2-pet',
          order: 100,
          label: 'role2 桌宠',
        }, PetOverlay))

        // Tell the host which Session the main view shows, so only that
        // Session's activity drives the pet. Other workspaces/sessions keep
        // running normally and never move it.
        ctx.effect(() => {
          let disposed = false
          const report = () => {
            if (disposed) return
            const sessionId = mainViewSessionId(ctx.get('sessions'))
            fetch('/role2-pet/active-session', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            }).catch(() => {})
          }
          report()
          const retries = [1200, 3000, 6000].map((ms) => setTimeout(report, ms))
          const unsubscribe = ctx.get('sessions')?.list?.subscribe?.(report)
          const onVisible = () => {
            if (document.visibilityState === 'visible') report()
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            disposed = true
            for (const timer of retries) clearTimeout(timer)
            unsubscribe?.()
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, 'role2-pet: active session report')
      },
    }
  },
})
