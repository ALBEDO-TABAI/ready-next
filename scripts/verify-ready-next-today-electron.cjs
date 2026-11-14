#!/usr/bin/env node
// W6 T7/T8 real-window check — docs/superpowers/plans/2026-11-11-ready-next-w6-linkage-today-implementation.md §4, §5.
// Hidden windows only (the design-matrix harness launches with READY_START_HIDDEN=1), throwaway profiles and test
// vaults, no model, no external site (a local fixture server serves the feed and the web pages).
//  T8  Ready opens on 今日; with data the blocks show, every row opens and quick-looks, a to-do ticks in place and the
//      first screen is timed; an empty library shows only the guide; 设置 › 启动 can open where the window was left.
//  T7  objects opened in three modes, then three steps back land where it started, the entry naming each target;
//      exactly one entry per mode, the browser included; the history survives a restart.
//  ⌘K  nothing typed: 最近打开 from that history and the common commands.
// Build first (npx electron-vite build). Usage: node scripts/verify-ready-next-today-electron.cjs [--shots <dir>]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const harness = require('./design-matrix/harness.cjs')

const shotsArg = process.argv.indexOf('--shots')
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let passed = 0, failed = 0
const ok = (name, pass, detail = '') => { if (pass) passed++; else failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail ? ` — ${detail}` : ''}`) }
const shot = async (page, name) => { if (!shots) return; await harness.sleep(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }) }
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check().catch(() => false)) return true; await harness.sleep(120) }
  return false
}

const today = page => page.locator('section.today[data-today-page="ready"]')
const current = (page, mode) => page.locator(`[data-workbench-mode-panel="${mode}"][data-mode-visual-state="current"]`).first().isVisible()
const activeTabTitle = page => page.locator('.ink-tabstrip [role="tab"][aria-selected="true"]').first().getAttribute('title')
/** The way-back entries a person can see right now, by mode, with their labels. */
const entries = page => page.evaluate(() => [...document.querySelectorAll('[data-navigation-back]')].filter(node => {
  const box = node.getBoundingClientRect(), style = getComputedStyle(node)
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && !node.closest('[aria-hidden="true"]')
}).map(node => ({ mode: node.dataset.navigationBack, back: node.querySelector('[aria-label^="返回 "]')?.textContent ?? null, forward: !!node.querySelector('[aria-label^="前进到 "]') })))
const backEntry = (page, mode) => page.locator(`[data-navigation-back="${mode}"] [aria-label^="返回 "]`)

async function openTodayFromDot(page) {
  const started = Date.now()
  await page.locator('[data-shell-band="top"] button[aria-label="今日"]').click()
  await today(page).waitFor({ timeout: 15000 })
  return Date.now() - started
}
async function quickLookText(page) {
  const panel = page.locator('[role="dialog"] .rn-ql')
  await panel.waitFor({ timeout: 15000 })
  await page.locator('[role="dialog"] .rn-ql__loading').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  const text = await panel.textContent()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
  return text
}

/** Content the harness vault does not have: a to-do due today, events around now, a FastCard item, a book being read,
 *  an article in 为你筛过的, file activity for 涌现. Everything goes through the app's own IPC. */
async function seedToday(page, { vault, fixtureUrl }) {
  return page.evaluate(async ({ root, fixtureUrl }) => {
    const api = window.electronAPI, out = { errors: [] }
    const pad = n => String(n).padStart(2, '0'), d = new Date(), day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const todo = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '本周待办', content: `# 本周待办\n\n- [ ] 确认印厂排期 📅 ${day}\n- [ ] 改一版封底文案 📅 ${day}\n`, operationId: crypto.randomUUID() })
    if (!todo.ok) out.errors.push(`todo page: ${todo.message}`)
    const calendars = await api.calendar.snapshot()
    const calendarId = calendars?.data?.calendars?.find(c => c.primary)?.id ?? calendars?.data?.calendars?.[0]?.id
    const now = Date.now(), endOfDay = new Date(); endOfDay.setHours(23, 59, 0, 0)
    const events = [['正在进行的通话', now - 5 * 60000, now + 25 * 60000]]
    if (now + 75 * 60000 < endOfDay.getTime()) events.push(['稍后的评审', now + 40 * 60000, now + 70 * 60000])
    for (const [title, start, end] of events) {
      const id = `today-${crypto.randomUUID().slice(0, 8)}`
      const r = await api.calendar.mutate({ type: 'create', event: { id, uid: `${id}@local`, calendarId, title, location: '', start, end, allDay: false, status: 'confirmed', transparency: 'opaque', createdAt: now, updatedAt: now } }, {})
      if (!r.success) out.errors.push(`event ${title}: ${r.error}`)
    }
    const card = await api.browser.addFastCardItem({ id: crypto.randomUUID(), kind: 'text', createdAt: Date.now(), title: '筛子的一句话', text: '一个好的筛子，应该先理解你在做什么。', source: { pageUrl: `${fixtureUrl}/a/0`, pageTitle: '本地模型在端侧推理上的新进展' } })
    if (!card.success) out.errors.push(`fastcard: ${card.error}`)
    const library = await api.library.get()
    const book = library?.data?.books?.[0]
    if (book) {
      const status = await api.library.updateBook({ id: book.id, patch: { status: '在读' } })
      const position = await api.library.setPosition({ bookId: book.id, chapter: 1, offset: 0, pct: 0.21, updatedAt: Date.now() })
      if (!status.success || !position.success) out.errors.push(`book: ${status.error ?? position.error}`)
    } else out.errors.push('book: none on the shelf')
    // A manual 属于基础标准 pins an article into 为你筛过的 without a model (as the 资讯 window check does).
    const definitions = (await api.rss.getDefinitions()).data
    const curated = (Array.isArray(definitions) ? definitions : definitions.definitions).find(entry => entry.kind === 'curated')
    const candidate = (await api.rss.sieveQuery({})).data.remaining.find(item => !item.sieve.explore)
    if (curated && candidate) {
      const article = (await api.rss.readArticle({ itemId: candidate.id, length: 1 })).data.article
      const pinned = await api.rss.setMembership({ itemId: article.id, expectedArticleRevision: article.revision, definitionId: curated.id, expectedRuleRevision: curated.ruleRevision, decision: true })
      if (!pinned.success) out.errors.push(`sieve: ${pinned.error}`)
      out.article = article.title
    } else out.errors.push('sieve: no candidate')
    for (const name of ['新书发布.md', '读书笔记.md']) {
      await api.fileEmergence.recordActivity({ path: `${root}/${name}`, eventType: 'open', source: 'document_mode', workspaceRoots: [root] }).catch(error => out.errors.push(`emergence: ${error}`))
    }
    await api.fileEmergence.getSnapshot({ workspaceRoots: [root], forceRefresh: true }).catch(error => out.errors.push(`emergence: ${error}`))
    return out
  }, { root: vault, fixtureUrl })
}

