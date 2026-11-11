import { template } from './html.mjs'
import { PAGING, FEED, ORDERS } from './data.mjs'
import { FIXTURE_FILES, sha256 } from '../fixtures.mjs'

export function routePublic(c) {
  const { path, url, req, fields, files, html, json, record } = c
  if (path === '/api/longpoll') return c.delay(25000, () => c.send(204, ''))
  if (path === '/api/slow')
    return c.delay(Math.min(25000, Math.max(0, Number(url.searchParams.get('ms')) || 3000)), () =>
      json({ ok: true }),
    )
  if (path === '/spa/api/orders') return json(ORDERS)
  if (path === '/spa/' || path.startsWith('/spa/history/')) return html(template('spa/index.html'))
  if (path === '/feed/api') {
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    return c.delay(400, () => json({ items: FEED.slice(offset, offset + 15), total: FEED.length }))
  }
  if (path === '/feed/')
    return html(
      template('feed/index.html', {
        items: FEED.slice(0, 15)
          .map(item => `<article><h2>动态 #${item.id} ${item.title}</h2></article>`)
          .join(''),
      }),
    )
  if (path === '/paging/') {
    const n = Math.min(5, Math.max(1, Number(url.searchParams.get('page')) || 1))
    return html(
      template('paging/index.html', {
        page: n,
        rows: PAGING.slice((n - 1) * 10, n * 10)
          .map(
            row =>
              `<tr>${Object.values(row)
                .map(v => `<td>${v}</td>`)
                .join('')}</tr>`,
          )
          .join(''),
        previous: n > 1 ? `<a href="/paging/?page=${n - 1}">上一页</a>` : '',
        pages: [1, 2, 3, 4, 5].map(p => `<a href="/paging/?page=${p}">${p}</a>`).join(' '),
        next: n < 5 ? `<a href="/paging/?page=${n + 1}">下一页</a>` : '',
      }),
    )
  }
  if (path === '/frames/') return html(template('frames/index.html'))
  if (path === '/frames/middle.html') return html(template('frames/middle.html'))
  if (path === '/frames/deep.html') return html(template('frames/deep.html'))
  if (path === '/shadow/') return html(template('shadow/index.html'))
  if (path === '/downloads/') return html(template('downloads/index.html'))
  if (path.startsWith('/downloads/files/')) {
    const name = path.slice('/downloads/files/'.length)
    const fixture = FIXTURE_FILES[name]
    if (!fixture || !/^(report-2026-q[123]\.csv|manual-s2\.pdf|data\.json)$/.test(name))
      return c.send(404, '文件不存在')
    record('download', { file: name, authed: false })
    return c.download(name, fixture)
  }
  if (path === '/upload/') return html(template('upload/index.html'))
  if (path === '/upload/submit' && req.method === 'POST') {
    const file = files.find(f => f.field === 'file')
    if (!file) return c.send(400, '请选择文件')
    record('upload', {
      field: 'file',
      filename: file.filename,
      size: file.bytes.length,
      sha256: sha256(file.bytes),
      description: fields.description || '',
      authed: false,
    })
    return html(
      template('upload/done.html', {
        filename: c.escape(file.filename),
        size: file.bytes.length,
      }),
    )
  }
  if (path === '/dialogs/') return html(template('dialogs/index.html'))
  if (path === '/dialogs/leave.html') return html(template('dialogs/leave.html'))
  if (path === '/popup/') return html(template('popup/index.html'))
  if (path === '/popup/child.html') return html(template('popup/child.html'))
  if (path === '/popup/auth.html') return html(template('popup/auth.html'))
  if (path === '/editor/') return html(template('editor/index.html'))
  if (path === '/canvas/') return html(template('canvas/index.html'))
  if (path === '/wait/') return html(template('wait/index.html'))
  const endpoints = {
    '/spa/api/notes': ['spa.note', ['orderId', 'note']],
    '/frames/api/submit': ['frames.submit', ['value']],
    '/shadow/api/submit': ['shadow.submit', ['recipient', 'urgent']],
    '/dialogs/api/result': ['dialog.result', ['type', 'value']],
    '/popup/api/child': ['popup.child', ['from']],
    '/popup/api/auth': ['popup.auth', ['code']],
    '/editor/api/save': ['editor.save', ['title', 'html', 'text']],
    '/canvas/api/select': ['canvas.select', ['seat']],
  }
  if (endpoints[path] && req.method === 'POST') {
    if (path === '/spa/api/notes' && !ORDERS.some(o => o.id === fields.orderId))
      return c.send(400, '订单不存在')
    if (
      path === '/canvas/api/select' &&
      (!/^[A-H][1-5]$/.test(fields.seat) ||
        ['A1', 'B2', 'C2', 'D4', 'H3', 'H5'].includes(fields.seat))
    )
      return c.send(400, '座位不可用')
    const [kind, keys] = endpoints[path]
    const data = Object.fromEntries(keys.map(key => [key, fields[key]]))
    record(kind, data)
    if (kind === 'spa.note') c.state.notes.push(data)
    return json({ ok: true })
  }
  return false
}
