const { invoke } = window.__TAURI__.core

function closeWarning() {
  invoke('close_single_instance').catch(() => {
    try { window.close() } catch {}
  })
}

document.getElementById('ok').addEventListener('click', closeWarning)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Enter') closeWarning()
})