/** An unsaved draft, typed into a new tab as a person would. */
async function typeDraft(page) {
  await harness.requestMode(page, 'document')
  await page.getByRole('button', { name: '新建标签页' }).click()
  await page.getByRole('button', { name: '添加文字' }).last().click()
  await page.locator('[data-ready-block-editor] [contenteditable="true"]').last().waitFor({ timeout: 15000 })
  await page.keyboard.type('还没想好放哪里的一段话')
  await harness.sleep(1800)
}

async function checkToday(page, ctx) {
  const ms = await openTodayFromDot(page)
  await page.locator('section.today [data-today-block="sieve"] [aria-busy="true"]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  const firstScreen = Number(await today(page).getAttribute('data-first-screen-ms'))
  ctx.timings.push({ click: ms, firstScreen })
  const blocks = await page.locator('section.today [data-today-block]').evaluateAll(nodes => nodes.map(node => node.dataset.todayBlock))
  return { blocks, firstScreen, click: ms }
}

/** Every row: a click opens it (今日 gives way to its target), ⌥-click quick-looks it with content. Rows are found by
 *  their accessible name (type and title), since opening some of them changes what 今日 lists next. */
async function checkRows(page, vault) {
  const rows = await page.locator('section.today .today-row a[data-ready-ref-capsule]').evaluateAll(links => links.map(link => ({ name: link.getAttribute('aria-label'), block: link.closest('[data-today-block]')?.dataset.todayBlock })))
  const result = { rows: rows.length, opened: [], looked: [], failed: [], gone: [], missing: [] }
  for (const row of rows) {
    const link = () => page.locator(`section.today .today-row a[data-ready-ref-capsule][aria-label="${row.name.replace(/["\\]/g, '\\$&')}"]`).first()
    if (!(await link().isVisible().catch(() => false))) { result.missing.push(row.name); continue }
    await link().click()
    const left = await waitFor(async () => !(await today(page).isVisible()) || await page.locator('[data-fastcard-shelf]').isVisible(), 12000)
    const toast = await page.locator('.rn-toast[data-tone="bad"]').first().textContent({ timeout: 300 }).catch(() => null)
    if (left && !toast) result.opened.push(row.name)
    else result.failed.push(`${row.name} did not open${toast ? `: ${toast}` : ''}`)
    await page.evaluate(() => document.querySelector('[data-fastcard-shelf] [aria-label="收起"]')?.click())
    await openTodayFromDot(page)
    // A ticked to-do and an article just read leave 今日 once opened; there is nothing left to quick-look then.
    if (!(await link().isVisible().catch(() => false))) { result.gone.push(row.name); continue }
    await link().click({ modifiers: ['Alt'] })
    const text = await quickLookText(page).catch(error => `ERROR ${error.message}`)
    if (!/^ERROR|引用已失效|无法/.test(text) && !text.includes(vault)) result.looked.push(row.name)
    else result.failed.push(`${row.name} did not quick-look: ${text.slice(0, 120)}`)
  }
  if (result.gone.length) console.log(`  rows that left 今日 after being opened: ${result.gone.join(', ')}`)
  if (result.missing.length) console.log(`  rows that had left 今日 before their turn: ${result.missing.join(', ')}`)
  return result
}

async function crossModeBack(page, ctx) {
  // Start: a page in the document mode.
  await harness.requestMode(page, 'document')
  await page.getByLabel('页面侧栏', { exact: true }).locator('.ink-sb-label-btn', { hasText: '新书发布' }).first().click()
  await waitFor(async () => (await activeTabTitle(page))?.endsWith('新书发布.md') && !(await today(page).isVisible()))
  // 1 · calendar: an event.
  await harness.requestMode(page, 'calendar')
  await page.locator('[data-workbench-mode-panel="calendar"]').getByText('封面评审').first().click()
  await harness.sleep(900)
  // 2 · 资讯: an article.
  await harness.requestMode(page, 'rss')
  await page.locator('nav[aria-label="资讯导航"] [aria-label="全部"]').click()
  await page.locator('[data-workbench-mode-panel="rss"]').getByText('一个人的出版社：独立作者如何做发行').first().click()
  await page.locator('[data-workbench-mode-panel="rss"] [data-rss-article-id][data-navigation-loaded="true"]').waitFor({ timeout: 20000 })
  // 3 · browser: a page typed into the address bar.
  await harness.requestMode(page, 'browser')
  const address = page.getByPlaceholder('搜索或输入网址')
  await address.click()
  await address.fill(`${ctx.fixtureUrl}/a/3`)
  await address.press('Enter')
  await harness.sleep(2500)
  let seen = await entries(page)
  ok('T7 the browser shows the way back, once', seen.length === 1 && seen[0].mode === 'browser' && seen[0].back === '一个人的出版社：独立作者如何做发行', JSON.stringify(seen))
  await shot(page, 'back-1-browser-light')
  const steps = []
  // Back three times: twice with the entry, once with ⌘[; each lands in the mode the entry named.
  await backEntry(page, 'browser').click()
  ok('T7 back 1 → the article in 资讯', await waitFor(() => current(page, 'rss')) && await page.locator('[data-workbench-mode-panel="rss"] [data-rss-article-id]').isVisible())
  seen = await entries(page); steps.push(seen)
  ok('T7 资讯 shows one entry naming the event', seen.length === 1 && seen[0].mode === 'rss' && seen[0].back === '封面评审' && seen[0].forward, JSON.stringify(seen))
  await shot(page, 'back-2-rss-light')
  await page.keyboard.press(`${mod}+BracketLeft`)
  ok('T7 back 2 (⌘[) → the event in the calendar', await waitFor(() => current(page, 'calendar')))
  seen = await entries(page); steps.push(seen)
  ok('T7 the calendar shows one entry naming the page', seen.length === 1 && seen[0].mode === 'calendar' && seen[0].back === '新书发布', JSON.stringify(seen))
  await shot(page, 'back-3-calendar-light')
  await backEntry(page, 'calendar').click()
  ok('T7 back 3 → where it started: 新书发布 in the document mode', await waitFor(async () => await page.locator('.ink-doc-app').isVisible() && (await activeTabTitle(page))?.endsWith('新书发布.md')))
  seen = await entries(page); steps.push(seen)
  ok('T7 the document shows one entry, before the breadcrumb', seen.length <= 1 && (seen.length === 0 || seen[0].mode === 'document') && await page.locator('.ink-topbar-left > [data-navigation-back] + .ink-crumb-wrap').count() <= 1, JSON.stringify(seen))
  await shot(page, 'back-4-document-light')
  // Forward once with the entry's → and once with ⌘].
  await page.locator('[data-navigation-back="document"] [aria-label^="前进到 "]').click()
  ok('T7 → goes forward to the event', await waitFor(() => current(page, 'calendar')))
  await page.keyboard.press(`${mod}+BracketRight`)
  ok('T7 ⌘] goes forward to the article', await waitFor(() => current(page, 'rss')))
}

async function checkSwitcher(page) {
  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: '搜索所有对象和命令' }).waitFor({ timeout: 10000 })
  await harness.sleep(500)
  // The list reads top to bottom: 最近打开 above the list, then the 常用命令 heading inside it.
  return page.evaluate(() => {
    const out = { labels: [...document.querySelectorAll('.rn-switch-label')].map(node => node.textContent), recent: [], commands: [] }
    let section = 'recent'
    for (const node of document.querySelectorAll('#ready-object-results > li')) {
      if (node.classList.contains('rn-switch-label')) { section = 'commands'; continue }
      const row = { name: node.querySelector('.rn-switch-name')?.textContent ?? '', type: node.querySelector('.rn-switch-type')?.textContent ?? '', icon: !!node.querySelector('.rn-switch-icon svg') }
      out[section].push(row)
    }
    return out
  })
}

