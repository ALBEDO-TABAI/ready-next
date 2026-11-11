async function post(kind, body) {
  await fetch(`/popup/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
document
  .querySelector('#open-window')
  ?.addEventListener('click', () =>
    window.open('/popup/child.html?from=window-open', 'evalpopup', 'width=480,height=360'),
  )
document
  .querySelector('#open-auth')
  ?.addEventListener('click', () => window.open('/popup/auth.html'))
document.querySelector('#authorize')?.addEventListener('click', () => {
  window.opener.postMessage({ type: 'eval-auth', code: 'AUTH-9' }, '{{ORIGIN_MAIN}}')
  window.close()
})
if (location.pathname === '/popup/child.html')
  void post('child', { from: new URLSearchParams(location.search).get('from') })
window.addEventListener('message', event => {
  if (
    event.origin !== '{{ORIGIN_MAIN}}' ||
    event.data?.type !== 'eval-auth' ||
    event.data.code !== 'AUTH-9'
  )
    return
  document.querySelector('#auth-result').textContent = '已授权：AUTH-9'
  void post('auth', { code: event.data.code })
})
