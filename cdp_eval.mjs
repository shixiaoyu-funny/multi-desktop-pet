// 临时 CDP 调试脚本：连接应用 WebView，执行 JS 并打印结果
const targets = await (await fetch('http://localhost:9222/json/list')).json()
const arg = process.argv[2]
const expr = process.argv.slice(3).join(' ')

function pick() {
  if (arg === 'pet') return targets.find((t) => t.url.includes('pet.html'))
  if (arg === 'main') return targets.find((t) => t.url.endsWith('/') || t.url.endsWith('/index.html'))
  return targets.find((t) => t.id === arg) || targets[0]
}

const target = pick()
if (!target) { console.error('no target'); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }))

ws.onopen = () => {
  send(1, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id === 1) {
    const r = m.result && m.result.result
    if (r && r.subtype === 'error') console.error('ERR:', JSON.stringify(r))
    else console.log('OK:', JSON.stringify(r && r.value !== undefined ? r.value : r, null, 2))
    ws.close()
    process.exit(0)
  }
}
ws.onerror = (e) => { console.error('WS error', e.message); process.exit(1) }
setTimeout(() => { console.error('timeout'); process.exit(1) }, 8000)
