#!/usr/bin/env node
// W7 T7/T8 real-window check of the browser shell (docs/superpowers/plans/2026-11-11-ready-next-w7-browser-agent-implementation.md
// §4.7, §4.10, §5). Hidden window only; the whole Electron process runs with HOME and TMPDIR in a short throwaway root, a
// throwaway profile and test vault; pages come from scripts/browser-eval/sites on loopback; the person's model is a scripted
// local stand-in (scripts/fixtures/browser-shell-stand-in-model.cjs), so real Codex turns run Ready's production browser
// tools without a real model, network or cost.
//
//   login    T7: the assistant meets a login wall; the band above the page and the task card say so; the band takes its
//            own room (the native page starts below it); one click writes exactly one user message (read back from the
//            conversation) and the assistant's next turn runs; band and card clear.
//   takeover T7: the person takes over while the task holds the page; afterwards 让助手接着做 continues the same way.
//   refusal  T7: with the model removed, the click's refusal is shown on the band in plain words.
//   tabs     T8: the assistant's tabs are their own sidebar group with the task's name and state; clicking a row brings
//            the tab to the front; 全部关闭 closes them through Main.
//   groups   the person's own tab groups: right-click a tab → 添加到新分组 names a new group at once; another tab joins it
//            from the menu; the group collapses and opens; 移出分组 takes a tab out; the model is in the saved snapshot;
//            the assistant's task groups stay as they are and are not offered as groups. With --shots, the dark
//            tour's restart checks that the group came back.
//   download T4/T8: the task card lists the downloaded file as a capsule with type and size; click opens it; Space
//            quick-looks it.
//   sequence plan 2026-11-18: one model call carries several steps. A first write that needs the person's consent
//            stops the sequence before anything runs; made on its own, that step brings up the card; after consent the
//            rest runs in one call and the closing read comes back with the result, once.
//   settings T8: 设置 › 浏览器 — the engine is chosen there; suggestions are off by default and the switch says what
//            turning them on sends. T12: the page-tools experiment is off; turned on, the row says a restart is needed.
//   suggest  T8: typing in the address field lists open tabs and history from this computer (no engine suggestions
//            while off); picking an open tab brings it to the front.
//   find     T8: ⌘F opens the find bar above the page (the page moves down), counts and steps through matches; Esc closes.
//   subscribe T8: a page that declares a feed shows 订阅; one click adds it to 资讯.
//   reading   T8: 阅读视图 shows the article in 资讯's reader in place of the page; 划线 goes to the web page's source
//             page with a link back to the live page at those words.
// Light and dark (reduced transparency) screenshots go to --shots <dir>. --only login,tabs runs a subset.
// Build first: npx electron-vite build. Usage: node scripts/verify-ready-next-browser-shell-electron.cjs [--shots <dir>]
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const harness = require('./design-matrix/harness.cjs')
const { createStandInModel, standInWorkspace } = require('./fixtures/browser-shell-stand-in-model.cjs')

const option = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null }
const shots = option('--shots') ? path.resolve(option('--shots')) : null
const only = new Set((option('--only') || '').split(',').map(item => item.trim()).filter(Boolean))
const runs = name => only.size === 0 || only.has(name)
let passed = 0
let failed = 0
const ok = (name, pass, detail = '') => {
  if (pass) passed++
  else failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail ? ` — ${detail}` : ''}`)
}
const log = (...args) => console.log(`  · ${args.join(' ')}`)

// The Electron process inherits HOME and TMPDIR from here: a short root (socket paths stay short) that is removed after.
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'rnbs-')))
for (const dir of ['home', 'tmp', 'profile', 'vault', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true })
process.env.HOME = path.join(root, 'home')
process.env.TMPDIR = path.join(root, 'tmp')
for (const name of ['READY_REMOTE_DEBUGGING_PORT', 'READY_DB_PATH', 'ELECTRON_RUN_AS_NODE']) delete process.env[name]
const profile = path.join(root, 'profile')
const vault = path.join(root, 'vault')

async function shot(page, name) {
  if (!shots) return
  await harness.sleep(400)
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

async function waitFor(check, timeout = 20000, interval = 200) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await check()) return true } catch { /* the page may be between states; try again */ }
    await harness.sleep(interval)
  }
  return false
}

let launches = 0
async function launch() {
  const session = await harness.launch(profile)
  const stream = fs.createWriteStream(path.join(root, 'logs', `app-${++launches}.log`))
  session.app.process().stdout.on('data', chunk => stream.write(chunk))
  session.app.process().stderr.on('data', chunk => stream.write(chunk))
  session.app.process().on('exit', (code, signal) => log(`app exited code=${code} signal=${signal}`))
  session.page.on('crash', () => log('renderer crashed'))
  session.page.on('close', () => log('main window closed'))
  return session
}

const composer = page => page.evaluate(() => {
  const shell = document.querySelector('[data-chat-composer-shell]')
  return shell ? { blocker: shell.getAttribute('data-ready-composer-blocker') || '', send: shell.getAttribute('data-ready-composer-send-enabled') === 'true' } : null
})

/** A new conversation through the panel's own button; the first one waits for the runtime to start. */
async function newConversation(page) {
  await page.getByRole('button', { name: '新建对话' }).first().click()
  const ready = await waitFor(async () => (await composer(page))?.blocker === '', 240000, 500)
  if (!ready) throw new Error(`conversation not ready: ${JSON.stringify(await composer(page))}`)
}

/** Types into the composer and sends with Enter, as the person does. */
async function send(page, text) {
  const input = page.locator('[data-ready-agent-input="true"]')
  await input.fill(text)
  if (!await waitFor(async () => (await composer(page))?.send === true, 15000)) throw new Error(`send stays disabled: ${JSON.stringify(await composer(page))}`)
  await input.press('Enter')
}

/** The run is over when the stand-in has answered the scenario's last step and the panel is idle again. */
async function waitForReply(page, model, scenario, count = 1, timeout = 120000) {
  const replied = () => model.requests.filter(entry => entry.scenario === scenario && entry.decision?.reply).length >= count
  const settled = await waitFor(async () => replied()
    && (await composer(page))?.blocker === ''
    && !(await page.locator('[data-chat-live-activity="true"]').count()), timeout, 300)
  if (!settled) throw new Error(`no reply for ${scenario}: ${JSON.stringify(model.requests.map(entry => [entry.scenario, entry.results.length, entry.decision]).slice(-6))}`)
  await harness.sleep(800)
}

async function conversationId(page) {
  return page.evaluate(async () => {
    const listed = await window.electronAPI.chat.getConversations('butler')
    const rows = (listed?.data || []).slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    return rows[0]?.id ?? null
  })
}

const scopeMessages = (page, scopeId) => page.evaluate(async id => {
  const result = await window.electronAPI.agent.getConversationScopeMessages(id)
  return (result?.data || []).map(message => ({ id: message.id, role: message.role, content: message.content, meta: message.meta || {} }))
}, scopeId)

const tabsOf = page => page.evaluate(async () => (await window.electronAPI.browser.getTabs()).map(tab => ({
  id: tab.id, url: tab.url, title: tab.title, owner: tab.owner, active: tab.active, browserTaskId: tab.browserTaskId || null,
})))

/** Band and native page in window coordinates: the visible web view's bounds come from Main, not from the DOM. */
async function bandAndPage(app, page) {
  const band = await page.evaluate(() => {
    const node = document.querySelector('[data-browser-task-band]')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
  })
  const views = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(win => (win.contentView.children || [])
    .filter(view => view.webContents)
    .map(view => view.getBounds())
    .filter(bounds => bounds.x >= 0 && bounds.y >= 0 && bounds.width > 1 && bounds.height > 1)))
  return { band, views }
}


const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
// The conversation itself: the composer's liquid glass keeps an inert copy of it for refraction, which has no scroll-root mark.
const CHAT = '[data-liquid-scroll-root="chat-messages"]'
// Long enough to read as an article (Readability's readerable check wants a few paragraphs of substance).
const PARAGRAPH = n => `第 ${n} 段：一个好的筛子，先理解你在做什么，再决定把什么放到你面前。读的时候先看它是不是回答了你的问题，再看它有没有新的东西，最后才看写得好不好；这样留下来的文章，过一段时间再翻，还是值得读的。`

/** A small local site for the shell's own tools: an article that declares its feed (the word 筛子 three times), the feed. */
async function startShellSite() {
  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`
    if (request.url === '/blog/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>筛子小站</title><link>${base}/blog/</link><description>shell check</description><item><title>筛子与阅读</title><link>${base}/blog/sieve</link><guid>sieve-1</guid><description>筛过的才值得读。</description></item></channel></rss>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>筛子与阅读</title><link rel="alternate" type="application/rss+xml" title="筛子小站" href="/blog/feed.xml"></head><body style="font:18px/1.8 -apple-system,sans-serif;max-width:720px;margin:48px auto;padding:0 24px"><article><h1>筛子与阅读</h1><p class="byline">白</p>${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `<p>${PARAGRAPH(i).replace('一个好的筛子', i <= 3 ? '一个好的筛子' : '一个好的过滤器')}</p>`).join('')}</article></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: pathname => `http://127.0.0.1:${server.address().port}${pathname}` }
}

