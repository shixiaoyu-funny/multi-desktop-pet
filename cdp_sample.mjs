// 启动后连续采样 6 秒，观察姿态漂移
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const pet = targets.find((t) => t.url.includes('pet.html'))
const main = targets.find((t) => !t.url.includes('pet.html'))

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const events = []
    ws.onopen = () => resolve({ send: (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), events, close: () => ws.close() })
    ws.onerror = reject
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
      else if (m.method) events.push(m)
    }
  })
}
async function ev(c, e) {
  const r = await c.send('Runtime.evaluate', { expression: e, returnByValue: true })
  return r.result && r.result.value
}

const c = await connect(pet.webSocketDebuggerUrl)
const m = await connect(main.webSocketDebuggerUrl)

// 记录 pet 接收到的 pet:action 事件
await c.send('Runtime.evaluate', { expression: "window.__actions=[]; window.__TAURI__.event.listen('pet:action', e => window.__actions.push(e.payload))" })

for (let i = 0; i < 24; i++) {
  const ms = await ev(m, "({g: granular, c: current && current.id})")
  const ps = await ev(c, "({g: granular, c: current && current.id})")
  console.log(`t=${(i * 250) / 1000}s  main=${JSON.stringify(ms)}  pet=${JSON.stringify(ps)}`)
  await new Promise((r) => setTimeout(r, 250))
}

console.log('pet 收到的 actions:', JSON.stringify(await ev(c, 'window.__actions')))
c.close(); m.close(); process.exit(0)
