#!/usr/bin/env node
// W6 T1–T3 real-window check (hidden window; throwaway profile and test vault; no model, no external site):
//  T1 the reference capsule in its five places — the block editor, an assistant message, the calendar event panel,
//     board cards, and the 出处 of 书房 and 资讯 — opens its target on click; ⌥-click quick-looks it; hover then
//     Space quick-looks; the hover preview appears after the pause.
//  T2 quick looks show content, not paths (database rows, the board in miniature, the book, the article, the page).
//  T3 ⌘K shows a book with its Chinese type and no extension; ⌥↵ quick-looks it.
// Light and dark screenshots of every place and quick look go to --shots <dir> when given.
// Build first (npx electron-vite build). Usage: node scripts/verify-ready-next-capsule-electron.cjs [--shots <dir>]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const harness = require('./design-matrix/harness.cjs')

const shotsArg = process.argv.indexOf('--shots')
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null
let passed = 0, failed = 0
const ok = (name, pass, detail = '') => { if (pass) passed++; else failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail ? ` — ${detail}` : ''}`) }
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const HL = 'hl-w6capsule'

async function shot(page, name) {
  if (!shots) return
  await harness.sleep(350)
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

/** Everything the check needs beyond the design-matrix vault: a related page on an event, a board with reference
 *  cards, a highlight quoted on a page, and the agent panel's fixture switch (message rendering without a model). */
async function seedReferences(page, vault) {
  return page.evaluate(async ({ root, highlightId }) => {
    const api = window.electronAPI
    const id = async file => (await api.objects.resolvePath(`${root}/${file}`)).objectId
    const ids = { project: await id('新书发布.md'), meeting: await id('新书发布/会议 11-03.md'), database: await id('选题库.md') }
    // A page whose links resolve the way the editor writes them: [[x]] next to the page, Ready addresses by identity.
    const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const links = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: 'W6 胶囊', operationId: crypto.randomUUID(),
      content: `# W6 胶囊\n\n相关：[[新书发布]]、[[选题库]]，以及[会议 11-03](ready://doc/page/${encodeURIComponent(ids.meeting)})。交稿日 [${today}](ready://calendar/day/${today})。\n` })
    if (!links.ok) throw new Error(`links page: ${links.message}`)
    // A highlight in the book's source page, quoted on a page of its own (书房 出处).
    const library = await api.library.get()
    const book = library.data.books.find(entry => entry.title === '城市漫游者')
    const note = await api.document.readFile(book.notePath)
    const block = `> [!quote|yellow] 第一章 街道的记忆 · [原文](ready://read/book/${encodeURIComponent(book.id)}#c0:33+9)\n> 城市像一本摊开的书\n>\n> 这个比喻留着\n\n^${highlightId}\n\n`
    const written = await api.document.writeFile(book.notePath, note.content.replace('## 标注\n\n', `## 标注\n\n${block}`))
    if (!written.success) throw new Error(`highlight: ${written.error}`)
    const name = book.notePath.split(/[\\/]/).pop().replace(/\.md$/i, '')
    const quote = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '书摘', content: `# 书摘\n\n![[${name}#^${highlightId}]]\n`, operationId: crypto.randomUUID() })
    if (!quote.ok) throw new Error(`quote page: ${quote.message}`)
    // 选题会 is related to 新书发布 (日历事件面板的关联).
    const snapshot = (await api.calendar.snapshot()).data
    const event = snapshot.events.find(entry => entry.title === '选题会')
    const expected = Object.fromEntries(snapshot.events.map(entry => [entry.id, entry.revision || 1]))
    const linked = await api.calendar.mutate({ type: 'link', key: event.id, target: { kind: 'page', id: ids.project } }, expected)
    if (!linked.success) throw new Error(`event link: ${linked.error}`)
    // A board whose cards refer to a page and to the event (画板的引用卡).
    const board = await api.canvas.create({ path: 'W6 引用.canvas', operationId: crypto.randomUUID(), canvas: { ready: { id: crypto.randomUUID(), schemaVersion: 1, title: 'W6 引用' }, edges: [], nodes: [
      { id: crypto.randomUUID(), type: 'file', file: '新书发布.md', x: 60, y: 60, width: 320, height: 220, ready: { kind: 'document', ref: { kind: 'page', id: ids.project } } },
      { id: crypto.randomUUID(), type: 'link', url: `ready://calendar/event/${encodeURIComponent(event.id)}`, x: 440, y: 60, width: 300, height: 180, ready: { kind: 'link', ref: { kind: 'event', id: event.id } } },
    ] } })
    if (!board.ok) throw new Error(`board: ${board.error}`)
    await api.canvas.release(board.value.handleId)
    localStorage.setItem('ready.agentPanelTest', '1')
    // The full index (files and every source: books, highlights, 资讯, FastCard), as 设置 › 重建索引 runs it.
    const indexed = await api.document.reindexAllSources(root)
    if (!indexed?.success) throw new Error(`reindex failed: ${JSON.stringify(indexed).slice(0, 300)}`)
    return { ...ids, book: book.id, event: event.id, board: board.value.objectId }
  }, { root: vault, highlightId: HL })
}