/** Opens a page in a new active tab and waits until it has loaded. */
async function openTab(page, url) {
  const created = await page.evaluate(target => window.electronAPI.browser.createTab(target), url)
  if (!created?.success) throw new Error(`createTab failed: ${JSON.stringify(created)}`)
  if (!await waitFor(async () => (await tabsOf(page)).some(tab => tab.id === created.tabId && tab.active), 20000)) throw new Error(`tab ${url} not active`)
  await harness.sleep(1500)
  return created.tabId
}

const visibleNativeTop = async app => Math.min(...(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(win => (win.contentView.children || [])
  .filter(view => view.webContents).map(view => view.getBounds())
  .filter(bounds => bounds.x >= 0 && bounds.y >= 0 && bounds.width > 1 && bounds.height > 1)))).map(bounds => bounds.y))

async function settingsCase({ page }) {
  await page.getByRole('button', { name: '设置 ⌘,' }).click()
  const nav = page.locator('nav[aria-label="设置分区"] .sx-nav-item', { has: page.locator('.rn-row__label', { hasText: /^浏览器$/ }) })
  await nav.click({ timeout: 20000 })
  const panel = page.locator('[data-browser-search-settings]')
  await panel.waitFor({ timeout: 15000 })
  const toggle = panel.getByRole('switch', { name: '搜索建议' })
  await waitFor(async () => !(await toggle.isDisabled()))
  const description = await panel.locator('.sx-row__desc').nth(1).textContent()
  ok('T8 settings: search suggestions are off by default', (await toggle.getAttribute('aria-checked')) === 'false')
  ok('T8 settings: the switch says what turning it on sends, and to whom', /输入的文字/.test(description) && /Google/.test(description) && /不发给任何人/.test(description), description)
  await shot(page, 'settings-browser-light')
  await panel.getByLabel('搜索引擎').selectOption('duckduckgo')
  const stored = async key => page.evaluate(name => window.electronAPI.settings.get(name).then(result => result?.data ?? null), key)
  ok('T8 settings: choosing DuckDuckGo is saved', await waitFor(async () => (await stored('browser.searchEngine')) === 'duckduckgo'))
  ok('T8 settings: the switch now names DuckDuckGo', await waitFor(async () => /DuckDuckGo/.test(await panel.locator('.sx-row__desc').nth(1).textContent())))
  await toggle.click()
  ok('T8 settings: turning suggestions on is saved', await waitFor(async () => (await stored('browser.searchSuggestions')) === 'true'))
  await toggle.click()
  await waitFor(async () => (await stored('browser.searchSuggestions')) === 'false')
  await panel.getByLabel('搜索引擎').selectOption('google')
  await waitFor(async () => (await stored('browser.searchEngine')) === 'google')
  // The page-tools experiment (W7 T12): off by default; turning it on saves it, and Main's status says it takes a
  // restart, which the row then says too. Turned back off, nothing is pending.
  const experiment = panel.getByRole('switch', { name: '网页自带工具（实验）' })
  const status = async () => JSON.parse((await stored('browser.webmcpExperimentStatus')) || 'null')
  ok('T12 settings: the page-tools experiment is off by default and says what it does', (await experiment.getAttribute('aria-checked')) === 'false'
    && /网页可以提供自己的工具/.test(await panel.textContent()) && !(await panel.locator('[data-webmcp-restart]').count()))
  await experiment.click()
  const pending = await waitFor(async () => (await stored('browser.webmcpExperiment')) === 'true' && (await status())?.restartRequired === true)
  ok('T12 settings: turning it on is saved and Main says it needs a restart; the row says so', pending
    && await waitFor(() => panel.locator('[data-webmcp-restart]').isVisible()), JSON.stringify(await status()))
  await shot(page, 'settings-webmcp-light')
  await experiment.click()
  ok('T12 settings: turning it back off leaves nothing pending', await waitFor(async () => (await stored('browser.webmcpExperiment')) === 'false'
    && (await status())?.restartRequired === false && !(await panel.locator('[data-webmcp-restart]').count())), JSON.stringify(await status()))
  await page.evaluate(() => { window.location.hash = '#/workbench' })
  await harness.requestMode(page, 'browser')
}

