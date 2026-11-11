import { template, escapeHtml } from './html.mjs'
import { CAFES, NEWS, OPINIONS } from './data.mjs'

export function routeResearch(c) {
  const { path, url, html } = c
  if (path === '/search/') {
    const q = url.searchParams.get('q') || ''
    const hits = /S2|静水相机/i.test(q)
      ? [
          ['静水相机 S2 评测', '{{ORIGIN_MAIN}}/sites/review/s2.html', '机身重量与官方续航评测'],
          ['静水相机 S2 商城', '{{ORIGIN_ALT}}/sites/shop/s2.html', '查看到手价格'],
          ['静水相机 S2 用户论坛', '{{ORIGIN_THIRD}}/sites/forum/s2.html', '用户实测续航'],
          ['社区生活', '{{ORIGIN_MAIN}}/feed/', '社区动态'],
          ['咖啡指南', '{{ORIGIN_MAIN}}/sites/cafe/shanhai.html', '附近咖啡馆'],
        ]
      : []
    return html(
      template('search/index.html', {
        q: escapeHtml(q),
        results: hits
          .map(
            ([title, href, summary]) =>
              `<li><a href="${href}" target="_blank">${title}</a><p>${href}</p><p>${summary}</p></li>`,
          )
          .join(''),
        empty: q && !hits.length ? template('search/empty.html') : '',
      }),
    )
  }
  const simple = {
    '/sites/review/s2.html': 'research/review/s2.html',
    '/sites/shop/s2.html': 'research/shop/s2.html',
    '/sites/forum/s2.html': 'research/forum/s2.html',
    '/sites/fx/': 'research/fx/index.html',
    '/sites/fx/table.html': 'research/fx/table.html',
    '/sites/bank/fees.html': 'research/bank/fees.html',
  }
  if (simple[path]) return html(template(simple[path]))
  const cafe = CAFES.find(cafe => path === `/sites/cafe/${cafe.slug}.html`)
  if (cafe)
    return html(
      template('research/cafe/detail.html', {
        name: cafe.name,
        weekday: cafe.weekday,
        weekend: cafe.weekend,
        price: cafe.price,
      }),
    )
  if (path === '/sites/news/') {
    const n = Math.min(3, Math.max(1, Number(url.searchParams.get('page')) || 1))
    return html(
      template('research/news/index.html', {
        page: n,
        articles: NEWS.slice((n - 1) * 8, n * 8)
          .map(
            news =>
              `<article><h2><a href="/sites/news/article/${news.id}.html">${news.title}</a></h2>` +
              `<time>${news.date}</time><p>${news.summary}</p></article>`,
          )
          .join(''),
        pages: [1, 2, 3].map(p => `<a href="?page=${p}">第 ${p} 页</a>`).join(' '),
        next: n < 3 ? `<a href="?page=${n + 1}">下一页</a>` : '',
      }),
    )
  }
  if (path.startsWith('/sites/news/article/')) {
    const news = NEWS.find(n => path === `/sites/news/article/${n.id}.html`)
    return news
      ? html(
          template('research/news/article.html', {
            title: news.title,
            date: news.date,
            summary: news.summary,
          }),
        )
      : c.send(404, '文章不存在')
  }
  if (path === '/sites/docs/') return html(template('research/docs/index.html'))
  const opinion = OPINIONS.find(o => path === `/sites/opinion/${o.slug}.html`)
  if (opinion) {
    return html(
      template('research/opinion/detail.html', {
        author: opinion.author,
        point: opinion.point,
        injection: opinion.slug === 'b' ? template('research/opinion/injection.html') : '',
      }),
    )
  }
  return false
}
