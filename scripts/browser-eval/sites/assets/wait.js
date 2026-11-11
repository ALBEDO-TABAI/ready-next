let active = true
async function poll() {
  while (active) {
    try {
      await fetch('/api/longpoll')
    } catch {
      active = false
    }
  }
}
window.addEventListener('pagehide', () => {
  active = false
})
void poll()
function append(id, text) {
  const p = document.createElement('p')
  p.id = id
  p.textContent = text
  document.querySelector('main').append(p)
}
setTimeout(() => append('late', '延迟出现的文字 LATE-15'), 1500)
setTimeout(() => {
  location.hash = '#ready'
}, 2500)
fetch('/api/slow?ms=3000').then(response => {
  if (response.ok) append('slow', '慢请求完成 SLOW-3')
})