const activePath = page => page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('title').catch(() => null)
const current = (page, mode) => page.locator(`[data-workbench-mode-panel="${mode}"][data-mode-visual-state="current"]`).first().isVisible().catch(() => false)
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return true; await harness.sleep(150) }
  return false
}

/** ⌘K: type, wait for the row named exactly `name` (of `type` when given), select it with the keyboard. */
async function switcher(page, query, name, type) {
  await page.keyboard.press(`${mod}+k`)
  const field = page.getByRole('combobox', { name: '搜索所有对象和命令' })
  await field.waitFor({ timeout: 10000 })
  await field.fill(query)
  const exact = text => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  let rows = page.locator('.rn-switch-item').filter({ has: page.locator('.rn-switch-name', { hasText: exact(name) }) })
  if (type) rows = rows.filter({ has: page.locator('.rn-switch-type', { hasText: new RegExp(`^${type}`) }) })
  const row = rows.first()
  await row.waitFor({ timeout: 15000 })
  const index = Number((await row.getAttribute('id')).split('-').pop())
  for (let i = 0; i < index; i++) await field.press('ArrowDown')
  return { field, row }
}

async function quickLook(page) {
  const panel = page.locator('[role="dialog"] .rn-ql')
  await panel.waitFor({ timeout: 15000 })
  await page.locator('[role="dialog"] .rn-ql__loading').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  return panel
}
async function closeQuickLook(page) {
  await page.keyboard.press('Escape')
  await page.locator('[role="dialog"] .rn-ql').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
}
const noPath = async (panel, vault) => !(await panel.textContent()).includes(vault)

async function openPage(page, title) {
  const { field } = await switcher(page, title, title, '页面')
  await field.press('Enter')
  await waitFor(async () => (await activePath(page))?.endsWith(`${title}.md`))
}

