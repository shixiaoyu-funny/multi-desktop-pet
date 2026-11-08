/**
 * Raven pet — host half.
 *
 * Serves the WebM action assets from the original Tauri project (or a packaged
 * `assets/` directory) and projects Session activity into one coarse `phase`
 * stream consumed by the browser half over SSE.
 *
 * The DSH plugin asset route only serves images, so video needs this route.
 */

import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'raven-winpet'

/** The activity surface needs the browser HTTP carrier. */
export const inject = ['webServer']

const PREFIX = '/raven-winpet'
const ASSET_PREFIX = `${PREFIX}/assets`
const ACTIVITY_PATH = `${PREFIX}/activity`
const STREAM_PATH = `${PREFIX}/activity/stream`
const ACTIVE_PATH = `${PREFIX}/active-session`
const BALANCE_PATH = `${PREFIX}/balance`

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Packaged layout first; otherwise the Tauri project next door. */
const ASSET_ROOTS = [
  path.join(PLUGIN_DIR, 'assets'),
  path.join(PLUGIN_DIR, '..', 'src', 'assets'),
]

const MIME = {
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
}

/** Tools that read as "查资料" (book) instead of the generic working pose. */
const SEARCH_TOOL = /(^|[_\-.])(web|search|fetch|browse|lookup|query)/i

/** One working pose for every non-search activity; search switches to the book. */
const WORK_ACTION = 'stand_phone'
const SEARCH_ACTION = 'stand_book'
/** One-shot mood actions after a turn settles. */
const DONE_ACTION = 'stand_hair'
const FAIL_ACTION = 'stand_angry'
const WORK_LINE = '工作中…'
const SEARCH_LINE = '查资料…'

