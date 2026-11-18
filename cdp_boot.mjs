// 观察启动姿态
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const pet = targets.find((t) => t.url.includes('pet.html'))
const main = targets.find((t) => !t.url.includes('pet.html'))

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send: (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
      close: () => ws.close(),
    })
    ws.onerror = reject
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    }
  })
}
async function ev(c, e) {
  const r = await c.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text }
  return r.result && r.result.value
}

const c = await connect(pet.webSocketDebuggerUrl)
const m = await connect(main.webSocketDebuggerUrl)

console.log('main idleFor(stand) =>', JSON.stringify(await ev(m, "idleFor('stand') && idleFor('stand').id")))
console.log('main idles order =>', JSON.stringify(await ev(m, "idles.map(i=>i.id)")))
console.log('main state =>', JSON.stringify(await ev(m, "({granular, posture, current: current&&current.id})")))
console.log('pet  state =>', JSON.stringify(await ev(c, "({granular, current: current&&current.id, lastIdle})")))
console.log('main history =>', JSON.stringify(await ev(m, "invoke('chat_history', { character: activeChar })")))

c.close(); m.close(); process.exit(0)
