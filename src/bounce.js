/**
 * 桌宠「弹弹」：脚底钉死，身体按拍子来回挤压 / 拉伸。
 *
 * 端点是满幅度相对 1.0 的偏移只留 20%（力度削弱 80%）：
 *   压扁  scaleX 1.1   scaleY 0.9     （满幅度是 1.5 / 0.5）
 *   弹高  scaleX 0.94  scaleY 1.04    （满幅度是 0.7 / 1.2）
 *
 * 节奏基准是 124 BPM 的半拍（两拍一个来回，1 倍速约 0.97s）。
 * 倍速由主界面滑动条调，默认 2（约 0.48s），步进 0.01。
 * 预览和桌面窗都用 Date.now 走相位，改倍速会一起变。
 *   踩实（扁，停一停）→ 弹起（高）→ 在空中挂一下 → 加速砸回下一脚。
 * shixiaoyu-funny
 */
;(function () {
  var BASE_BPM = 124
  var BEATS = 2
  var SPEED_MIN = 0.5
  var SPEED_MAX = 4
  var SQUASH = [1.1, 0.9]
  var STRETCH = [0.94, 1.04]
  var KEYS = [
    [0.0, SQUASH[0], SQUASH[1]],
    [0.1, SQUASH[0], SQUASH[1]],
    [0.46, STRETCH[0], STRETCH[1]],
    [0.7, STRETCH[0], STRETCH[1]],
    [1.0, SQUASH[0], SQUASH[1]],
  ]
  var STORE = 'duo.bounce'
  var STORE_SPEED = 'duo.bounceSpeed'
  var on = false
  var speed = readSpeed()
  var raf = 0
  var getTargets = null

  function easeOutBack(t) {
    var c1 = 0.5
    var c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  }

  function easeInCubic(t) {
    return t * t * t
  }

  function mixEase(seg, u) {
    if (seg === 1) return easeOutBack(u)
    if (seg === 3) return easeInCubic(u)
    return u
  }

  function sample(t) {
    var i = 0
    while (i < KEYS.length - 2 && t >= KEYS[i + 1][0]) i++
    var a = KEYS[i]
    var b = KEYS[i + 1]
    var span = b[0] - a[0]
    var u = span <= 1e-6 ? 0 : (t - a[0]) / span
    var e = mixEase(i, u)
    return [a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e]
  }

  function clampSpeed(v) {
    var n = Number(v)
    if (!isFinite(n)) return 2
    if (n < SPEED_MIN) return SPEED_MIN
    if (n > SPEED_MAX) return SPEED_MAX
    return Math.round(n * 100) / 100
  }

  function readSpeed() {
    try {
      var raw = localStorage.getItem(STORE_SPEED)
      if (raw == null || raw === '') return 2
      return clampSpeed(raw)
    } catch (e) {
      return 2
    }
  }

  function period() {
    return (60 / (BASE_BPM * speed)) * BEATS
  }

  function phase() {
    var sec = Date.now() / 1000
    var p = period()
    return (sec % p) / p
  }

  function clearEl(el) {
    if (!el || el.dataset.bounce !== '1') return
    el.style.transform = 'none'
    el.style.transformOrigin = ''
    delete el.dataset.bounce
  }

  function tick() {
    raf = requestAnimationFrame(tick)
    var g = getTargets ? getTargets() : null
    if (!g || !g.els) return
    var s = sample(phase())
    var oy = typeof g.originY === 'number' ? g.originY : 0.861
    for (var n = 0; n < g.els.length; n++) {
      var el = g.els[n]
      if (!el) continue
      el.dataset.bounce = '1'
      el.style.transformOrigin = '50% ' + (oy * 100).toFixed(3) + '%'
      el.style.transform = 'scale(' + s[0].toFixed(4) + ',' + s[1].toFixed(4) + ')'
      if (el.style.clipPath) el.style.clipPath = ''
    }
    if (g.onFrame) g.onFrame()
  }

  function start() {
    if (raf) return
    raf = requestAnimationFrame(tick)
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    var g = getTargets ? getTargets() : null
    if (g && g.els) {
      for (var n = 0; n < g.els.length; n++) clearEl(g.els[n])
    }
    if (g && g.onStop) g.onStop()
  }

  window.PetBounce = {
    saved: function () {
      try {
        return localStorage.getItem(STORE) === '1'
      } catch (e) {
        return false
      }
    },
    enabled: function () {
      return on
    },
    speed: function () {
      return speed
    },
    setSpeed: function (next) {
      speed = clampSpeed(next)
      try {
        localStorage.setItem(STORE_SPEED, String(speed))
      } catch (e) {}
      return speed
    },
    bind: function (fn) {
      getTargets = fn
    },
    setEnabled: function (next) {
      on = !!next
      try {
        localStorage.setItem(STORE, on ? '1' : '0')
      } catch (e) {}
      if (on) start()
      else stop()
    },
  }
})()
