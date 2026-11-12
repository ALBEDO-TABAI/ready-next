#!/usr/bin/env node
// W6 T6 real-window check (G7/K4): every 必须 cell of the 收下矩阵 through its visible entry in the running app — the
// shared selection bar in 网页, 资讯, 书房 and PDF, the 资讯 收下 menu, the 划线 popover, the block menu, the FastCard card
// button, the assistant's answer menu and the app's own drag senders onto a board — then content and source read back
// from ready.db and from the files on disk. One toast's 撤销 and one 打开 are taken as well.
// Safety: hidden window (READY_START_HIDDEN), throwaway HOME/profile, a test library four folders deep on its canonical
// path; no model call; HTTP(S) is refused in the app's session, and browser tabs get one locally served page and
// nothing else (no network at all).
// Build first (npx --no-install electron-vite build). Usage: node scripts/verify-ready-next-capture.cjs [--shots <dir>]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const harness = require('./design-matrix/harness.cjs')

const shotsArg = process.argv.indexOf('--shots')
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const WEB_URL = 'https://capture.ready.invalid/page'
const WEB_QUOTE = '网页里的一句话：筛子先理解你在做什么。'
const WEB_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>收下验收网页</title></head><body style="font:20px/1.8 -apple-system,sans-serif;padding:60px"><h1>收下验收网页</h1><p id="quote">${WEB_QUOTE}</p><p>后面的上下文。</p></body></html>`
const ARTICLE_SUMMARY = '资讯文章的摘要：先理解你在做什么。'
const ANSWER = '助手回答的完整原文：第一句，第二句。'

let passed = 0
const pass = name => { passed++; console.log(`PASS ${name}`) }
const check = (value, name, detail = '') => { if (!value) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`); pass(name) }
const sleep = harness.sleep
async function waitFor(probe, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await sleep(150) }
  return null
}
async function shot(page, name) { if (shots) { await sleep(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }) } }

function pdfFixture() {
  const stream = 'BT /F1 18 Tf 40 150 Td (Ready capture PDF selection words) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}

// ⌘K: type, pick the row named exactly `name` (of `type` when given), open it with Enter.
async function openFromSwitcher(page, query, name, type) {
  const field = page.getByRole('combobox', { name: '搜索所有对象和命令' })
  for (let attempt = 0; attempt < 20 && !await field.isVisible().catch(() => false); attempt++) {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    await page.keyboard.press(`${mod}+k`)
    await field.waitFor({ timeout: 1500 }).catch(() => {})
  }
  await field.fill(query)
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  let rows = page.locator('.rn-switch-item').filter({ has: page.locator('.rn-switch-name', { hasText: exact }) })
  if (type) rows = rows.filter({ has: page.locator('.rn-switch-type', { hasText: new RegExp(`^${type}`) }) })
  const row = rows.first()
  await row.waitFor({ timeout: 20000 })
  const index = Number((await row.getAttribute('id')).split('-').pop())
  for (let i = 0; i < index; i++) await field.press('ArrowDown')
  await field.press('Enter')
}

// A pointer drag across `words` inside the first element matching `selector` (real mouse input in the app window).
async function dragSelect(page, selector, words) {
  const box = await page.locator(selector).first().evaluate((element, words) => {
    // The words as shown: a text node that holds them and is laid out on screen (a book keeps unseen leaves too).
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const shown = node => { const range = document.createRange(); range.selectNodeContents(node); const box = range.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight }
    let node = walker.nextNode()
    while (node && !(node.textContent.includes(words) && shown(node))) node = walker.nextNode()
    if (!node) throw new Error(`text not found: ${words}`)
    const start = node.textContent.indexOf(words), a = document.createRange(), b = document.createRange()
    a.setStart(node, start); a.setEnd(node, start + 1); b.setStart(node, start + words.length - 1); b.setEnd(node, start + words.length)
    const first = a.getBoundingClientRect(), last = b.getBoundingClientRect()
    return { x1: first.left + first.width * 0.3, y1: first.top + first.height / 2, x2: last.right - last.width * 0.3, y2: last.top + last.height / 2 }
  }, words)
  // Past the double-click interval of the previous press, so the press starts a new selection.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(600)
    await page.mouse.move(box.x1, box.y1); await page.mouse.down(); await page.mouse.move(box.x2, box.y2, { steps: 10 }); await page.mouse.up()
    const selected = await page.evaluate(() => String(window.getSelection()).trim())
    if (selected) return selected
  }
  throw new Error(`the pointer drag selected nothing: ${words}`)
}