async function suggestCase({ page }) {
  const tabs = await tabsOf(page)
  const other = tabs.find(tab => !tab.active && /Eval/.test(tab.title || ''))
  const input = page.getByRole('combobox', { name: '地址' })
  await input.click()
  await input.press(`${mod}+a`)
  await input.pressSequentially('Eval', { delay: 40 })
  const list = page.locator('[role="listbox"][aria-label="地址建议"]')
  ok('T8 suggestions: typing lists suggestions under the address field', await waitFor(() => list.isVisible(), 15000))
  const groups = await list.locator('.rn-menu__group').allTextContents()
  ok('T8 suggestions: open tabs and this computer’s history; no engine suggestions while they are off', groups.includes('已打开的标签') && !groups.includes('搜索建议'), JSON.stringify(groups))
  await shot(page, 'suggestions-light')
  const option = other ? list.locator(`[data-tab-id="${other.id}"]`) : list.locator('[data-suggestion-kind="tab"]').first()
  const targetId = other?.id ?? await option.getAttribute('data-tab-id')
  ok('T8 suggestions: one listbox owns the options', await page.locator('[role="listbox"]').count() === 1)
  await option.click({ timeout: 10000 }).catch(async error => {
    const hit = await option.evaluate(node => {
      const rect = node.getBoundingClientRect()
      const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { rect: [rect.left, rect.top, rect.width, rect.height], at: at ? `${at.tagName}.${at.className}` : null, inside: node.contains(at) }
    }).catch(() => null)
    throw new Error(`picking the suggestion failed: ${JSON.stringify(hit)} ${error.message.split('\n')[0]}`)
  })
  ok('T8 suggestions: picking an open tab brings it to the front', await waitFor(async () => (await tabsOf(page)).find(tab => tab.id === targetId)?.active === true), JSON.stringify(await tabsOf(page)))
  ok('T8 suggestions: the list closes after the pick', await waitFor(async () => !(await list.count())))
}

async function findCase({ app, page, site }) {
  await openTab(page, site.url('/blog/sieve'))
  const before = await visibleNativeTop(app)
  await page.locator('[data-browser-content-frame]').click({ position: { x: 4, y: 4 } }).catch(() => {})
  await page.keyboard.press(`${mod}+f`)
  const bar = page.locator('[data-browser-find-bar]')
  ok('T8 find: ⌘F opens the find bar', await waitFor(() => bar.isVisible(), 10000))
  const barBottom = await bar.evaluate(node => node.getBoundingClientRect().bottom)
  ok('T8 find: the bar takes its own room — the page moves down below it', await waitFor(async () => (await visibleNativeTop(app)) >= barBottom - 0.5), `${before} → ${await visibleNativeTop(app)} / ${barBottom}`)
  const count = bar.locator('.rn-find-bar__count')
  await bar.locator('input').fill('筛子')
  ok('T8 find: matches are counted', await waitFor(async () => /^1\/\d+$/.test((await count.textContent()) || ''), 10000), await count.textContent())
  const total = Number(((await count.textContent()) || '').split('/')[1])
  await bar.locator('input').press('Enter')
  ok('T8 find: Enter steps to the next match', await waitFor(async () => (await count.textContent()) === `2/${total}`, 10000), await count.textContent())
  await shot(page, 'find-bar-light')
  await bar.locator('input').press('Escape')
  ok('T8 find: Esc closes the bar and the page takes its room back', await waitFor(async () => !(await bar.count()) && (await visibleNativeTop(app)) <= before + 0.5, 10000))
}

async function subscribeCase({ page, site }) {
  const button = page.locator('[data-browser-subscribe]')
  ok('T8 subscribe: a page that declares a feed shows 订阅 in the address field', await waitFor(() => button.isVisible(), 15000)
    && (await button.textContent()) === '订阅')
  await shot(page, 'subscribe-light')
  await button.click()
  const feedUrl = site.url('/blog/feed.xml')
  ok('T8 subscribe: one click adds the feed to 资讯', await waitFor(async () => (await page.evaluate(async () => (await window.electronAPI.rss.getSources())?.data || [])).some(source => source.url === feedUrl), 20000))
  ok('T8 subscribe: the button then says 已订阅', await waitFor(async () => (await button.textContent()) === '已订阅'))
}

/** Native page views that are showing now (visible and laid out), in window coordinates. */
const shownNativeViews = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(win => (win.contentView.children || [])
  .filter(view => view.webContents && (typeof view.getVisible !== 'function' || view.getVisible()))
  .map(view => view.getBounds()).filter(bounds => bounds.x >= 0 && bounds.y >= 0 && bounds.width > 1 && bounds.height > 1)))

/** Source pages in the test vault that belong to a web address. */
function webSourcePages(address) {
  const found = [], wanted = `来源引用: ready://web?url=${encodeURIComponent(address)}`
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md') && fs.readFileSync(full, 'utf8').includes(wanted)) found.push(full)
    }
  }
  walk(vault)
  return found
}

