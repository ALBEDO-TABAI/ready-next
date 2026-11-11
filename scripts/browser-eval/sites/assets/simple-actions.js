async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('提交失败')
}
document.querySelector('#deep-form')?.addEventListener('submit', async event => {
  event.preventDefault()
  const value = document.querySelector('#deep-input').value
  await post('/frames/api/submit', { value })
  document.querySelector('#deep-result').textContent = `深层已提交：${value}`
})
document.querySelector('#shadow-form')?.addEventListener('submit', async event => {
  event.preventDefault()
  await post('/shadow/api/submit', {
    recipient: document.querySelector('eval-field').value,
    urgent: document.querySelector('eval-switch').checked,
  })
  document.querySelector('#shadow-status').textContent = '寄件单已提交'
})
document.querySelector('#export-view')?.addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob(['地区,销售额\n华东,1286450\n'], { type: 'text/csv;charset=utf-8' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = 'current-view.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})
