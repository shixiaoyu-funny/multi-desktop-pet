const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const $ = (sel) => document.querySelector(sel)
const messagesEl = $('#messages')
const inputEl = $('#input')
const sendEl = $('#send')
const statusEl = $('#status')

let keyOk = false
let busy = false
let currentEl = null
let streamingText = ''

boot()

async function boot() {
  bind()
  await refreshStatus()
  await loadHistory()
}

function bind() {
  safeListen('chat:delta', (event) => {
    const text = event.payload && event.payload.text
    if (typeof text !== 'string') return
    streamingText = text
    if (!currentEl) currentEl = addMessage('assistant', '', true)
    setText(currentEl, text)
    currentEl.classList.add('streaming')
    scroll()
  })

  safeListen('chat:tool', (event) => {
    const payload = event.payload || {}
    if (payload.status === 'running') {
      statusEl.textContent = `正在使用 ${payload.name}…`
      if (currentEl) currentEl.classList.add('streaming')
    } else {
      statusEl.textContent = '继续思考…'
    }
  })

  safeListen('chat:retry', (event) => {
    const payload = event.payload || {}
    if (currentEl) {
      currentEl.classList.add('streaming')
      setText(currentEl, '')
    }
    statusEl.textContent = '思考中'
  })

  safeListen('chat:final', (event) => {
    const payload = event.payload || {}
    if (!currentEl) currentEl = addMessage('assistant', '', true)
    currentEl.classList.remove('streaming')
    setText(currentEl, payload.reply || '……')
    if (payload.action) {
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = `动作 · ${payload.action}`
      currentEl.appendChild(meta)
    }
    currentEl = null
    streamingText = ''
    setBusy(false)
    scroll()
  })

  safeListen('chat:error', (event) => {
    const payload = event.payload || {}
    if (!currentEl) currentEl = addMessage('assistant', '', true)
    currentEl.classList.remove('streaming')
    currentEl.classList.add('error')
    setText(currentEl, payload.message || '请求失败')
    currentEl = null
    setBusy(false)
    if (payload.needSetup || /401|403|InvalidApiKey|invalid.*key/i.test(String(payload.message || ''))) {
      invoke('open_chat_setup').catch(() => {})
    }
    scroll()
  })

  safeListen('chat:ready', () => {
    if (busy) setBusy(false)
  })

  $('#btnSetup').addEventListener('click', () => {
    invoke('open_chat_setup').catch(() => {})
  })

  $('#btnClear').addEventListener('click', () => {
    if (busy) return
    openClearConfirm()
  })

  $('#confirmCancel').addEventListener('click', closeClearConfirm)
  $('#confirmOk').addEventListener('click', advanceClearConfirm)
  $('#clearConfirm').addEventListener('click', (event) => {
    if (event.target === $('#clearConfirm')) closeClearConfirm()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#clearConfirm').classList.contains('hidden')) {
      closeClearConfirm()
    }
  })

  sendEl.addEventListener('click', send)
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })

  window.addEventListener('focus', () => { refreshStatus() })
}

async function refreshStatus() {
  try {
    const status = await invoke('chat_status')
    keyOk = !!status.configured
    const posture = status.posture === 'sit_side' ? '侧坐' : status.posture === 'sit_upright' ? '正坐' : '站姿'
    statusEl.textContent = keyOk
      ? `${status.model} · ${posture}`
      : `未配置 ${status.env || 'DASHSCOPE_API_KEY'}`
    inputEl.disabled = busy || !keyOk
    sendEl.disabled = !keyOk || busy
    if (!keyOk) showNotice()
  } catch (error) {
    statusEl.textContent = '无法连接桌宠'
    console.warn('[chat] status failed', error)
  }
}

function showNotice() {
  if (document.querySelector('.notice')) return
  const notice = document.createElement('div')
  notice.className = 'notice'
  notice.textContent = '还没有配置 DashScope API Key，Raven 暂时不能聊天。'
  const button = document.createElement('button')
  button.textContent = '查看配置方法'
  button.addEventListener('click', () => invoke('open_chat_setup').catch(() => {}))
  notice.appendChild(document.createElement('br'))
  notice.appendChild(button)
  messagesEl.prepend(notice)
}

async function loadHistory() {
  try {
    const data = await invoke('chat_history')
    const messages = (data && data.messages) || []
    if (messages.length) {
      for (const message of messages) {
        if (message.role === 'user' || message.role === 'assistant') {
          addMessage(message.role, message.content)
        }
      }
      scroll()
    } else {
      addMessage('assistant', '终于想起找我了？……说吧，什么事。')
    }
    if (data && data.busy) {
      setBusy(true)
      currentEl = addMessage('assistant', '……还在想上一句。', true)
    }
  } catch (error) {
    addMessage('assistant', '读取会话记录失败。')
    console.warn('[chat] history failed', error)
  }
}

async function send() {
  const text = inputEl.value.trim()
  if (!text || busy) return
  if (!keyOk) {
    invoke('open_chat_setup').catch(() => {})
    return
  }
  addMessage('user', text)
  inputEl.value = ''
  currentEl = addMessage('assistant', '', true)
  streamingText = ''
  setBusy(true)
  scroll()
  try {
    await invoke('chat_send', { text })
  } catch (error) {
    const message = String(error)
    if (message.includes('missing-api-key')) {
      invoke('open_chat_setup').catch(() => {})
    }
    if (currentEl) {
      currentEl.classList.remove('streaming')
      currentEl.classList.add('error')
      setText(currentEl, `发送失败：${message}`)
      currentEl = null
    }
    setBusy(false)
  }
}

function addMessage(role, text, streaming = false) {
  const el = document.createElement('div')
  el.className = `msg ${role}${streaming ? ' streaming' : ''}`
  const content = document.createElement('div')
  content.className = 'text'
  content.textContent = text
  el.appendChild(content)
  messagesEl.appendChild(el)
  scroll()
  return el
}

function setText(el, text) {
  const content = el.querySelector('.text')
  if (content) content.textContent = text
}

const CLEAR_STEPS = [
  { text: '你确定要清空记忆吗？', ok: '确定' },
  { text: '真的要清空？？', ok: '是的' },
  { text: '真的真的真的真的要清空？？？', ok: '快点' },
  { text: '服了，那你删吧......', ok: '删除' },
]
let clearStep = 0

function renderClearStep() {
  const step = CLEAR_STEPS[clearStep]
  $('#confirmText').textContent = step.text
  $('#confirmOk').textContent = step.ok
}

function openClearConfirm() {
  clearStep = 0
  renderClearStep()
  $('#clearConfirm').classList.remove('hidden')
  $('#confirmCancel').focus()
}

function closeClearConfirm() {
  $('#clearConfirm').classList.add('hidden')
}

async function advanceClearConfirm() {
  if (clearStep < CLEAR_STEPS.length - 1) {
    clearStep += 1
    renderClearStep()
    return
  }
  closeClearConfirm()
  try {
    await invoke('chat_clear')
    messagesEl.innerHTML = ''
    addMessage('assistant', '……都删干净了。行吧，重新开始。')
  } catch (error) {
    addMessage('assistant', `清空失败：${error}`)
  }
}

function setBusy(value) {  busy = !!value
  sendEl.disabled = busy || !keyOk
  inputEl.disabled = busy || !keyOk
  if (busy) {
    statusEl.textContent = 'Raven 正在输入…'
  } else {
    refreshStatus()
  }
}

function scroll() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function safeListen(name, callback) {
  listen(name, callback).catch((error) => console.warn('[chat] listen failed', name, error))
}