async function readingCase({ app, page, site }) {
  const address = site.url('/blog/sieve')
  const toggle = page.locator('[data-browser-reading-toggle]')
  ok('T8 reading: an article page offers 阅读视图 in the address field', await waitFor(() => toggle.isVisible(), 15000))
  await toggle.click()
  const view = page.locator('[data-browser-reading-view]')
  const ready = await waitFor(async () => (await view.getAttribute('data-browser-reading-view').catch(() => null)) === 'ready', 20000)
  ok('T8 reading: the article opens in 资讯’s reader in place of the page, its title once', ready
    && (await view.getByRole('heading', { name: '筛子与阅读' }).count()) === 1 && (await view.locator('[data-ready-reading-run]').count()) > 0,
    ready ? '' : await view.textContent().catch(() => 'no view'))
  ok('T8 reading: the native page steps aside while it is shown', await waitFor(async () => (await shownNativeViews(app)).length === 0, 10000),
    JSON.stringify(await shownNativeViews(app)))
  await shot(page, 'reading-view-light')
  // Select “筛子” in the second paragraph as a pointer would; the shared selection bar comes up over it.
  const picked = await page.evaluate(() => {
    const run = [...document.querySelectorAll('[data-browser-reading-view] [data-ready-reading-run]')].find(node => node.textContent.includes('第 2 段'))
    if (!run) return null
    const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf('筛子')
      if (at < 0) continue
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 2)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      run.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return selection.toString()
    }
    return null
  })
  const bar = page.locator('[data-ready-selection-bar]')
  ok('T8 reading: selecting words brings up the shared selection bar', picked === '筛子' && await waitFor(() => bar.isVisible(), 10000)
    && (await bar.locator('button').allTextContents()).join('|') === '划线|存入 FastCard|引用到文档|问 AI|保存到画板|翻译', picked)
  await shot(page, 'reading-selection-light')
  await bar.locator('[data-selection-action="highlight"]').click()
  const toasts = () => page.locator('.rn-toast').allTextContents().catch(() => [])
  ok('T8 reading: 划线 says it went to the source page', await waitFor(async () => (await toasts()).some(text => /已划线到来源页|已加入来源页/.test(text)), 15000),
    JSON.stringify(await toasts()))
  // The web page's source page holds the words, and its link goes back to the live page at them.
  const sources = await waitFor(() => webSourcePages(address).length === 1, 15000) ? webSourcePages(address) : webSourcePages(address)
  const content = sources.length === 1 ? fs.readFileSync(sources[0], 'utf8') : ''
  const back = [...content.matchAll(/\[原文\]\((ready:\/\/\S+)\) <!--/g)].map(match => new URL(match[1]).searchParams.get('url') || '')
    .find(link => decodeURIComponent(link).includes('-,筛子,-')) || ''
  ok('T8 reading: the highlight lands in the web page’s own source page', sources.length === 1 && /> 筛子\n/.test(content), JSON.stringify(sources))
  const fragment = back.startsWith(`${address}#:~:text=`) ? back.slice(`${address}#:~:text=`.length).split(/-,|,-/).map(part => decodeURIComponent(part)) : []
  const live = await app.evaluate(({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === target)
    return contents ? contents.executeJavaScript('document.body.innerText') : ''
  }, address)
  ok('T8 reading: its link goes back to the live page, at words that sit together there', fragment.length === 3
    && live.replace(/\s+/g, ' ').includes(fragment.join('')), JSON.stringify({ back, fragment }))
  await toggle.click()
  ok('T8 reading: the switch again goes back to the page', await waitFor(async () => !(await view.count()) && (await shownNativeViews(app)).length > 0, 10000))
}

/** Dark (reduced transparency, so a hidden capture shows the real colours): the same places again, for screenshots. */
async function darkTour({ session, model, site }) {
  const { page } = session
  await harness.requestMode(page, 'browser')
  if (groupedTab) {
    // The restart that changed the theme is also the restart the person's groups have to survive.
    const header = page.locator('[data-tab-group-header]')
    ok('groups: after a restart the group, its name and its member are back', await waitFor(async () => (await header.allInnerTexts()).map(text => text.trim()).join() === '资料'
      && await page.locator(`[data-browser-tab="${groupedTab}"]`).getAttribute('data-grouped') === 'true', 15000), JSON.stringify(await header.allInnerTexts()))
  }
  await shot(page, 'tab-groups-dark')
  await openTab(page, site.url('/blog/sieve'))
  await newConversation(page)
  await send(page, '登录场景：再打开一次后台')
  await waitForReply(page, model, 'login', 2)
  await page.locator('[data-browser-task-band]').waitFor({ timeout: 20000 })
  await shot(page, 'login-band-dark')
  // No download card in dark: the run cannot download until Main offers browser_download (see the download case).
  await openTab(page, site.url('/blog/sieve'))
  await page.keyboard.press(`${mod}+f`)
  await page.locator('[data-browser-find-bar] input').fill('筛子')
  await harness.sleep(600)
  await shot(page, 'find-bar-dark')
  await page.locator('[data-browser-find-bar] input').press('Escape')
  await page.locator('[data-browser-reading-toggle]').click()
  await page.locator('[data-browser-reading-view="ready"]').waitFor({ timeout: 20000 })
  await shot(page, 'reading-view-dark')
  await page.locator('[data-browser-reading-toggle]').click()
  const input = page.getByRole('combobox', { name: '地址' })
  await input.click()
  await input.press(`${mod}+a`)
  await input.pressSequentially('Eval', { delay: 40 })
  await page.locator('[role="listbox"][aria-label="地址建议"]').waitFor({ timeout: 15000 })
  await shot(page, 'suggestions-dark')
  await input.press('Escape')
  await page.getByRole('button', { name: '设置 ⌘,' }).click()
  await page.locator('nav[aria-label="设置分区"] .sx-nav-item', { has: page.locator('.rn-row__label', { hasText: /^浏览器$/ }) }).click()
  await page.locator('[data-browser-search-settings]').waitFor({ timeout: 15000 })
  await shot(page, 'settings-browser-dark')
  ok('dark: the band, card, sidebar, find bar, reading view, suggestions and settings render (screenshots)', true)
}