async function main() {
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-today-check-')))
  const profile = path.join(temp, 'profile'), vault = path.join(temp, '测试资料库')
  const fixture = await harness.startFixtureServer()
  const ctx = { fixtureUrl: fixture.url, timings: [] }
  let session = null
  try {
    // ---- with data ----
    await harness.seedVault({ profile, vault, dataDir: temp, fixtureUrl: fixture.url, log: () => {} })
    session = await harness.launch(profile)
    let { app, page } = session
    ok('T8 Ready opens on 今日 (the default)', await waitFor(() => today(page).isVisible(), 20000) && await page.locator('[data-today-tab][aria-selected="true"]').isVisible())
    const seeded = await seedToday(page, { vault, fixtureUrl: fixture.url })
    if (seeded.errors.length) console.log(`  seeding notes: ${seeded.errors.join(' | ')}`)
    await typeDraft(page)
    const first = await checkToday(page, ctx)
    console.log(`  blocks: ${first.blocks.join(', ')}; first screen ${first.firstScreen} ms; dot to page ${first.click} ms`)
    ok('T8 with data: 接下来, 为你筛过的, 继续 and 收集 show', ['upcoming', 'sieve', 'continue', 'collection'].every(block => first.blocks.includes(block)), first.blocks.join(','))
    // V7: the interface carries no serif; the greeting is the interface font like everything else on the page.
    ok('T8 no serif on the page, the greeting included (V7)', await page.evaluate(() => {
      const fonts = [...document.querySelectorAll('section.today *')].filter(el => el.childElementCount === 0 && el.textContent.trim())
        .map(el => getComputedStyle(el).fontFamily.split(',')[0].replace(/['"]/g, '').trim())
      return fonts.every(font => !/serif/i.test(font) || /sans-serif/i.test(font))
    }))
    ok('T8 the next event counts down, an event under way reads 进行中', await page.locator('section.today .today-time.is-now').count() >= 1, await page.locator('section.today .today-time').allTextContents().then(list => list.join(' / ')))
    ok('T8 继续 holds pages, the book being read with its progress, and the unsaved draft', await page.locator('[data-today-block="continue"] a[data-ref-kind="book"]').count() === 1
      && /读到 21%/.test(await page.locator('[data-today-block="continue"]').textContent()) && /未保存/.test(await page.locator('[data-today-block="continue"]').textContent()))
    ok('T8 收集 shows the total and 整理到画板', /共 \d+ 条/.test(await page.locator('[data-today-block="collection"]').textContent()) && await page.getByRole('button', { name: '整理到画板' }).isVisible())
    await page.getByRole('button', { name: '整理到画板' }).click()
    ok('T8 整理到画板 opens the FastCard shelf, where 保存到画板 is', await waitFor(() => page.locator('[data-fastcard-shelf]').isVisible()) && await page.locator('[data-fastcard-shelf]').getByRole('button', { name: /保存到画板/ }).count() === 1)
    await page.locator('[data-fastcard-shelf] [aria-label="收起"]').click()
    if (seeded.article) ok('T8 为你筛过的 lists the pinned article with its reason', await page.locator('[data-today-block="sieve"] .today-row', { hasText: seeded.article }).count() === 1)
    await page.mouse.move(5, 5)
    await shot(page, 'today-data-light')
    // A to-do ticks in place, and the page itself reads back the tick.
    const todo = page.locator('[data-today-block="upcoming"] .today-row', { hasText: '确认印厂排期' })
    await todo.locator('[role="checkbox"]').click()
    const ticked = await waitFor(() => todo.locator('[role="checkbox"][aria-checked="true"]').isVisible())
    const onDisk = await waitFor(async () => /- \[x\] 确认印厂排期/.test(fs.readFileSync(path.join(vault, '本周待办.md'), 'utf8')))
    ok('T8 a to-do ticks in place and the page file reads back [x]', ticked && onDisk && await today(page).isVisible())
    // Every row opens and quick-looks.
    const rows = await checkRows(page, vault)
    ok(`T8 every row opens (${rows.opened.length}/${rows.rows})`, rows.rows > 10 && rows.opened.length + rows.missing.length === rows.rows && !rows.failed.some(text => text.includes('did not open')), rows.failed.join(' | '))
    ok(`T8 every row still on 今日 quick-looks (${rows.looked.length})`, rows.looked.length > 0 && rows.looked.length + rows.gone.length + rows.missing.length >= rows.rows && !rows.failed.some(text => text.includes('quick-look')), rows.failed.join(' | '))
    // First-screen timing over a few openings.
    for (let i = 0; i < 4; i++) { await harness.requestMode(page, 'calendar'); await checkToday(page, ctx) }
    const screens = ctx.timings.map(timing => timing.firstScreen)
    console.log(`  first screen (ms): ${screens.join(', ')}; dot to page (ms): ${ctx.timings.map(timing => timing.click).join(', ')}`)
    ok('T8 the first screen is on the page within 150 ms', screens.every(value => Number.isFinite(value) && value <= 150), screens.join(','))

    // ---- T7 back across modes ----
    await crossModeBack(page, ctx)
    const switcher = await checkSwitcher(page)
    await shot(page, 'cmdk-empty-light')
    const recentNames = switcher.recent.map(row => row.name)
    ok('⌘K empty input: 最近打开 then 常用命令', JSON.stringify(switcher.labels) === JSON.stringify(['最近打开', '常用命令']), switcher.labels.join(' / '))
    ok('⌘K 最近打开 crosses the modes, newest first, each object once', recentNames.slice(0, 4).join('|') === ['为什么你的稍后读永远读不完', '一个人的出版社：独立作者如何做发行', '封面评审', '新书发布'].join('|')
      && new Set(recentNames).size === recentNames.length, JSON.stringify(switcher.recent.slice(0, 6)))
    ok('⌘K rows show a Chinese type, an icon and no extension', switcher.recent.every(row => /^(页面|数据库|画板|书|划线|资讯|日程|对话|书签|收集)/.test(row.type) && row.icon && !/\.(md|canvas|txt|pdf|epub)$/i.test(row.name)), JSON.stringify(switcher.recent))
    ok('⌘K 常用命令: 今日, 新建页面 and the other common ones, not every command', ['今日', '新建页面', '打开 FastCard', '打开设置'].every(name => switcher.commands.some(row => row.name === name)) && !switcher.commands.some(row => row.name === '关系图谱'), switcher.commands.map(row => row.name).join(' / '))
    await page.keyboard.press('Escape')

    // ---- restart: the history survives; 今日 opens over where the person was ----
    const before = await page.evaluate(async () => (await window.electronAPI.navigationHistory.read()))
    await harness.close(app)
    session = await harness.launch(profile)
    ;({ app, page } = session)
    await today(page).waitFor({ timeout: 20000 })
    const after = await page.evaluate(async () => (await window.electronAPI.navigationHistory.read()))
    ok('T7 the history is the same after a restart', after.entries.length === before.entries.length && after.cursor === before.cursor && after.entries.length >= 4)
    const onToday = await entries(page)
    const currentTitle = after.entries[after.cursor]?.title
    ok('T7 on 今日 after the restart the entry offers the way back to where the person was', onToday.length === 1 && onToday[0].mode === 'document' && onToday[0].back === currentTitle, JSON.stringify({ onToday, currentTitle }))
    await shot(page, 'today-after-restart-light')
    await backEntry(page, 'document').click()
    ok('T7 …and goes there', await waitFor(() => current(page, 'rss')))

    // ---- 设置 › 启动: 回到上次的位置 ----
    await page.evaluate(() => { location.hash = '#/settings?section=startup' })
    await page.getByRole('radio', { name: '回到上次的位置' }).click()
    ok('设置 › 启动 saves 回到上次的位置 in Main', await waitFor(async () => (await page.evaluate(() => window.electronAPI.settings.get('startup_view'))).data === 'last'))
    await shot(page, 'settings-startup-light')
    await page.evaluate(() => { location.hash = '#/workbench' })
    await harness.requestMode(page, 'calendar')
    await harness.sleep(600)
    await harness.close(app)
    session = await harness.launch(profile)
    ;({ app, page } = session)
    ok('with 回到上次的位置, Ready opens in the mode it was left in', await waitFor(() => current(page, 'calendar'), 20000) && !(await today(page).isVisible().catch(() => false)))
    await page.evaluate(() => window.electronAPI.settings.set('startup_view', 'today'))

    // ---- dark ----
    session = await harness.ensureAppearance(profile, session, { theme: 'dark', transparency: null }, {})
    ;({ app, page } = session)
    await today(page).waitFor({ timeout: 20000 })
    await harness.sleep(800)
    await page.mouse.move(5, 5)
    await shot(page, 'today-data-dark')
    await harness.requestMode(page, 'rss')
    await shot(page, 'back-rss-dark')
    await harness.requestMode(page, 'browser')
    await shot(page, 'back-browser-dark')
    await harness.close(app)
    session = null

    // ---- an empty library ----
    const emptyProfile = path.join(temp, 'empty-profile'), emptyVault = path.join(temp, '空资料库')
    fs.mkdirSync(emptyVault, { recursive: true })
    session = await harness.launch(emptyProfile)
    await session.page.evaluate(async root => {
      const result = await window.electronAPI.vault.set(root)
      if (result?.status !== 'ready') throw new Error(`vault not ready: ${JSON.stringify(result).slice(0, 200)}`)
      localStorage.setItem('ready-workspace-root', root)
      localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, emptyVault)
    await harness.close(session.app)
    session = await harness.launch(emptyProfile)
    ;({ app, page } = session)
    await today(page).waitFor({ timeout: 20000 })
    const guide = page.locator('section.today section[aria-label="从这里开始"]')
    ok('T8 an empty library: no block, only the guide', await waitFor(() => guide.isVisible()) && await page.locator('section.today [data-today-block]').count() === 0, await page.locator('section.today').textContent())
    const guideActions = await guide.getByRole('button').allTextContents()
    ok('T8 the guide offers 添加订阅源, 新建第一页 and 导入一本书', ['添加订阅源', '新建第一页', '导入一本书'].every(name => guideActions.includes(name)), guideActions.join(' / '))
    ok('T8 an empty library has no way back yet', (await entries(page)).length === 0)
    await page.mouse.move(5, 5)
    await shot(page, 'today-empty-light')
    await guide.getByRole('button', { name: '添加订阅源' }).click()
    ok('T8 添加订阅源 opens 资讯 with its dialog', await waitFor(() => current(page, 'rss')) && await waitFor(() => page.locator('.rss-add-source-modal').isVisible()))
    await page.locator('.rss-add-source-modal [title="关闭"]').click().catch(() => {})
    session = await harness.ensureAppearance(emptyProfile, session, { theme: 'dark', transparency: null }, {})
    ;({ app, page } = session)
    await today(page).waitFor({ timeout: 20000 })
    await page.mouse.move(5, 5)
    await shot(page, 'today-empty-dark')
  } finally {
    if (session) await harness.close(session.app).catch(() => {})
    fixture.server.close()
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (error) { console.warn('cleanup left files behind:', error.code) }
  }
  console.log(`${passed}/${passed + failed} passed`)
  if (failed) process.exitCode = 1
}

// Exit explicitly: a closed app can leave handles (fixture sockets, Playwright) that keep Node alive.
main().then(() => process.exit(process.exitCode ?? 0), error => { console.error(error); process.exit(1) })
