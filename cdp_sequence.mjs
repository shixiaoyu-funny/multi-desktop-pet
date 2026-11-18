// 观察桌宠状态机：先切回站姿，再切到侧坐，记录 current 随时间的变化序列
const targets = await (await fetch('http://localhost:9222/json/list')).json()
const main = targets.find((t) => t.url.endsWith('/'))
const pet = targets.find((t) => t.url.includes('pet.html'))

function conn(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  let idc = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const ev = (method, params) => new Promise((res, rej) => { const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
  return new Promise((res) => { ws.onopen = () => res({ ws, ev }) })
}

const { ev: mainEv } = await conn(main)
const { ev: petEv } = await conn(pet)

const petState = async () => {
  const m = await petEv('Runtime.evaluate', { expression: `({current: current && current.id, granular, lastIdle, switching})`, returnByValue: true })
  return m.result.result.value
}

// 1) 切回站姿（sit_upright -> stand 应播 trans_upright_to_stand）
console.log('初始:', await petState())
await mainEv('Runtime.evaluate', { expression: `window.__TAURI__.event.emit('pet:action', {character:'raven', action:'stand_flower', loop:true, transition:'trans_upright_to_stand'})`, returnByValue: true })

const seq = []
for (let i = 0; i < 14; i++) {
  await new Promise((r) => setTimeout(r, 150))
  const s = await petState()
  const key = `${s.current}|${s.granular}`
  if (seq[seq.length - 1] !== key) seq.push(key)
}
console.log('站姿切换序列:', seq.join('  ->  '))

// 2) 再切侧坐（stand -> sit_side 应播 trans_stand_to_side）
await mainEv('Runtime.evaluate', { expression: `window.__TAURI__.event.emit('pet:action', {character:'raven', action:'sit_lean', loop:true, transition:'trans_stand_to_side'})`, returnByValue: true })
const seq2 = []
for (let i = 0; i < 14; i++) {
  await new Promise((r) => setTimeout(r, 150))
  const s = await petState()
  const key = `${s.current}|${s.granular}`
  if (seq2[seq2.length - 1] !== key) seq2.push(key)
}
console.log('侧坐切换序列:', seq2.join('  ->  '))

process.exit(0)