async function main() {
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const { startEvalSites } = await import(path.join(__dirname, 'browser-eval', 'server.mjs'))
  const sites = await startEvalSites({ quiet: true })
  const site = await startShellSite()
  const holds = {}
  const hold = name => new Promise(resolve => { holds[name] = resolve })
  const tabFrom = (turn, index) => turn.findDeep(turn.parsed[index], 'postActionTabId') || turn.findDeep(turn.parsed[index], 'tabId')
  // The steps a model would chain on the form page: fill, submit, wait for the result page, read it. Fields are named
  // by the targets of the snapshot the stand-in took of that page (its third result), as a model addresses fields.
  const fieldOf = (turn, label) => (turn.parsed[2]?.data?.pageMap?.targets || [])
    .find(target => target.role === 'textbox' && String(target.name).includes(label))?.targetId
  // Only the two fields at the top are used: a field below the visible part of the page has to be scrolled to first.
  const formSteps = turn => [
    { tool: 'browser_type', args: { target_id: fieldOf(turn, '姓名'), text: '白' } },
    { tool: 'browser_fill_form', args: { fields: [{ target_id: fieldOf(turn, '邮箱'), value: 'seq-shell@example.test' }], submit: true } },
    { tool: 'browser_wait', args: { tab_id: tabFrom(turn, 1), condition: 'text', text: '已收到' } },
    { tool: 'browser_read', args: { tab_id: tabFrom(turn, 1) } },
  ]
  const model = createStandInModel([
    // Each scenario first observes the page the person is on, as a model does: an action is anchored to an observed
    // document, and a tab opened from it is the task's own (W7 T3).
    { name: 'login', match: /登录场景/, steps: [
      () => ({ tool: 'browser_snapshot', args: {} }),
      () => ({ tool: 'browser_tabs', args: { action: 'open', url: sites.url('/login/') } }),
      turn => ({ tool: 'browser_snapshot', args: { tab_id: tabFrom(turn, 1) } }),
      turn => ({ tool: 'browser_status', args: { tab_id: tabFrom(turn, 1), needs_user: 'login' } }),
      () => ({ reply: '这个后台要先登录。请你在页面上登录，好了点“我处理好了，继续”。' }),
    ] },
    { name: 'login-help', match: /我已完成登录/, steps: [() => ({ reply: '好的，我重新检查了页面，接着处理原任务。' })] },
    { name: 'download', match: /下载场景/, steps: [
      () => ({ tool: 'browser_snapshot', args: {} }),
      () => ({ tool: 'browser_tabs', args: { action: 'open', url: sites.url('/downloads/') } }),
      turn => ({ tool: 'browser_snapshot', args: { tab_id: tabFrom(turn, 1) } }),
      () => ({ tool: 'browser_download', args: { mode: 'urls', urls: [sites.url('/downloads/files/report-2026-q3.csv')] } }),
      () => ({ reply: '第三季度报表下载好了。' }),
    ] },
    // One call, several steps. The first write on this origin needs consent, which a sequence never asks for mid-way:
    // the stand-in is turned away, makes that step on its own (the card appears for it), then sends the rest.
    { name: 'sequence', match: /连续动作场景/, steps: [
      () => ({ tool: 'browser_snapshot', args: {} }),
      () => ({ tool: 'browser_tabs', args: { action: 'open', url: sites.url('/form/') } }),
      turn => ({ tool: 'browser_snapshot', args: { tab_id: tabFrom(turn, 1) } }),
      turn => ({ tool: 'browser_sequence', args: { steps: formSteps(turn) } }),
      turn => ({ tool: 'browser_type', args: { target_id: fieldOf(turn, '姓名'), text: '白' } }),
      turn => ({ tool: 'browser_sequence', args: { steps: formSteps(turn) } }),
      turn => ({ reply: `完成页写着：${/已收到 [^\s"\\]+ 的留言/.exec(JSON.stringify(turn.parsed[5]?.data?.observation || ''))?.[0] || '没有读到'}` }),
    ] },
    { name: 'takeover', match: /接管场景/, steps: [
      () => ({ tool: 'browser_snapshot', args: {} }),
      () => ({ tool: 'browser_tabs', args: { action: 'open', url: sites.url('/form/') } }),
      turn => ({ tool: 'browser_snapshot', args: { tab_id: tabFrom(turn, 1) } }),
      turn => ({ tool: 'browser_type', args: { tab_id: tabFrom(turn, 1), selector: 'input', text: '张三' } }),
      async () => { await hold('takeover'); return { reply: '你接管了页面，我先停下。' } },
    ] },
    { name: 'takeover-help', match: /接着处理原任务/, steps: [() => ({ reply: '好的，我从当前页面接着做。' })] },
  ])
  const port = await model.start()
  let session = null
  try {
    // First launch: the stand-in model and the test vault, as 设置 writes them; the vault binds on the next start.
    session = await launch()
    const configured = await session.page.evaluate(async ({ workspace, vaultRoot }) => {
      const saved = await window.electronAPI.settings.setAIWorkspace(workspace)
      const bound = await window.electronAPI.vault.set(vaultRoot)
      return { saved: saved?.success === true, vault: bound?.status }
    }, { workspace: standInWorkspace(port), vaultRoot: vault })
    if (!configured.saved || configured.vault !== 'ready') throw new Error(`setup failed: ${JSON.stringify(configured)}`)
    await harness.close(session.app)
    session = await launch()
    const { app, page } = session
    await harness.requestMode(page, 'browser')
    await page.evaluate(url => window.electronAPI.browser.createTab(url), sites.url('/'))
    await newConversation(page)
    log('conversation ready')

    // Each case stands alone: one that throws is counted and reported, and the rest still run.
    const run = async (name, body) => {
      if (!runs(name)) return
      try {
        await body()
      } catch (error) {
        failed++
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
        if (shots) await page.screenshot({ path: path.join(shots, `failure-${name}.png`) }).catch(() => {})
        await harness.requestMode(page, 'browser').catch(() => {})
      }
    }
    await run('login', () => loginCase({ app, page, model, sites }))
    await run('download', () => downloadCase({ app, page, model }))
    await run('sequence', () => sequenceCase({ page, model, sites }))
    await run('groups', () => groupsCase({ page, site }))
    await run('tabs', () => tabsCase({ app, page }))
    await run('takeover', () => takeoverCase({ app, page, model, holds }))
    await run('settings', () => settingsCase({ page }))
    await run('suggest', () => suggestCase({ page }))
    await run('find', () => findCase({ app, page, site }))
    await run('subscribe', () => subscribeCase({ page, site }))
    await run('reading', () => readingCase({ app, page, site }))
    if (shots && runs('dark')) {
      // The relaunched app is the session from here on, so it is closed below whatever the tour does.
      session = await harness.ensureAppearance(profile, session, { theme: 'dark', transparency: 'reduced' })
      await darkTour({ session, model, site })
    }
  } catch (error) {
    failed++
    console.log(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
    if (session && shots) await session.page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
  } finally {
    for (const release of Object.values(holds)) release()
    // What the stand-in was asked and answered, for a failed run's reader (removed with the root unless kept).
    fs.writeFileSync(path.join(root, 'logs', 'stand-in.json'), JSON.stringify(model.requests.map(entry => ({
      seq: entry.seq, scenario: entry.scenario, user: entry.user.slice(0, 120), browserTools: entry.tools.filter(name => name.startsWith('browser_')),
      results: entry.results.map(text => text.slice(0, 600)), decision: entry.decision,
    })), null, 1))
    if (session) await harness.close(session.app).catch(() => {})
    await model.close()
    await sites.close()
    site.server.close()
    if (process.env.KEEP_BROWSER_SHELL_ROOT) console.log(`kept ${root}`)
    else fs.rmSync(root, { recursive: true, force: true })
  }
  console.log(`${passed}/${passed + failed} passed`)
  if (failed) process.exitCode = 1
}

async function loginCase({ app, page, model }) {
  await send(page, '登录场景：打开后台看看')
  await waitForReply(page, model, 'login')
  const band = page.locator('[data-browser-task-band][data-reason="login"]')
  ok('T7 login: the band above the page says what is needed', await waitFor(() => band.isVisible(), 20000)
    && (await band.getAttribute('aria-label')) === '需要你来完成登录')
  const tabs = await tabsOf(page)
  const loginTab = tabs.find(tab => tab.url.includes('/login/'))
  ok('T7 login: Main brought the login page to the front', Boolean(loginTab?.active && loginTab.browserTaskId), JSON.stringify(tabs))
  const geometry = await bandAndPage(app, page)
  const below = Boolean(geometry.band) && geometry.views.length > 0 && geometry.views.every(view => view.y >= geometry.band.bottom - 0.5)
  ok('T7 login: the band takes its own room — the native page starts below it', below, JSON.stringify(geometry))
  const card = page.locator(`${CHAT} [data-browser-task-card] [role="region"][aria-label="需要你来完成登录"]`)
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-liquid-scroll-root="chat-messages"] [data-browser-task-card]')].map(node => ({
    task: node.getAttribute('data-browser-task-card'), run: node.closest('[data-browser-task-cards]')?.getAttribute('data-browser-task-cards'),
    message: node.closest('[data-message-id]')?.getAttribute('data-message-id'), visible: node.getBoundingClientRect().height > 0,
  })))
  ok('T7 login: the task card under the reply shows the need and the button', await card.count() === 1 && await card.isVisible()
    && (await card.locator('button').allTextContents()).join('|') === '打开页面|我处理好了，继续', JSON.stringify(cards))
  const group = page.locator(`[data-browser-task-group="${loginTab?.browserTaskId}"]`)
  ok('T8 the login task is its own sidebar group: name and 等你处理', await group.isVisible()
    && /登录场景/.test(await group.getAttribute('aria-label')) && /等你处理/.test(await group.getAttribute('aria-label')))
  await shot(page, 'login-band-light')

  const scopeId = await conversationId(page)
  const before = await scopeMessages(page, scopeId)
  await band.locator('button').click()
  await waitForReply(page, model, 'login-help')
  const after = await scopeMessages(page, scopeId)
  const added = after.filter(message => !before.some(old => old.id === message.id))
  const help = added.filter(message => message.role === 'user')
  ok('T7 login: one click writes exactly one user message (read back from the conversation)', help.length === 1
    && help[0].id.startsWith(`browser-help:${loginTab?.browserTaskId}:`) && help[0].content.startsWith('我已完成登录'), JSON.stringify(added.map(m => [m.role, m.id, m.content.slice(0, 40)])))
  ok('T7 login: the task continues — the assistant answered the new input', added.some(message => message.role === 'assistant' && message.content.includes('接着处理原任务')))
  ok('T7 login: band and card clear once the input is in', await waitFor(async () => !(await band.count()) && !(await card.count()), 15000))
  const shown = page.locator(`${CHAT} [data-message-id="${help[0]?.id}"]`)
  const shownText = await shown.count() === 1 ? (await shown.innerText()).trim() : ''
  ok('T7 login: the conversation shows the new message — its sentence, not the task ids the assistant gets',
    shownText.startsWith('我已完成登录') && Boolean(help[0]?.content.startsWith(shownText)) && !shownText.includes('browser-task-'),
    JSON.stringify({ shown: shownText.slice(0, 120), stored: help[0]?.content.slice(0, 120) }))
  await shot(page, 'login-continued-light')
}