const bar = page => page.locator('[data-ready-selection-bar]').first()
async function barAction(page, label) {
  await bar(page).waitFor({ timeout: 10000 })
  await bar(page).locator('button', { hasText: new RegExp(`^${label}$`) }).click()
}
async function toast(page, pattern) {
  const found = await waitFor(async () => {
    const texts = await page.locator('.rn-toast').allTextContents()
    return texts.reverse().find(text => pattern.test(text)) ?? null
  }, 20000)
  if (!found) throw new Error(`no toast ${pattern}; saw: ${(await page.locator('.rn-toast').allTextContents()).join(' | ')}`)
  return found
}
async function toastAction(page, pattern, label) {
  await toast(page, pattern)
  await page.locator('.rn-toast', { hasText: pattern }).last().locator('button', { hasText: label }).click()
}
const cards = page => page.evaluate(async () => (await window.electronAPI.browser.listFastCardItems()).data ?? [])

// The app's own drag sender and drop target, with the gesture synthesized: dragstart on the source fills the
// DataTransfer through the app's handler; dragover and drop go to the target's handler at its centre.
async function startDrag(page, selector) {
  await page.locator(selector).first().evaluate(source => {
    const data = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    window.__captureDrag = data
    return data.types.join(',')
  })
}
async function finishDrag(page, selector, offset = { x: 0, y: 0 }) {
  return page.locator(selector).first().evaluate((target, offset) => {
    const data = window.__captureDrag, box = target.getBoundingClientRect()
    const at = { clientX: box.left + box.width / 2 + offset.x, clientY: box.top + box.height / 2 + offset.y }
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, ...at }))
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, ...at })
    target.dispatchEvent(drop)
    delete window.__captureDrag
    return drop.defaultPrevented
  }, offset)
}

