// CDP 运行时验证：pet 窗口拖拽/状态机 + 主窗口
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const pet = targets.find((t) => t.url.includes('pet.html'))
const main = targets.find((t) => !t.url.includes('pet.html'))

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const mid = ++id
        pending.set(mid, res)
        ws.send(JSON.stringify({ id: mid, method, params }))
      }),
      close: () => ws.close(),
    })
    ws.onerror = reject
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result)
        pending.delete(msg.id)
      }
    }
  })
}

async function evalIn(conn, expr) {
  const r = await conn.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  })
  if (r.exceptionDetails) {
    return { __error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }
  }
  return r.result && r.result.value
}

console.log('=== PET WINDOW ===')
const c = await connect(pet.webSocketDebuggerUrl)
await c.send('Runtime.enable')

await evalIn(c, "window.__petErrors=[];window.addEventListener('error',e=>window.__petErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__petErrors.push(String(e.reason)));")
await new Promise((r) => setTimeout(r, 300))

console.log('state:', JSON.stringify(await evalIn(c, "({character, granular, current: current&&current.id, lastIdle, poolSize: pool.length, startDragging: typeof window.__TAURI__.window.getCurrentWindow().startDragging, onMoved: typeof window.__TAURI__.window.getCurrentWindow().onMoved})")))

console.log('transitions:', JSON.stringify(await evalIn(c, "pool.filter(i=>i.transition).map(i=>({id:i.id,from:i.transition.from,to:i.transition.to}))")))
console.log('idles:', JSON.stringify(await evalIn(c, "pool.filter(i=>i.loop===true).map(i=>({id:i.id}))")))

// 找到 stand -> sit_upright 的过渡和一个 sit 待机
const ids = await evalIn(c, "(()=>{const idle=pool.find(i=>i.loop===true&&i.posture==='sit'&&i.sitKind!=='side'&&i.sitKind!=='duck');const trans=pool.find(i=>i.transition&&i.transition.from==='stand'&&i.transition.to==='sit_upright');return {idle:idle&&idle.id,trans:trans&&trans.id}})()")

console.log('--- 触发 站姿 -> 正坐（带过渡） ---')
await evalIn(c, "dispatchAction('" + ids.idle + "', true, '" + ids.trans + "')")
console.log('immediately:', JSON.stringify(await evalIn(c, "current&&current.id")))
await new Promise((r) => setTimeout(r, 1200))
console.log('after 1.2s (应还在过渡):', JSON.stringify(await evalIn(c, "({current:current&&current.id,granular})")))
await new Promise((r) => setTimeout(r, 2500))
console.log('after 3.7s (应到目标待机):', JSON.stringify(await evalIn(c, "({current:current&&current.id,granular})")))

console.log('--- 直切 正坐 -> 侧坐（无过渡） ---')
const side = await evalIn(c, "(pool.find(i=>i.loop===true&&i.sitKind==='side')||{}).id||null")
await evalIn(c, "dispatchAction('" + side + "', true, null)")
console.log('immediately:', JSON.stringify(await evalIn(c, "current&&current.id")))

console.log('pet runtime errors:', JSON.stringify(await evalIn(c, 'window.__petErrors')))

console.log('')
console.log('=== MAIN WINDOW ===')
const m = await connect(main.webSocketDebuggerUrl)
await m.send('Runtime.enable')
console.log('state:', JSON.stringify(await evalIn(m, "({activeChar, granular, posture, current: current&&current.id, findTransition: typeof findTransition})")))

c.close(); m.close(); process.exit(0)