async function downloadCase({ page, model }) {
  await send(page, '下载场景：把第三季度报表下下来')
  await waitForReply(page, model, 'download').catch(error => {
    // Name the cause when the run's gateway refused the download tool: that is Main's tool surface, not this interface.
    const decisions = path.join(root, 'tmp', 'ready-directchat.log')
    const refused = fs.existsSync(decisions) && /gateway_response_tool_not_authorized/.test(fs.readFileSync(decisions, 'utf8'))
    const asked = model.requests.some(entry => entry.scenario === 'download' && entry.decision?.tool === 'browser_download')
    const offered = model.requests.filter(entry => entry.scenario === 'download').every(entry => entry.tools.includes('browser_download'))
    if (asked && refused && !offered) throw new Error('blocked by Main: browser_download is not on the Codex turn’s tool surface, so the run is refused when the model calls it (no receipt can exist)')
    throw error
  })
  const capsule = page.locator(`${CHAT} [data-browser-download-receipt] a[data-ready-ref-capsule]`).first()
  ok('T4 download: the task card lists the file as a capsule', await waitFor(() => capsule.isVisible(), 20000)
    && (await capsule.textContent()) === 'report-2026-q3' && (await capsule.getAttribute('data-ref-kind')) === 'file')
  const size = await page.locator(`${CHAT} [data-browser-download-receipt] .rn-task-card__size`).first().textContent()
  ok('T4 download: with type and size', /^CSV · \d/.test(size || ''), size)
  await shot(page, 'download-card-light')
  // Space belongs to whatever has the keyboard: right after sending, that is the composer, where it types. Move off it first.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await capsule.hover()
  await harness.sleep(300)
  await page.keyboard.press('Space')
  const look = page.locator('[role="dialog"] .rn-ql')
  ok('T4 download: hover then Space quick-looks the file', await waitFor(() => look.isVisible(), 15000))
  await shot(page, 'download-quicklook-light')
  await page.keyboard.press('Escape')
  await capsule.click()
  ok('T4 download: click opens the file', await waitFor(async () => /report-2026-q3/.test((await page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('title').catch(() => '')) || ''), 20000))
  await harness.requestMode(page, 'browser')
}

