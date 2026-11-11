let revision = 0
async function render() {
  const current = ++revision
  const container = document.querySelector('#docs-content')
  const chapter = Number(/^#\/ch\/([123])$/.exec(location.hash)?.[1])
  if (!chapter) {
    container.innerHTML =
      '<nav>' + [1, 2, 3].map(n => `<a href="#/ch/${n}">第 ${n} 章</a>`).join(' ') + '</nav>'
    return
  }
  container.textContent = '加载中…'
  await new Promise(resolve => setTimeout(resolve, 800))
  if (revision === current)
    container.innerHTML =
      `<h2>第 ${chapter} 章</h2>` +
      `<p>最低版本要求：${['v2.4.1', 'v3.0.0-rc.2', 'v1.9.12'][chapter - 1]}</p>` +
      '<a href="#/">目录</a>'
}
window.addEventListener('hashchange', render)
void render()
