const { invoke } = window.__TAURI__.core
const { getCurrentWindow } = window.__TAURI__.window
const $ = (sel) => document.querySelector(sel)

const stateEl = $('#state')
let checking = false

$('#openConsole').addEventListener('click', () => {
  invoke('open_url', { url: 'https://bailian.console.aliyun.com/?apiKey=1' }).catch(() => {})
})

$('#recheck').addEventListener('click', check)
$('#close').addEventListener('click', () => {
  getCurrentWindow().close().catch(() => {})
})

check()

async function check() {
  if (checking) return
  checking = true
  stateEl.classList.remove('ok')
  stateEl.textContent = '正在检测环境变量…'
  try {
    const status = await invoke('chat_status')
    if (status.configured) {
      stateEl.classList.add('ok')
      stateEl.textContent = `已检测到 ${status.env}，正在打开聊天窗口…`
      await invoke('open_chat')
      setTimeout(() => { getCurrentWindow().close().catch(() => {}) }, 350)
    } else {
      stateEl.textContent = `还没有检测到 ${status.env}。设置后请先退出并重新打开桌宠，再点“重新检测”。`
    }
  } catch (error) {
    stateEl.textContent = `检测失败：${error}`
  } finally {
    checking = false
  }
}