/** Root asset directory, resolved once per activation. */
function resolveAssetRoot() {
  for (const root of ASSET_ROOTS) {
    try {
      if (statSync(root).isDirectory()) return root
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function decodePath(url) {
  try {
    const pathname = new URL(url ?? '/', 'http://localhost').pathname
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

function serveAsset(req, res, root) {
  if (!isLoopback(req)) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const pathname = decodePath(req.url)
  if (pathname === undefined || (pathname !== ASSET_PREFIX && !pathname.startsWith(ASSET_PREFIX + '/'))) {
    res.writeHead(404).end()
    return
  }
  const rel = pathname.slice(ASSET_PREFIX.length).replace(/^\/+/, '')
  const extension = path.extname(rel).toLowerCase()
  if (!rel || !Object.hasOwn(MIME, extension) || rel.includes('\0')) {
    res.writeHead(404).end()
    return
  }
  const resolved = path.resolve(root, rel)
  if (!resolved.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden')
    return
  }

  let stat
  try {
    stat = statSync(resolved)
  } catch {
    res.writeHead(404).end()
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404).end()
    return
  }

  const total = stat.size
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', MIME[extension])
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': total })
    res.end()
    return
  }

  const range = req.headers.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }
    let start
    let end
    if (match[1] === '') {
      const suffix = Number(match[2])
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` })
        res.end()
        return
      }
      start = Math.max(0, total - suffix)
      end = total - 1
    } else {
      start = Number(match[1])
      end = match[2] === '' ? total - 1 : Number(match[2])
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }
    end = Math.min(end, total - 1)
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    })
    createReadStream(resolved, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { 'Content-Length': total })
  createReadStream(resolved).pipe(res)
}

/** Coarse activity state broadcast to every connected page. */
function createActivity() {
  const clients = new Set()
  let current = { phase: 'idle', mode: null, action: null, tool: null, line: null, sessionId: null, once: false, at: 0 }

  const write = (res, payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      clients.delete(res)
    }
  }

  const publish = (next) => {
    const changed = next.phase !== current.phase
      || next.mode !== current.mode
      || next.tool !== current.tool
      || next.line !== current.line
      || next.action !== current.action
      || next.once !== current.once
    current = { ...next, at: Date.now() }
    if (!changed) return
    for (const res of [...clients]) write(res, current)
  }

  const add = (res) => {
    clients.add(res)
    write(res, current)
    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clients.delete(res)
      }
    }, 15_000)
    res.on('close', () => {
      clearInterval(timer)
      clients.delete(res)
    })
  }

  const closeAll = () => {
    for (const res of [...clients]) {
      try {
        res.end()
      } catch {
        // already gone
      }
    }
    clients.clear()
  }

  return { publish, add, closeAll, current: () => current }
}

/** Project the official Session vocabulary into one global phase. */
function createProjector(activity) {
  const sessions = new Map()
  let display
  let activeSessionId = null

  const runtimeOf = (session) => {
    let runtime = sessions.get(session)
    if (runtime === undefined) {
      runtime = { activeTools: new Set(), failed: false, phase: 'idle', mode: null, tool: null }
      sessions.set(session, runtime)
    }
    return runtime
  }

  const publishWorking = (session, { search = false, tool = null } = {}) => {
    display = session
    const runtime = runtimeOf(session)
    runtime.phase = 'working'
    runtime.mode = search ? 'search' : 'work'
    runtime.tool = tool
    activity.publish({
      phase: 'working',
      sessionId: String(session.id),
      mode: runtime.mode,
      action: search ? SEARCH_ACTION : WORK_ACTION,
      tool,
      line: search ? SEARCH_LINE : WORK_LINE,
      once: false,
    })
  }

  const publishIdle = (session, line = null) => {
    display = session
    const runtime = runtimeOf(session)
    runtime.phase = 'idle'
    runtime.mode = null
    runtime.tool = null
    activity.publish({ phase: 'idle', sessionId: String(session.id), mode: null, action: null, tool: null, line, once: false })
  }

  const publishDone = (session) => {
    display = session
    const runtime = runtimeOf(session)
    runtime.phase = 'done'
    runtime.mode = null
    runtime.tool = null
    activity.publish({
      phase: 'done',
      sessionId: String(session.id),
      mode: null,
      action: DONE_ACTION,
      tool: null,
      line: '搞定！',
      once: true,
    })
  }

  const publishFailed = (session) => {
    display = session
    const runtime = runtimeOf(session)
    runtime.phase = 'failed'
    runtime.mode = null
    runtime.tool = null
    activity.publish({
      phase: 'failed',
      sessionId: String(session.id),
      mode: null,
      action: FAIL_ACTION,
      tool: null,
      line: '出错了…',
      once: true,
    })
  }

  const setActiveSession = (id) => {
    if (id === activeSessionId) return
    activeSessionId = id
    display = undefined
    sessions.clear()
    activity.publish({ phase: 'idle', sessionId: id, mode: null, action: null, tool: null, line: null, once: false })
  }

  const ignored = (session) => session?.header?.origin === 'subagent'

  const onSessionEvent = (session, event) => {
    if (ignored(session)) return
    if (activeSessionId === null || String(session.id) !== activeSessionId) return
    const runtime = runtimeOf(session)
    switch (event.type) {
      case 'turn/start':
        runtime.activeTools.clear()
        runtime.failed = false
        runtime.mode = 'work'
        publishWorking(session)
        break
      case 'step/start':
        runtime.activeTools.clear()
        runtime.failed = false
        runtime.mode = 'work'
        publishWorking(session)
        break
      case 'assistant/message':
        publishWorking(session, { search: runtime.mode === 'search' })
        break
      case 'tool/call': {
        runtime.activeTools.add(String(event.data.callId))
        const search = SEARCH_TOOL.test(String(event.data.name ?? ''))
        runtime.mode = search ? 'search' : 'work'
        publishWorking(session, { search, tool: event.data.name })
        break
      }
      case 'tool/result': {
        const callId = String(event.data.message?.toolCallId)
        runtime.activeTools.delete(callId)
        const failed = event.data.error !== undefined || event.data.message?.isError === true
        runtime.failed ||= failed
        if (runtime.activeTools.size > 0) {
          publishWorking(session, { search: runtime.mode === 'search' })
        } else if (runtime.failed) {
          publishFailed(session)
        } else {
          publishWorking(session, { search: runtime.mode === 'search' })
        }
        break
      }
      case 'turn/end': {
        runtime.activeTools.clear()
        switch (event.data.reason?.kind) {
          case 'completed':
            publishDone(session)
            break
          case 'error':
          case 'max-tokens':
          case 'interrupted':
            publishFailed(session)
            break
          case 'blocked':
            publishWorking(session)
            break
          default:
            publishIdle(session)
            break
        }
        runtime.failed = false
        runtime.mode = null
        break
      }
      default:
        break
    }
  }

  const onAssistantStream = ({ agent, frame }) => {
    const session = agent?.session
    if (session === undefined || ignored(session)) return
    if (activeSessionId === null || String(session.id) !== activeSessionId) return
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type !== 'reasoning-delta' && chunk?.type !== 'text-delta') return
    if (!chunk.text || chunk.text.length === 0) return
    const runtime = runtimeOf(session)
    if (runtime.phase !== 'working') {
      publishWorking(session, { search: runtime.mode === 'search' })
    }
  }

  const onDisposed = (session) => {
    sessions.delete(session)
    if (activeSessionId !== null && String(session.id) === activeSessionId) {
      activeSessionId = null
      display = undefined
      activity.publish({ phase: 'idle', sessionId: null, mode: null, action: null, tool: null, line: null, once: false })
      return
    }
    if (display !== session) return
    display = undefined
    const remaining = [...sessions.keys()].at(-1)
    if (remaining === undefined) {
      activity.publish({ phase: 'idle', mode: null, action: null, tool: null, line: null, once: false })
      return
    }
    const runtime = sessions.get(remaining)
    if (runtime.phase === 'working') {
      publishWorking(remaining, { search: runtime.mode === 'search', tool: runtime.tool })
    } else if (runtime.phase === 'failed') {
      publishFailed(remaining)
    } else if (runtime.phase === 'done') {
      publishDone(remaining)
    } else {
      publishIdle(remaining)
    }
  }

  return {
    onSessionEvent,
    onAssistantStream,
    onDisposed,
    setActiveSession,
    activeSessionId: () => activeSessionId,
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Small bounded JSON reader for the active-session report. */
async function readJsonBody(req, limit = 4096) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const root = resolveAssetRoot()
  const activity = createActivity()
  const projector = createProjector(activity)

  ctx.effect(() => {
    const offAsset = ctx.webServer.register({
      kind: 'prefix',
      path: ASSET_PREFIX,
      handler: (req, res) => {
        if (root === undefined) {
          res.writeHead(503).end('Raven pet assets not found')
          return
        }
        serveAsset(req, res, root)
      },
    })

    const offActivity = ctx.webServer.register({
      kind: 'exact',
      path: ACTIVITY_PATH,
      handler: (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403).end('forbidden')
          return
        }
        const snapshot = activity.current()
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end()
          return
        }
        sendJson(res, 200, snapshot)
      },
    })

    const offStream = ctx.webServer.register({
      kind: 'exact',
      path: STREAM_PATH,
      handler: (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403).end('forbidden')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 2000\n\n')
        activity.add(res)
      },
    })

    const offActive = ctx.webServer.register({
      kind: 'exact',
      path: ACTIVE_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403).end('forbidden')
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { sessionId: projector.activeSessionId() })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' }).end()
          return
        }
        const body = await readJsonBody(req)
        const raw = body !== null && typeof body === 'object' ? body.sessionId : undefined
        if (raw !== null && typeof raw !== 'string') {
          res.writeHead(400).end('bad sessionId')
          return
        }
        const id = raw === null || raw === '' ? null : raw
        if (id !== null && !/^[\w.:-]{1,128}$/.test(id)) {
          res.writeHead(400).end('bad sessionId')
          return
        }
        projector.setActiveSession(id)
        res.writeHead(204).end()
      },
    })

    const offBalance = ctx.webServer.register({
      kind: 'exact',
      path: BALANCE_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403).end('forbidden')
          return
        }
        const account = ctx.get('deepseekAccount')
        if (account === undefined) {
          sendJson(res, 200, { ok: false, reason: 'account-unavailable' })
          return
        }
        try {
          const state = await account.getState()
          if (state?.status !== 'credential-stored') {
            sendJson(res, 200, { ok: false, reason: 'signed-out' })
            return
          }
          const details = await account.getBalance({
            version: process.env.DSH_VERSION ?? '0.2.2-rc.1',
            locale: 'zh-CN',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          })
          if (details === null) {
            sendJson(res, 200, { ok: false, reason: 'signed-out' })
            return
          }
          if (details.status !== 'ready') {
            sendJson(res, 200, { ok: false, reason: 'balance-failed' })
            return
          }
          const wallets = Array.isArray(details.value) ? details.value : []
          const bonusWallets = Array.isArray(details.bonusWallets) ? details.bonusWallets : []
          const wallet = wallets.find((entry) => entry.currency === 'CNY') ?? wallets[0]
          if (wallet === undefined) {
            sendJson(res, 200, { ok: false, reason: 'no-wallet' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            currency: wallet.currency,
            balance: wallet.balance,
            wallets,
            bonusWallets,
          })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            reason: 'error',
            message: String(error?.message ?? error),
          })
        }
      },
    })

    const offSession = ctx.on('session/event', (session, event) => {
      projector.onSessionEvent(session, event)
    })
    const offStreamEvents = ctx.on('agent/assistant-stream', (payload) => {
      projector.onAssistantStream(payload)
    })
    const offDisposed = ctx.on('session/disposed', (session) => {
      projector.onDisposed(session)
    })

    console.log(`[raven-pet] assets: ${root ?? '(missing)'}`)

    return () => {
      offAsset()
      offActivity()
      offStream()
      offActive()
      offBalance()
      offSession()
      offStreamEvents()
      offDisposed()
      activity.closeAll()
    }
  }, 'raven-winpet: routes and session projection')
}
