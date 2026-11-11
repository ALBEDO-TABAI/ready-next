let offset = 15
let loading = false
const button = document.querySelector('#load-more')
async function loadMore() {
  if (loading || offset >= 60) return
  loading = true
  button.disabled = true
  try {
    const response = await fetch(`/feed/api?offset=${offset}`)
    if (!response.ok) throw new Error('加载失败')
    const { items, total } = await response.json()
    for (const item of items) {
      const article = document.createElement('article')
      const title = document.createElement('h2')
      title.textContent = `动态 #${item.id} ${item.title}`
      article.append(title)
      document.querySelector('#feed-items').append(article)
    }
    offset += items.length
    if (offset >= total) {
      document.querySelector('#feed-status').textContent = '没有更多了'
      button.hidden = true
      observer.disconnect()
    }
  } finally {
    loading = false
    button.disabled = false
  }
}
const observer = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) void loadMore()
})
observer.observe(document.querySelector('#sentinel'))
button.addEventListener('click', loadMore)
