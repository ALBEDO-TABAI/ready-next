const editor = document.querySelector('#editor')
const saveButton = document.querySelector('#save-editor')
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', event => event.preventDefault())
  button.addEventListener('click', () => {
    editor.focus()
    document.execCommand(button.dataset.command)
  })
}
async function save() {
  const text = editor.innerText
  const response = await fetch(saveButton.dataset.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: document.querySelector('#doc-title')?.value || '',
      html: editor.innerHTML,
      text,
    }),
  })
  document.querySelector('#save-status').textContent = response.ok
    ? `已保存（${text.length} 字）`
    : '保存失败'
}
saveButton.addEventListener('click', save)
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return
  const key = event.key.toLowerCase()
  if (key === 's') {
    event.preventDefault()
    void save()
  }
  if (['b', 'i'].includes(key) && editor.contains(document.activeElement)) {
    event.preventDefault()
    document.execCommand(key === 'b' ? 'bold' : 'italic')
  }
})