async function main() {
  // Real path: on macOS /tmp is a link to /private/tmp, and Ready works with canonical library roots.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'w6c-')))
  process.once('exit', () => fs.rmSync(temp, { recursive: true, force: true }))
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const previousHome = process.env.HOME
  // The profile stays near the short temp root (socket paths); Ready refuses a library fewer than four levels deep.
  const profile = path.join(temp, 'profile'), vault = path.join(temp, 'w6', 'capture', '测试资料库')
  fs.mkdirSync(profile); fs.mkdirSync(vault, { recursive: true })
  process.env.HOME = temp; process.env.READY_START_HIDDEN = '1'
  const seed = (...args) => {
    const result = spawnSync(require('electron'), ['--import', 'tsx', path.join(__dirname, 'fixtures/ready-next-capture-seed.cjs'), profile, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000,
    })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error || 'fixture process failed'))
    return result.stdout
  }
  let current
  try {
    current = await harness.launch(profile)
    const configured = await current.page.evaluate(root => { localStorage.setItem('ready.agentPanelTest', '1'); return window.electronAPI.vault.set(root) }, vault)
    if (configured.status !== 'ready') throw new Error(JSON.stringify(configured))
    await harness.close(current.app); current = null
    seed()
    const bookPath = path.join(temp, '验收书.txt')
    fs.writeFileSync(bookPath, '第一章\n\n这是验收书的正文，只供本地测试，城市像一本摊开的书。\n\n第二段继续写下去，每一条巷子都是脚注。')
    fs.writeFileSync(path.join(vault, '验收PDF.pdf'), pdfFixture())
    current = await harness.launch(profile)
    const { app } = current
    const { page } = current
    await app.evaluate(({ session }, fixture) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
      // Browser tabs: every http(s) request is answered here — the one fixture page, or 404. Nothing reaches the network.
      const tabs = session.fromPartition('persist:browser')
      for (const scheme of ['http', 'https']) tabs.protocol.handle(scheme, request => request.url === fixture.url
        ? new Response(fixture.html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('', { status: 404 }))
    }, { url: WEB_URL, html: WEB_HTML })

    // Fixture objects (not under test): the current page with a block, a database row, the book, the index.
    const ids = await page.evaluate(async ({ root, bookPath }) => {
      const api = window.electronAPI
      const page = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '收下目标', operationId: crypto.randomUUID(),
        content: '# 收下目标\n\n文档块的原文：这一块要发送到画板。\n' })
      if (!page.ok) throw new Error(JSON.stringify(page))
      const database = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '验收数据库', database: true, operationId: crypto.randomUUID() })
      if (!database.ok) throw new Error(JSON.stringify(database))
      const row = await api.documentDatabase({ type: 'createRow', databaseId: database.value.objectId, title: '验收行', values: {}, body: '行正文', operationId: crypto.randomUUID() })
      if (!row.ok) throw new Error(JSON.stringify(row))
      const rows = await api.databasePreview(database.value.objectId)
      const imported = await api.library.importFiles([bookPath])
      if (!imported.success) throw new Error(JSON.stringify(imported))
      const library = await api.library.get()
      const indexed = await api.document.reindexAllSources(root)
      if (!indexed?.success) throw new Error(`reindex failed: ${JSON.stringify(indexed).slice(0, 300)}`)
      const pdf = await api.objects.resolvePath(`${root}/验收PDF.pdf`)
      return { page: page.value.objectId, pagePath: page.value.path, row: rows.rows.find(entry => entry.title === '验收行').id,
        book: library.data.books.find(book => book.title === '验收书').id, pdf: pdf.objectId }
    }, { root: vault, bookPath })
    const expectations = []
    const want = entry => expectations.push(entry)
    const DOC = path.basename(ids.pagePath), BOARD = '灵感.canvas'

    // ── The current page: opened first, so 引用到文档 from every other place lands here.
    await harness.requestMode(page, 'document')
    await openFromSwitcher(page, '收下目标', '收下目标', '页面')
    await page.locator('[data-ready-block-editor]:visible').first().waitFor({ timeout: 20000 })

    // 文档块 → 画板: the block menu's 发送到画板.
    const block = page.locator('[data-ready-block-editor]:visible .ready-block-shell', { hasText: '文档块的原文' }).first()
    await block.hover()
    await block.locator('.ready-block-handle').click({ force: true })
    await shot(page, 'block-menu')
    await page.getByRole('dialog', { name: '块菜单' }).getByRole('option', { name: /发送到画板/ }).click()
    check(/已存到画板《灵感》/.test(await toast(page, /已存到画板/)), '文档块 → 画板: 块菜单 › 发送到画板, toast with 撤销 and 打开')
    want({ cell: '文档块', where: 'canvas', file: BOARD, text: '文档块的原文：这一块要发送到画板。', uriPrefix: `ready://doc/page/${encodeURIComponent(ids.page)}` })

    // ── 资讯: the article's 收下 menu and the shared bar over selected words.
    await harness.requestMode(page, 'rss')
    await page.locator('nav[aria-label="资讯导航"] [aria-label="全部"]').click({ timeout: 20000 })
    await page.locator('[data-rss-item-id="capture-article"] .rss-card-title button').first().click({ timeout: 20000 })
    await page.locator('.rss-reader-body [data-ready-reading-run]').first().waitFor({ timeout: 20000 })
    const rssMenu = async item => {
      await page.locator('.rss-btn', { hasText: '收下' }).first().click()
      await page.getByRole('menuitem', { name: item, exact: true }).click()
    }
    await rssMenu('存入 FastCard')
    await toast(page, /已存入 FastCard/)
    // 撤销 takes the card out of FastCard for real; then the cell is captured again.
    const undone = (await cards(page)).find(card => card.text === ARTICLE_SUMMARY)
    await toastAction(page, /已存入 FastCard/, '撤销')
    check(await waitFor(async () => !(await cards(page)).some(card => card.id === undone?.id)), '资讯文章 → FastCard: 撤销 removes the card from FastCard')
    await page.locator('.rss-btn', { hasText: '收下' }).first().click()
    await shot(page, 'rss-capture-menu')
    await page.getByRole('menuitem', { name: '存入 FastCard', exact: true }).click()
    await toast(page, /已存入 FastCard/)
    const articleCard = await waitFor(async () => (await cards(page)).find(card => card.text === ARTICLE_SUMMARY))
    check(articleCard?.source?.ref?.kind === 'rss-item' && articleCard.source.ref.id === 'capture-article', '资讯文章 → FastCard: 收下 › 存入 FastCard, the article is the source')
    await rssMenu('保存到画板')
    await toast(page, /已存到画板《灵感》/); pass('资讯文章 → 画板: 收下 › 保存到画板')
    want({ cell: '资讯文章', where: 'canvas', file: BOARD, text: ARTICLE_SUMMARY, uri: 'ready://rss/item/capture-article' })
    await rssMenu('引用到文档')
    check(/已引用到《收下目标》/.test(await toast(page, /已引用到/)), '资讯文章 → 当前文档: 收下 › 引用到文档 (the toast names the page)')
    want({ cell: '资讯文章', where: 'document', file: DOC, text: ARTICLE_SUMMARY, uri: 'ready://rss/item/capture-article' })

    const rssWords = async words => {
      const selected = await dragSelect(page, '.rss-reader-body', words)
      await bar(page).waitFor({ timeout: 10000 })
      return selected
    }
    const rssFastCard = await rssWords('一个好的筛子，应该先理解你在做什么')
    await shot(page, 'rss-selection-bar')
    check((await bar(page).locator('button').allTextContents()).join('|') === '划线|存入 FastCard|引用到文档|问 AI|保存到画板', '资讯选区: the shared bar in its fixed order')
    await barAction(page, '存入 FastCard')
    await toast(page, /已存入 FastCard/); pass('资讯选区 → FastCard: 选区条 › 存入 FastCard')
    want({ cell: '资讯选区', where: 'fastcard', text: rssFastCard, uriPrefix: 'ready://rss/item/capture-article?excerpt=' })
    const rssCanvas = await rssWords('再决定把什么放到你面前')
    await barAction(page, '保存到画板')
    await toast(page, /已存到画板/); pass('资讯选区 → 画板: 选区条 › 保存到画板')
    want({ cell: '资讯选区', where: 'canvas', file: BOARD, text: rssCanvas, uriPrefix: 'ready://rss/item/capture-article?excerpt=' })
    const rssDocument = await rssWords('资讯正文的第一段')
    await barAction(page, '引用到文档')
    await toast(page, /已引用到《收下目标》/); pass('资讯选区 → 当前文档: 选区条 › 引用到文档')
    want({ cell: '资讯选区', where: 'document', file: DOC, text: rssDocument, uriPrefix: 'ready://rss/item/capture-article?excerpt=' })

    // ── 网页: the bar in the band under the native page; Main reports the page's selection.
    await harness.requestMode(page, 'browser')
    const opened = await page.evaluate(url => window.electronAPI.browser.createTab(url), WEB_URL)
    check(opened.success, 'web fixture page opened in a Ready tab (served locally)')
    const web = await waitFor(() => app.context().pages().find(candidate => candidate.url() === WEB_URL))
    await web.locator('#quote').waitFor({ timeout: 20000 })
    const quoteBox = await web.locator('#quote').evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, y: box.top + box.height / 2 } })
    // Native input into the page, as the person's mouse: a click on empty space first (a press inside an existing
    // selection would start dragging it), then a drag across the quote.
    const selectInPage = () => app.evaluate(({ webContents }, { url, box }) => {
      const contents = webContents.getAllWebContents().find(candidate => candidate.getURL() === url)
      contents.sendInputEvent({ type: 'mouseDown', x: Math.round(box.left + 2), y: Math.round(box.y + 160), button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: Math.round(box.left + 2), y: Math.round(box.y + 160), button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseDown', x: Math.round(box.left + 2), y: Math.round(box.y), button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.right - 2), y: Math.round(box.y), button: 'left' })
      contents.sendInputEvent({ type: 'mouseUp', x: Math.round(box.right - 2), y: Math.round(box.y), button: 'left', clickCount: 1 })
    }, { url: WEB_URL, box: quoteBox })
    await selectInPage()
    await bar(page).waitFor({ timeout: 15000 })
    const band = await page.evaluate(() => {
      const bar = document.querySelector('[data-ready-selection-bar]').getBoundingClientRect()
      const surface = document.querySelector('[data-ready-native-surface="browser"]').getBoundingClientRect()
      return { barTop: bar.top, barBottom: bar.bottom, surfaceBottom: surface.bottom, height: innerHeight }
    })
    check(band.barTop >= band.surfaceBottom && band.barBottom <= band.height, '网页选区: the bar sits in the band under the page, never over the native page', JSON.stringify(band))
    await shot(page, 'web-selection-bar')
    const webText = (await web.evaluate(() => String(getSelection()).trim()))
    await barAction(page, '引用到文档')
    await toast(page, /已引用到《收下目标》/)
    // 撤销 takes exactly the inserted words out of the page; then the cell is captured again.
    await toastAction(page, /已引用到《收下目标》/, '撤销')
    await toast(page, /已撤销/)
    await selectInPage()
    await barAction(page, '引用到文档')
    await toast(page, /已引用到《收下目标》/); pass('网页选区 → 当前文档: 选区条 › 引用到文档, after one 撤销')
    want({ cell: '网页选区', where: 'document', file: DOC, text: webText, uri: `ready://web?url=${encodeURIComponent(WEB_URL)}` })

    // ── 书房: the bar over selected words, then the 划线 popover's own 收下.
    await harness.requestMode(page, 'document')
    await page.locator('[data-library-entry="true"]').click()
    const spine = page.locator('.rn-library .spine').first()
    await spine.waitFor({ timeout: 20000 })
    const spineBox = await spine.boundingBox(); await page.mouse.click(spineBox.x + spineBox.width / 2, spineBox.y + spineBox.height / 2)
    await page.getByRole('button', { name: '翻看封面' }).click({ force: true })
    await page.getByRole('button', { name: '开始阅读' }).evaluate(button => button.click())
    await page.locator('.rd-book .leaf .pg-flow p').first().waitFor({ timeout: 20000 })
    await sleep(800)
    const bookWords = async words => { await dragSelect(page, '.rd-book', words); await bar(page).waitFor({ timeout: 10000 }) }
    await bookWords('这是验收书的正文')
    await shot(page, 'book-selection-bar')
    check((await bar(page).locator('button').allTextContents()).join('|') === '划线|存入 FastCard|引用到文档|问 AI|保存到画板|批注|复制', '书房选区: the shared bar, then 书房’s 批注 and 复制')
    await barAction(page, '存入 FastCard')
    await toast(page, /已存入 FastCard/); pass('书 → FastCard: 选区条 › 存入 FastCard')
    want({ cell: '书', where: 'fastcard', text: '这是验收书的正文', uriPrefix: `ready://read/book/${encodeURIComponent(ids.book)}#` })
    await bookWords('只供本地测试')
    await barAction(page, '保存到画板')
    await toast(page, /已存到画板/); pass('书 → 画板: 选区条 › 保存到画板')
    want({ cell: '书', where: 'canvas', file: BOARD, text: '只供本地测试', uriPrefix: `ready://read/book/${encodeURIComponent(ids.book)}#` })
    await bookWords('城市像一本摊开的书')
    await barAction(page, '划线')
    await toast(page, /已划线到来源页/); pass('书 → 划线: 选区条 › 划线 (with its toast)')
    await page.locator('.rd-book mark.hl').first().waitFor({ timeout: 15000 })
    // A press on the highlight as shown (the book keeps unseen leaves too) opens its popover.
    const openMark = async () => {
      await sleep(600)
      // The first line box of the mark: a highlight across two lines has a bounding box that covers other words.
      const box = await page.evaluate(() => [...document.querySelectorAll('.rd-book mark.hl')].map(mark => ({ mark, box: mark.getClientRects()[0] ?? mark.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0 && box.top > 0 && box.bottom < innerHeight)
        .find(({ mark, box }) => mark.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)))?.box)
      if (!box) throw new Error('no highlight on the shown pages')
      await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2); await page.mouse.down(); await page.mouse.up()
      await page.getByRole('dialog', { name: '划线', exact: true }).waitFor({ timeout: 10000 })
    }
    await openMark()
    await shot(page, 'book-highlight-popover')
    const capsule = page.getByRole('dialog', { name: '划线', exact: true }).locator('.highlight-source a[data-ready-ref-capsule]')
    check(await capsule.getAttribute('data-ref-kind') === 'highlight', 'K1 书房 划线浮层: the source page is a capsule (划线)')
    await page.getByRole('dialog', { name: '划线', exact: true }).getByRole('button', { name: '存入 FastCard', exact: true }).click()
    await toast(page, /已存入 FastCard/); pass('划线 → FastCard: 划线浮层 › 存入 FastCard')
    want({ cell: '划线', where: 'fastcard', text: '城市像一本摊开的书', uriPrefix: `ready://read/book/${encodeURIComponent(ids.book)}#` })
    await openMark()
    await page.getByRole('dialog', { name: '划线', exact: true }).getByRole('button', { name: '保存到画板', exact: true }).click()
    await toast(page, /已存到画板/); pass('划线 → 画板: 划线浮层 › 保存到画板')
    want({ cell: '划线', where: 'canvas', file: BOARD, text: '城市像一本摊开的书', uriPrefix: `ready://read/book/${encodeURIComponent(ids.book)}#` })
    await page.keyboard.press('Escape')

    // ── 助手: a conversation of its own (the panel's 新建对话: Main records the scope, no model is involved), then the fixture answer.
    const chat = page.locator('[data-chat-panel-root]').first()
    const currentScope = () => page.evaluate(() => window.__READY_AGENT_TEST__?.sessionSummary().currentScopeId ?? null)
    const before = await currentScope()
    await chat.getByRole('button', { name: '新建对话', exact: true }).click()
    // The first conversation of a profile waits for Main's agent runtime to start: allow it a minute.
    const conversation = await waitFor(async () => { const id = await currentScope(); return id && id !== before ? id : null }, 60000)
    check(conversation, 'a new conversation from the panel’s 新建对话')
    const CONVERSATION_URI = `ready://agent/conversation/${encodeURIComponent(conversation)}`
    const answerMenu = async item => {
      const added = await page.evaluate(content => window.__READY_AGENT_TEST__?.addMessageFixture({ content }), ANSWER)
      if (!added?.ok) throw new Error(`fixture answer: ${JSON.stringify(added)}`)
      // The composer's liquid glass projects a copy of the messages; the real ones come first.
      const message = chat.locator('.group\\/agentmsg', { hasText: ANSWER }).first()
      await message.hover()
      await message.getByRole('button', { name: '收下这段回答' }).click({ force: true })
      await page.getByRole('menuitem', { name: item, exact: true }).click()
    }
    await answerMenu('存为卡片')
    await toast(page, /已存到画板/); pass('助手回答 → 画板: 回答菜单 › 存为卡片')
    want({ cell: '助手回答', where: 'canvas', file: BOARD, text: ANSWER, uri: CONVERSATION_URI })
    await answerMenu('存为页面')
    const dialog = page.getByRole('dialog', { name: '保存到…' })
    await dialog.waitFor({ timeout: 15000 })
    await shot(page, 'answer-save-dialog')
    await dialog.getByRole('button', { name: '确认', exact: true }).click()
    const saved = (await toast(page, /已存为页面/)).match(/已存为页面《(.+?)》/)[1]
    pass('助手回答 → 当前文档: 回答菜单 › 存为页面, through the draft and the Save To dialog')
    want({ cell: '助手回答', where: 'page', file: `${saved}.md`, text: ANSWER, uri: CONVERSATION_URI })

    // ── PDF: the bar over the text layer.
    await page.locator('[data-ready-sidebar] button, .ink-sidebar button, nav button').filter({ hasText: /^验收PDF\.pdf$/ }).first().click({ timeout: 20000 })
      .catch(async () => { await page.getByText('验收PDF.pdf', { exact: true }).first().click() })
    await page.locator('[data-pdf-text-state="ready"] .react-pdf__Page__textContent').first().waitFor({ timeout: 30000 })
    await sleep(600)
    const pdfWords = async () => {
      await dragSelect(page, '[data-page="1"] .react-pdf__Page__textContent', 'capture PDF selection')
      await bar(page).waitFor({ timeout: 10000 })
      return page.evaluate(() => String(window.getSelection()))
    }
    const pdfText = await pdfWords()
    await shot(page, 'pdf-selection-bar')
    await barAction(page, '存入 FastCard')
    await toast(page, /已存入 FastCard/); pass('PDF选区 → FastCard: 选区条 › 存入 FastCard')
    want({ cell: 'PDF选区', where: 'fastcard', text: pdfText, uriPrefix: `ready://doc/file/${encodeURIComponent(ids.pdf)}#pdf` })
    await pdfWords()
    await barAction(page, '引用到文档')
    await toast(page, /已引用到《收下目标》/); pass('PDF选区 → 当前文档: 选区条 › 引用到文档 (from the PDF tab, into the last page)')
    want({ cell: 'PDF选区', where: 'document', file: DOC, text: pdfText, uriPrefix: `ready://doc/file/${encodeURIComponent(ids.pdf)}#pdf` })
    await pdfWords()
    await barAction(page, '问 AI')
    const composer = await waitFor(async () => {
      const state = await page.evaluate(() => window.__READY_AGENT_TEST__?.snapshot())
      return state?.composer.attachmentNames.some(name => /验收PDF/.test(name)) ? state : null
    })
    check(composer && composer.composer.inputValue.includes(`> ${pdfText.trim()}`) && !composer.runtime.isStreaming,
      'PDF选区 → 问 AI: the PDF is a resource of the turn and the quote is in the composer; nothing is sent', JSON.stringify(composer?.composer))

    // ── FastCard: 插入到文档 on a card (text and image), then the app's own drag of a card onto a board.
    await openFromSwitcher(page, '收下目标', '收下目标', '页面')
    await openFromSwitcher(page, '打开 FastCard', '打开 FastCard')
    const shelf = page.locator('[data-fastcard-shelf]')
    await shelf.waitFor({ timeout: 15000 })
    const selectionCard = (await cards(page)).find(card => card.text === rssFastCard)
    await shot(page, 'fastcard-card-buttons')
    await shelf.locator(`[data-fastcard-id="${selectionCard.id}"]`).getByRole('button', { name: '插入到文档' }).click()
    await toast(page, /已引用到《收下目标》/); pass('FastCard → 当前文档: 卡片 › 插入到文档')
    want({ cell: 'FastCard', where: 'document', file: DOC, uri: `ready://fastcard/${selectionCard.id}` })
    await shelf.locator('[data-fastcard-id="fixture-image"]').getByRole('button', { name: '插入到文档' }).click()
    await toast(page, /已引用到《收下目标》/); pass('图片 FastCard → 当前文档: 卡片 › 插入到文档')
    want({ cell: '图片 FastCard', where: 'document', file: DOC, uri: 'ready://fastcard/fixture-image' })

    // ── Drags onto the board (the app's own senders and receiver): a page, a database row, FastCard cards.
    await openFromSwitcher(page, '灵感', '灵感', '画板')
    const surface = '[data-workbench-mode-panel="document"] .rn-canvas[data-canvas-surface]'
    await page.locator(surface).waitFor({ timeout: 20000 })
    await startDrag(page, `[draggable="true"]:has-text("收下目标")`)
    check(await finishDrag(page, surface, { x: -200, y: -120 }), '文档页面 → 画板: the page dropped from the page tree')
    want({ cell: '文档页面', where: 'canvas', file: BOARD, refId: ids.page, uriPrefix: `ready://doc/page/${encodeURIComponent(ids.page)}` })
    if (!await page.locator('[data-fastcard-shelf]').isVisible().catch(() => false)) await openFromSwitcher(page, '打开 FastCard', '打开 FastCard')
    await startDrag(page, `[data-fastcard-id="${articleCard.id}"]`)
    check(await finishDrag(page, surface, { x: 160, y: -120 }), 'FastCard → 画板: a card dragged from the shelf')
    await startDrag(page, '[data-fastcard-id="fixture-image"]')
    check(await finishDrag(page, surface, { x: 160, y: 120 }), '图片 FastCard → 画板: the image card dragged from the shelf')
    await openFromSwitcher(page, '验收数据库', '验收数据库', '数据库')
    await page.locator(`[data-row-id="${ids.row}"]`).first().waitFor({ timeout: 20000 })
    await startDrag(page, `[data-row-id="${ids.row}"]`)
    await openFromSwitcher(page, '灵感', '灵感', '画板')
    await page.locator(surface).waitFor({ timeout: 20000 })
    check(await finishDrag(page, surface, { x: -200, y: 120 }), '数据库行 → 画板: a row dragged from the database view')
    want({ cell: '数据库行', where: 'canvas', file: BOARD, refId: ids.row, uriPrefix: `ready://doc/page/${encodeURIComponent(ids.row)}` })
    await sleep(1500)
    await shot(page, 'board-after-captures')

    // 打开 from a toast: the board opens where the capture went (the person chose to go there).
    await openFromSwitcher(page, '收下目标', '收下目标', '页面')
    await harness.requestMode(page, 'rss')
    await rssMenu('保存到画板')
    await toastAction(page, /已存到画板/, '打开')
    check(await waitFor(async () => /灵感/.test(await page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('title').catch(() => '') ?? '')), 'a capture toast’s 打开 opens the board')

    // Save the current page (⌘S, the app's save), then read everything back from disk and the database.
    await openFromSwitcher(page, '收下目标', '收下目标', '页面')
    await page.locator('[data-ready-block-editor]:visible').first().click()
    await page.keyboard.press(`${mod}+s`)
    const document = await waitFor(() => { const text = fs.readFileSync(ids.pagePath, 'utf8'); return text.includes('ready://fastcard/fixture-image') ? text : null }, 20000)
    check(document, 'the current page saved to disk with every capture')
    const media = fs.readdirSync(path.join(profile, 'fastcard-media'))[0]
    const assets = path.join(path.dirname(ids.pagePath), `${path.basename(ids.pagePath, '.md')}.assets`)
    check(fs.existsSync(assets) && fs.readdirSync(assets).some(name => fs.readFileSync(path.join(assets, name)).equals(fs.readFileSync(path.join(profile, 'fastcard-media', media)))),
      '图片 FastCard → 当前文档: the picture is copied beside the page, byte for byte')
    const board = JSON.parse(fs.readFileSync(path.join(vault, BOARD), 'utf8'))
    check(board.nodes.filter(node => node.text === ARTICLE_SUMMARY).length >= 2, 'FastCard → 画板: the dragged card is on the board as its own card')
    check(board.nodes.some(node => node.type === 'file' && /\.png$/i.test(node.file ?? '')), '图片 FastCard → 画板: the image card is on the board')
    await harness.close(app); current = null
    const report = path.join(temp, 'expectations.json')
    fs.writeFileSync(report, JSON.stringify(expectations))
    for (const line of seed(report, vault).split('\n').filter(Boolean)) { console.log(line); passed++ }
    console.log(`Capture matrix: ${passed} checks passed; every 必须 cell triggered through its visible entry and read back from ready.db and disk`)
  } catch (error) {
    if (current && shots) await current.page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    if (current) await harness.close(current.app)
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1 })
