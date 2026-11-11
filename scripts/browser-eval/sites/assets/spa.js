const historyMode = location.pathname.startsWith('/spa/history/')
const container = document.querySelector('#spa-content')
let revision = 0
const orders = fetch('/spa/api/orders').then(response => response.json())
async function render() {
  const current = ++revision
  const route = historyMode
    ? location.pathname.slice('/spa/history'.length)
    : location.hash.slice(1) || '/'
  const id = /^\/orders\/(SPA-100[1-8])$/.exec(route)?.[1]
  container.textContent = '加载中…'
  await new Promise(resolve => setTimeout(resolve, id ? 1200 : 600))
  const data = await orders
  if (current !== revision) return
  if (!id) {
    container.innerHTML =
      '<h1>订单列表</h1><ul>' +
      data
        .map(
          order =>
            `<li><a href="${historyMode ? '/spa/history' : '#'}/orders/${order.id}">` +
            `订单 ${order.id}</a> ${order.status}</li>`,
        )
        .join('') +
      '</ul>'
    return
  }
  const order = data.find(order => order.id === id)
  container.innerHTML =
    `<h1>订单 ${id}</h1><p>金额：¥ ${order.amount}</p><p>状态：${order.status}</p>` +
    (order.status === '已发货' ? `<p>物流单号：${order.tracking}</p>` : '') +
    '<form id="note-form"><label for="note">添加备注</label>' +
    '<textarea id="note" name="note"></textarea><button>保存备注</button></form>' +
    `<p id="note-status"></p><a href="${historyMode ? '/spa/history/' : '#/'}">返回列表</a>`
  document.querySelector('#note-form').addEventListener('submit', async event => {
    event.preventDefault()
    const response = await fetch('/spa/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id, note: document.querySelector('#note').value }),
    })
    await new Promise(resolve => setTimeout(resolve, 500))
    if (current === revision)
      document.querySelector('#note-status').textContent = response.ok
        ? '备注已保存'
        : '备注保存失败'
  })
}
if (historyMode) {
  document.addEventListener('click', event => {
    const link = event.target.closest('a')
    if (!link || !link.pathname.startsWith('/spa/history/')) return
    event.preventDefault()
    history.pushState({}, '', link.href)
    void render()
  })
  window.addEventListener('popstate', render)
} else window.addEventListener('hashchange', render)
void render()
