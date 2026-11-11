async function show(type) {
  let value
  let message
  if (type === 'alert') {
    alert('这是一条提示')
    value = true
    message = '提示已关闭'
  } else if (type === 'confirm') {
    value = confirm('确定要继续吗？')
    message = `你选择了：${value ? '确定' : '取消'}`
  } else if (type === 'prompt') {
    value = prompt('请输入你的名字')
    message = value === null ? '已取消输入' : `你好，${value}`
  } else return
  document.querySelector('#dialog-result').textContent = message
  await fetch('/dialogs/api/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value }),
  })
}
for (const button of document.querySelectorAll('[data-dialog]'))
  button.addEventListener('click', () => show(button.dataset.dialog))
const auto = new URLSearchParams(location.search).get('auto')
if (auto) setTimeout(() => show(auto), 300)
document.querySelector('#leave-input')?.addEventListener('input', () => {
  window.onbeforeunload = event => {
    event.preventDefault()
    event.returnValue = ''
  }
})