/** The tab left in the group 资料 by the groups case; the dark tour's restart reads it back. */
let groupedTab = null

/** The person's tab groups, through the tab's right-click menu and the group header, as the person uses them. */
async function groupsCase({ page, site }) {
  const first = await openTab(page, site.url('/blog/one'))
  const second = await openTab(page, site.url('/blog/two'))
  await openTab(page, site.url('/blog/three'))
  const row = id => page.locator(`[data-browser-tab="${id}"]`)
  const menu = page.locator('[role="menu"][aria-label="标签页"]')
  const header = page.locator('[data-tab-group-header]')
  const taskGroups = await page.locator('[data-browser-task-group]').count()
  const snapshot = () => page.evaluate(() => JSON.parse(localStorage.getItem('ready-browser-tabs-v1') || '{}'))
  if (shots) await shot(page, 'tab-groups-before-light')

  await row(first).click({ button: 'right' })
  await menu.waitFor({ timeout: 10000 })
  const labels = await menu.locator('.rn-menu__label').allTextContents()
  ok('groups: the tab menu offers 添加到新分组 beside 引用到输入框 and 关闭标签页', ['引用到输入框', '添加到新分组', '关闭标签页'].every(label => labels.includes(label)) && !labels.includes('移出分组'), JSON.stringify(labels))
  await shot(page, 'tab-menu-light')
  await menu.getByRole('menuitem', { name: '添加到新分组' }).click()
  const name = page.locator('.browser-tab-list__editor input')
  ok('groups: the new group is in the list with its name field focused', await waitFor(async () => await header.count() === 1 && await name.evaluate(node => node === document.activeElement), 10000)
    && await row(first).getAttribute('data-grouped') === 'true')
  await page.keyboard.type('资料')
  await shot(page, 'tab-group-editor-light')
  await page.keyboard.press('Enter')
  ok('groups: typing a name and Enter names the group', await waitFor(async () => (await header.innerText()).trim() === '资料' && !(await name.count()), 10000), await header.innerText())

  await row(second).click({ button: 'right' })
  await menu.waitFor({ timeout: 10000 })
  ok('groups: the menu lists the group under 添加到分组', (await menu.locator('.rn-menu__group').allTextContents()).includes('添加到分组'))
  await menu.getByRole('menuitem', { name: '资料' }).click()
  ok('groups: the second tab joins the group from the menu', await waitFor(async () => await row(second).getAttribute('data-grouped') === 'true', 10000))
  await shot(page, 'tab-groups-light')

  const pill = header.locator('button').first()
  await pill.click()
  ok('groups: the header collapses the group (its tabs leave the list)', await waitFor(async () => !(await row(first).count()) && !(await row(second).count()), 10000))
  await shot(page, 'tab-groups-collapsed-light')
  await pill.click()
  ok('groups: and opens it again', await waitFor(async () => await row(first).count() === 1 && await row(second).count() === 1, 10000))

  await row(second).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: '移出分组' }).click()
  ok('groups: 移出分组 takes the tab out and the group keeps the other', await waitFor(async () => await row(second).getAttribute('data-grouped') === null, 10000)
    && await row(first).getAttribute('data-grouped') === 'true' && await header.count() === 1)

  // The model that a restart reads back: the saved snapshot holds the group and its member (written when idle).
  const saved = await waitFor(async () => {
    const data = await snapshot()
    const group = (data.tabGroups || []).find(item => item.name === '资料')
    return Boolean(group) && data.tabs.find(tab => tab.id === first)?.groupId === group.id && !data.tabs.find(tab => tab.id === second)?.groupId
  }, 10000)
  ok('groups: the saved tab snapshot holds the group, its name and its member', saved, JSON.stringify((await snapshot()).tabGroups))
  const mainIds = (await tabsOf(page)).map(tab => tab.id)
  if (saved) groupedTab = first
  ok('groups: Main still lists every tab (groups are the list’s own)', [first, second].every(id => mainIds.includes(id)))
  ok('groups: the assistant’s task groups are untouched and are not user groups', await page.locator('[data-browser-task-group]').count() === taskGroups
    && await page.locator('[data-browser-task-group] [data-tab-group-header]').count() === 0)
}

async function tabsCase({ page }) {
  const tabs = await tabsOf(page)
  const taskIds = [...new Set(tabs.map(tab => tab.browserTaskId).filter(Boolean))]
  ok('T8 tabs: the assistant’s tabs carry their task', taskIds.length >= 1, JSON.stringify(tabs))
  const own = await page.locator('[aria-label="打开的标签页"] [role="listitem"]').count()
  ok('T8 tabs: the person’s list keeps only the person’s tabs', own === tabs.filter(tab => !tab.browserTaskId).length)
  const groups = page.locator('[data-browser-task-group]')
  ok('T8 tabs: one group per task, with name and state', await groups.count() === taskIds.length
    && (await groups.locator('.browser-task-group__state').allTextContents()).every(text => ['运行中', '等你处理', '已完成'].includes(text)))
  await shot(page, 'sidebar-groups-light')
  const target = tabs.find(tab => tab.browserTaskId && !tab.active)
  if (target) {
    await page.locator(`[data-browser-task-tab="${target.id}"]`).click()
    ok('T8 tabs: clicking a task tab brings it to the front', await waitFor(async () => (await tabsOf(page)).find(tab => tab.id === target.id)?.active))
  }
  const id = taskIds[0]
  const group = page.locator(`[data-browser-task-group="${id}"]`)
  await group.hover()
  await group.locator('.browser-task-group__close').click()
  ok('T8 tabs: 全部关闭 closes the task’s tabs through Main', await waitFor(async () => !(await tabsOf(page)).some(tab => tab.browserTaskId === id && tab.owner === 'agent'))
    && await waitFor(async () => !(await group.count())))
}