async function tour(page, theme, vault, ids, checks) {
  const t = suffix => `${theme}`.concat(suffix ? `-${suffix}` : '')
  await harness.requestMode(page, 'document')
  // 1 · Block editor: [[页面]], Ready links and dates are capsules in the editable text.
  await openPage(page, 'W6 胶囊')
  const editor = page.locator('[data-ready-block-editor]').first()
  const meeting = editor.locator('a[data-ready-ref-capsule]', { hasText: '会议 11-03' }).first()
  const project = editor.locator('a[data-ready-ref-capsule]', { hasText: '新书发布' }).first()
  await meeting.waitFor({ timeout: 15000 })
  await shot(page, `1-editor-${t()}`)
  if (checks) {
    const kinds = await editor.locator('a[data-ready-ref-capsule]').evaluateAll(links => links.map(link => `${link.textContent}:${link.getAttribute('data-ref-kind')}`))
    ok('T1 editor: [[页面]], a Ready link and a date are capsules of their kinds', ['新书发布:page', '选题库:page', '会议 11-03:page'].every(entry => kinds.includes(entry)) && kinds.some(entry => entry.endsWith(':day')), kinds.join(' '))
  }
  await page.evaluate(() => document.activeElement?.blur?.())
  await meeting.hover()
  await page.locator('.rn-ref-preview').waitFor({ timeout: 5000 }).catch(() => {})
  await shot(page, `1-editor-hover-preview-${t()}`)
  if (checks) ok('T1 hover shows a short preview after the pause', /会议 11-03/.test(await page.locator('.rn-ref-preview').textContent().catch(() => '')))
  await page.keyboard.press('Space')
  let panel = await quickLook(page)
  if (checks) ok('T1 hover then Space quick-looks the page', /参会/.test(await panel.textContent()) && await noPath(panel, vault))
  await closeQuickLook(page)
  await editor.locator('a[data-ready-ref-capsule]', { hasText: '选题库' }).first().click({ modifiers: ['Alt'] })
  panel = await quickLook(page)
  await shot(page, `2-quicklook-database-${t()}`)
  if (checks) ok('T2 ⌥-click on [[选题库]] quick-looks the database rows', await panel.locator('.rn-ql-table tbody tr').count() >= 1
    && /数据库/.test(await panel.locator('.rn-ql__kind').textContent()) && /RSS 的筛子理论/.test(await panel.textContent()) && await noPath(panel, vault),
    (await panel.textContent()).slice(0, 200))
  await closeQuickLook(page)
  await project.click()
  if (checks) ok('T1 editor: click on [[新书发布]] opens it', await waitFor(async () => (await activePath(page))?.endsWith('新书发布.md')), await activePath(page))

  // 2 · Assistant message: Ready references in an answer are capsules.
  const chat = page.locator('[data-chat-panel-root]').first()
  const box = await chat.boundingBox().catch(() => null)
  if (!box || box.width < 200) await page.locator('[data-shell-region="rail"] button[aria-label^="助手"]').first().click().catch(() => {})
  // The fixture message lives only in the panel's memory (never persisted); the store may reload the conversation, so it
  // is shown again before each use. The composer's liquid glass projects a copy of the messages: the real ones come first.
  const answer = async () => {
    const fixture = await page.evaluate(({ project, book }) => window.__READY_AGENT_TEST__?.addMessageFixture({
      content: `相关资料：[新书发布](ready://doc/page/${encodeURIComponent(project)})，以及书房里的[城市漫游者](ready://read/book/${encodeURIComponent(book)}#c0%3A0%2B1)。`,
    }), ids)
    const capsule = name => chat.locator('a[data-ready-ref-capsule]', { hasText: name }).first()
    await capsule('城市漫游者').waitFor({ timeout: 10000 })
    return { fixture, capsule }
  }
  let message = await answer()
  if (checks) ok('assistant fixture message added (agent panel test harness)', Boolean(message.fixture?.ok), JSON.stringify(message.fixture))
  await shot(page, `3-assistant-${t()}`)
  await message.capsule('新书发布').click({ modifiers: ['Alt'] })
  panel = await quickLook(page)
  await shot(page, `3-assistant-quicklook-page-${t()}`)
  if (checks) ok('T1 assistant: ⌥-click quick-looks the page body', /这是项目主页/.test(await panel.textContent()) && await noPath(panel, vault))
  await closeQuickLook(page)
  message = await answer()
  await message.capsule('城市漫游者').click()
  if (checks) ok('T1 assistant: click opens the book in 书房', await waitFor(() => page.locator('[aria-label="阅读器"]').first().isVisible().catch(() => false), 20000))

  // 3 · Calendar event panel: the related page is a capsule.
  await harness.requestMode(page, 'calendar')
  await page.evaluate(id => window.electronAPI.calendar.revealEvent(id), ids.event)
  const related = page.getByRole('region', { name: '日程关联' })
  const relatedPage = related.locator('a[data-ready-ref-capsule]', { hasText: '新书发布' }).first()
  await relatedPage.waitFor({ timeout: 15000 })
  await shot(page, `4-calendar-${t()}`)
  if (checks) ok('T1 calendar: the related page is a capsule named 页面 新书发布', await relatedPage.getAttribute('aria-label') === '页面 新书发布')
  await relatedPage.click()
  if (checks) ok('T1 calendar: click opens 新书发布 in Document mode', await waitFor(async () => await current(page, 'document') && (await activePath(page))?.endsWith('新书发布.md')))

  // 4 · Board: the document card and the event card head with capsules.
  await harness.requestMode(page, 'document')
  const { field: boardField } = await switcher(page, 'W6 引用', 'W6 引用', '画板')
  await boardField.press('Enter')
  const board = page.locator('[data-workbench-mode-panel="document"] .rn-canvas').first()
  const eventCapsule = board.locator('a[data-ready-ref-capsule]', { hasText: '选题会' }).first()
  await eventCapsule.waitFor({ timeout: 20000 })
  await shot(page, `5-canvas-${t()}`)
  if (checks) ok('T1 board: document and event cards head with capsules', await board.locator('a[data-ready-ref-capsule][data-ref-kind="page"]').count() >= 1 && await eventCapsule.getAttribute('data-ref-kind') === 'event')
  await eventCapsule.click()
  if (checks) ok('T1 board: click on the event card opens 选题会 in the calendar', await waitFor(async () => await current(page, 'calendar') && await page.getByRole('region', { name: '日程关联' }).isVisible().catch(() => false)))
  await harness.requestMode(page, 'document')
  const { field: canvasLook } = await switcher(page, '灵感', '灵感', '画板')
  await canvasLook.press('Alt+Enter')
  panel = await quickLook(page)
  await shot(page, `5-quicklook-canvas-${t()}`)
  if (checks) ok('T2 a board quick-looks as a thumbnail of its cards', await panel.locator('.rn-ql-board__card').count() >= 4 && await noPath(panel, vault))
  await closeQuickLook(page)

  // 5a · 书房 出处: the quoted highlight names its book and chapter as a capsule.
  await openPage(page, '书摘')
  const source = page.locator('[data-library-quote] a[data-ready-ref-capsule]').first()
  await source.waitFor({ timeout: 15000 })
  await shot(page, `6-library-quote-${t()}`)
  if (checks) ok('T1 书房 出处: the quote card source is a book capsule', /城市漫游者/.test(await source.textContent()) && await source.getAttribute('data-ref-kind') === 'book')
  await source.click()
  if (checks) ok('T1 书房 出处: click opens the passage in 书房', await waitFor(() => page.locator('[aria-label="阅读器"]').first().isVisible().catch(() => false), 20000))

  // 5b · 资讯 出处: the reader's source line is a capsule to the original page.
  await harness.requestMode(page, 'rss')
  const card = page.locator('[data-rss-item-id] .rss-card-title button').first()
  await card.waitFor({ timeout: 20000 })
  await card.click()
  const original = page.locator('.rss-reader-source a[data-ready-ref-capsule]').first()
  await original.waitFor({ timeout: 20000 })
  await shot(page, `7-rss-reader-${t()}`)
  if (checks) ok('T1 资讯 出处: the source is a web capsule', await original.getAttribute('data-ref-kind') === 'web' && /演示订阅源/.test(await original.textContent()))
  await original.click()
  if (checks) {
    const opened = await waitFor(async () => await current(page, 'browser') && (await page.evaluate(async () => JSON.stringify(await window.electronAPI.browser.getTabs()))).includes('/a/'), 20000)
    ok('T1 资讯 出处: click opens the original page in Ready’s browser', opened)
  }

  // ⌘K: a book shows its title and Chinese type, no extension; ⌥↵ quick-looks it; an article quick-looks its summary.
  await harness.requestMode(page, 'document')
  const { field: bookField, row } = await switcher(page, '城市漫游者', '城市漫游者', '书')
  await shot(page, `8-switcher-${t()}`)
  if (checks) {
    const rows = await page.locator('.rn-switch-item').evaluateAll(items => items.map(item => [item.querySelector('.rn-switch-name')?.textContent, item.querySelector('.rn-switch-type')?.textContent]))
    ok('T3 ⌘K shows the book with its Chinese type and no extension', (await row.locator('.rn-switch-type').textContent()).startsWith('书') && !rows.some(([name]) => /\.(md|txt|canvas)$/.test(name || '')), JSON.stringify(rows))
  }
  await bookField.press('Alt+Enter')
  panel = await quickLook(page)
  await shot(page, `8-quicklook-book-${t()}`)
  if (checks) ok('T3/T2 ⌥↵ quick-looks the book: cover, title, author', (await panel.locator('.rn-ql-book__title').textContent()) === '城市漫游者'
    && await panel.locator('.rn-ql-passage').count() === 0 && await noPath(panel, vault))
  await closeQuickLook(page)
  const { field: highlightField } = await switcher(page, '城市漫游者', '城市漫游者 · 第一章 街道的记忆', '划线')
  await highlightField.press('Alt+Enter')
  panel = await quickLook(page)
  await shot(page, `8-quicklook-highlight-${t()}`)
  if (checks) ok('T2 a highlight quick-looks with its passage and note', (await panel.locator('.rn-ql-passage mark').textContent()) === '城市像一本摊开的书'
    && /这个比喻留着/.test(await panel.textContent()) && await noPath(panel, vault), (await panel.textContent()).slice(0, 200))
  await closeQuickLook(page)
  const { field: articleField } = await switcher(page, 'RSS 没有死', 'RSS 没有死，只是换了读法', '资讯')
  await articleField.press('Alt+Enter')
  panel = await quickLook(page)
  await shot(page, `9-quicklook-article-${t()}`)
  if (checks) ok('T2 an article quick-looks with its source and summary', /演示订阅源/.test(await panel.textContent()) && /注意力/.test(await panel.textContent()))
  await closeQuickLook(page)
}

async function main() {
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-capsule-')))
  const profile = path.join(temp, 'profile'), vault = path.join(temp, '测试资料库')
  const fixture = await harness.startFixtureServer()
  let session = null
  try {
    await harness.seedVault({ profile, vault, dataDir: temp, fixtureUrl: fixture.url, log: () => {} })
    session = await harness.launch(profile)
    const ids = await seedReferences(session.page, vault)
    await harness.close(session.app)
    session = await harness.launch(profile)
    await tour(session.page, 'light', vault, ids, true)
    session = await harness.ensureAppearance(profile, session, { theme: 'dark' })
    await tour(session.page, 'dark', vault, ids, false)
    ok('dark: every place and quick look renders (screenshots)', true)
  } catch (error) {
    failed++
    console.log(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
    if (session && shots) await session.page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
  } finally {
    if (session) await harness.close(session.app).catch(() => {})
    fixture.server.close()
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (error) { console.warn('cleanup left files behind:', error.code) }
  }
  console.log(`${passed}/${passed + failed} passed`)
  if (failed) process.exitCode = 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