async function sequenceCase({ page, model, sites }) {
  await send(page, '连续动作场景：把表单填好提交，再告诉我完成页写了什么')
  // The stand-in's sequence is turned away at its first write; the same step made on its own asks the person.
  const confirm = page.locator(`${CHAT} [role="dialog"][aria-label="Agent 反问卡片"]`)
  const asked = await waitFor(async () => (await confirm.count()) > 0, 90000)
  ok('sequence: the step that needs consent brings up the card once it is called on its own', asked)
  if (asked) {
    await confirm.getByRole('button', { name: '确认执行' }).click()
    await confirm.getByRole('button', { name: '提交回答' }).click()
  }
  await waitForReply(page, model, 'sequence')
  // The request the stand-in answered with its reply: by then it had been given every tool result of the turn.
  const last = model.requests.filter(entry => entry.scenario === 'sequence' && entry.decision?.reply).at(-1)
  const parsed = (last?.results || []).map(text => { try { return JSON.parse(text) } catch { return null } })
  const refused = parsed[3]?.data
  const done = parsed[5]?.data
  ok('sequence: the tool is on the surface the model was offered', Boolean(last?.tools.includes('browser_sequence')))
  ok('sequence: a first write that needs consent stops the whole sequence before anything runs',
    refused?.ok === false && refused.errorKind === 'denied_pending_confirmation' && refused.stoppedAt === 1
      && Array.isArray(refused.steps) && refused.steps.length === 0 && refused.notExecuted?.length === 4
      && refused.failure?.step === 1 && /单独调用 browser_type/.test(String(refused.message)), JSON.stringify(refused).slice(0, 400))
  ok('sequence: after consent all four steps run in one call',
    done?.ok === true && Array.isArray(done.steps) && done.steps.length === 4 && done.steps.every(step => step.ok === true)
      && done.steps[1]?.tool === 'browser_fill_form' && /\/form\/done/.test(String(done.steps[1]?.url)), String(last?.results[5]).slice(0, 1500))
  ok('sequence: the closing read comes back with the result, and the model receives it once',
    done?.observation?.tool === 'browser_read' && done.observation.data?.format === 'markdown'
      && String(done.observation.data?.content).includes('已收到 白 的留言') && parsed[5] && !('text' in parsed[5]),
    JSON.stringify(Object.keys(parsed[5] || {})))
  const row = sites.records('form.submit').map(entry => entry.data).find(entry => entry.email === 'seq-shell@example.test')
  ok('sequence: the form reached the server as filled', row?.name === '白', JSON.stringify(row))
  ok('sequence: the reply quotes the page the sequence read', String(last?.decision?.reply).includes('已收到 白 的留言'), String(last?.decision?.reply))
}

async function takeoverCase({ app, page, model, holds }) {
  await send(page, '接管场景：在表单里填上名字')
  // Typing on the page is a write: Main asks once before the task may change pages on this origin (W7 T10). Answer it
  // as the person does, through the card in the conversation.
  const confirm = page.locator(`${CHAT} [role="dialog"][aria-label="Agent 反问卡片"]`)
  const asked = await waitFor(async () => Boolean(holds.takeover) || (await confirm.count()) > 0, 60000)
  if (asked && !holds.takeover) {
    await confirm.getByRole('button', { name: '确认执行' }).click()
    await confirm.getByRole('button', { name: '提交回答' }).click()
  }
  // The task holds the form page; the person takes over while the run is still going.
  const holding = await waitFor(() => Boolean(holds.takeover), 60000)
  ok('T7 takeover: the task holds the page', holding)
  const taken = await page.evaluate(() => window.electronAPI.browser.requestAgentInterruption())
  ok('T7 takeover: the person takes over', taken?.frozen === true, JSON.stringify(taken))
  holds.takeover?.()
  await waitForReply(page, model, 'takeover')
  const band = page.locator('[data-browser-task-band][data-reason="takeover"]')
  const card = page.locator(`${CHAT} [data-browser-task-card] [role="region"][aria-label="你接管了这个页面"]`)
  const shown = await waitFor(async () => (await card.count()) > 0, 20000)
  ok('T7 takeover: after the run the card offers 让助手接着做', shown && (await card.locator('button').last().textContent()) === '让助手接着做')
  const tab = (await tabsOf(page)).find(entry => entry.url.includes('/form/'))
  if (tab && !tab.active) await page.locator(`[data-browser-task-tab="${tab.id}"], [aria-label="打开的标签页"] [title]`).first().click().catch(() => {})
  await shot(page, 'takeover-light')
  const scopeId = await conversationId(page)
  const before = await scopeMessages(page, scopeId)
  const control = await page.evaluate(async () => {
    const state = await window.electronAPI.browser.getAgentSupervisionState()
    return { controlState: state?.controlState ?? null, userOwned: (state?.claims || []).filter(claim => claim.state === 'user_owned').length }
  })
  await card.locator('button').last().click()
  await waitForReply(page, model, 'takeover-help').catch(async error => {
    // Name the cause when the help input was written but its run ended before the model was asked.
    const written = (await scopeMessages(page, scopeId)).filter(message => !before.some(old => old.id === message.id))
    const sent = written.some(message => message.role === 'user' && message.id.startsWith('browser-help:'))
    const ended = written.find(message => message.role === 'assistant' && /browser-help:/.test(message.id))
    const asked = model.requests.some(entry => entry.scenario === 'takeover-help')
    if (sent && ended && !asked) {
      throw new Error(`blocked by Main: the help input was written, but its run ended at once (“${ended.content}”) without asking the model; browser control at the click: ${JSON.stringify(control)}`)
    }
    throw error
  })
  const added = (await scopeMessages(page, scopeId)).filter(message => !before.some(old => old.id === message.id))
  const help = added.filter(message => message.role === 'user')
  ok('T7 takeover: one click writes exactly one user message and the assistant goes on', help.length === 1 && help[0].id.startsWith('browser-help:')
    && help[0].content.startsWith('请重新检查页面后接着处理原任务') && added.some(message => message.role === 'assistant'), JSON.stringify(added.map(m => [m.role, m.id])))
  ok('T7 takeover: band and card clear', await waitFor(async () => !(await band.count()) && !(await card.count()), 15000))
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
