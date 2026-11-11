// Real-window harness for the W1 design matrix: launch Ready Next on an isolated profile,
// seed a fixed test vault, switch modes and themes. Never opens the daily Ready data:
// every launch passes READY_USER_DATA_DIR pointing at a throwaway directory.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { _electron } = require('playwright')

const REPO = path.resolve(__dirname, '..', '..')

function electronEnv(profile, { hidden = true } = {}) {
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  if (hidden) env.READY_START_HIDDEN = '1'
  else delete env.READY_START_HIDDEN
  return env
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function launch(profile, { hidden = true, width = 1440, height = 900 } = {}) {
  const app = await _electron.launch({
    executablePath: require(path.join(REPO, 'node_modules', 'electron')),
    args: [REPO],
    cwd: REPO,
    env: electronEnv(profile, { hidden }),
    timeout: 60000,
  })
  const deadline = Date.now() + 90000
  let page
  while (!page && Date.now() < deadline) {
    page = app.windows().find(w => w.url().includes('/renderer/index.html'))
    if (!page) await sleep(200)
  }
  if (!page) {
    await app.close().catch(() => {})
    throw new Error('renderer window did not appear within 90s')
  }
  await page.waitForFunction(() => Boolean(window.electronAPI?.vault && window.electronAPI?.theme), null, { timeout: 60000 })
  await setContentSize(app, page, width, height)
  return { app, page }
}

async function setContentSize(app, page, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.getURL().includes('/renderer/index.html')) continue
      win.setContentSize(size.width, size.height)
      win.setPosition(40, 40)
    }
  }, { width, height })
  await page.waitForFunction(size => window.innerWidth === size.width && window.innerHeight === size.height, { width, height }, { timeout: 10000 })
  await sleep(700)
}

// A quit that does not finish is reported and then killed: the profile is throwaway, and an unbounded close would
// hang the whole matrix (a fresh profile's first-launch setup can hold the quit for minutes).
async function close(app, { timeoutMs = 20000 } = {}) {
  const pid = app.process().pid
  const outcome = await Promise.race([
    app.close().then(() => 'closed', () => 'closed'),
    sleep(timeoutMs).then(() => 'timeout'),
  ])
  if (outcome === 'closed') return
  console.warn(`[design-matrix] Ready Next (pid ${pid}) did not quit within ${timeoutMs} ms; killing it`)
  try { process.kill(pid, 'SIGKILL') } catch { /* silent-catch: it exited between the timeout and the kill */ }
}

// The workbench only switches when the scene reports it is current, so the request is repeated
// until the target panel is visible (lesson from the integration plan's real-window runs).
async function requestMode(page, mode) {
  const scene = mode === 'document'
    ? page.locator('.ink-doc-app')
    : page.locator(`[data-workbench-mode-panel="${mode}"][data-mode-visual-state="current"]`)
  const deadline = Date.now() + 30000
  while (!(await scene.first().isVisible().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`${mode} mode did not become current`)
    await page.evaluate(target => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', {
      detail: { mode: target, placement: 'open', presentation: 'immediate' },
    })), mode)
    await sleep(500)
  }
  await sleep(900)
}

// Theme and transparency live in Main (settings table of the isolated profile). The renderer
// only reads them at startup, so a change takes a restart.
async function ensureAppearance(profile, current, { theme, transparency }, launchOptions) {
  let { app, page } = current
  const snapshot = await page.evaluate(() => window.electronAPI.theme.get())
  const data = snapshot?.data ?? {}
  const needsTheme = data.option !== theme
  const supportsTransparency = await page.evaluate(() => typeof window.electronAPI.theme.setReduceTransparency === 'function')
  const needsTransparency = supportsTransparency && transparency && data.transparency !== transparency
  if (!supportsTransparency && transparency === 'reduced') throw new Error('this build has no reduced-transparency setting')
  if (!needsTheme && !needsTransparency) return { app, page }
  if (needsTheme) await page.evaluate(value => window.electronAPI.theme.set(value), theme)
  if (needsTransparency) await page.evaluate(value => window.electronAPI.theme.setReduceTransparency(value === 'reduced'), transparency)
  await close(app)
  ;({ app, page } = await launch(profile, launchOptions))
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    transparency: document.documentElement.dataset.transparency ?? null,
  }))
  if (applied.theme !== theme) throw new Error(`theme ${theme} not applied after restart (got ${applied.theme})`)
  if (supportsTransparency && transparency && applied.transparency !== transparency) {
    throw new Error(`transparency ${transparency} not applied after restart (got ${applied.transparency})`)
  }
  return { app, page }
}

const FEED_ITEMS = [
  ['本地模型在端侧推理上的新进展', 'AI'], ['一个人的出版社：独立作者如何做发行', '创作'], ['JSON Canvas 1.0 之后的白板生态', '工具'],
  ['为什么你的稍后读永远读不完', '效率'], ['浏览器里的智能体：从截图到语义快照', 'AI'], ['日本独立书店的陈列方法', '阅读'],
  ['设计系统的令牌分层实践', '设计'], ['RSS 没有死，只是换了读法', '工具'],
]
const paragraph = n => `第 ${n} 段：信息过载的时代，真正稀缺的不是内容，而是注意力。一个好的筛子，应该先理解你在做什么，再决定把什么放到你面前。`

// Fixed local content: an RSS feed, its articles and a plain page for browser mode.
async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const port = server.address().port
    if (request.url.startsWith('/feed')) {
      // Publication times are fixed offsets from the start of today, so a run is stable within a day.
      const base = new Date(); base.setHours(9, 0, 0, 0)
      const items = FEED_ITEMS.map(([title, tag], i) => `<item><title>${title}</title><link>http://127.0.0.1:${port}/a/${i}</link><guid>matrix-${i}</guid><category>${tag}</category><pubDate>${new Date(base.getTime() - i * 5400000).toUTCString()}</pubDate><description><![CDATA[<p>${paragraph(1)}</p><p>${paragraph(2)}</p>]]></description></item>`).join('')
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>演示订阅源</title><link>http://127.0.0.1:${port}/</link><description>design matrix</description>${items}</channel></rss>`)
      return
    }
    const index = Number(String(request.url).split('/').pop()) || 0
    const title = FEED_ITEMS[index % FEED_ITEMS.length][0]
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font:18px/1.8 -apple-system,sans-serif;max-width:720px;margin:60px auto;padding:0 24px"><h1>${title}</h1>${Array.from({ length: 12 }, (_, i) => `<p>${paragraph(i + 1)}</p>`).join('')}</body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }
}

function writeBook(dir) {
  const file = path.join(dir, '城市漫游者.txt')
  const chapters = Array.from({ length: 6 }, (_, c) => `第${'一二三四五六'[c]}章 街道的记忆\n\n${Array.from({ length: 14 }, (_, i) => `走在第 ${c + 1} 条街上的第 ${i + 1} 个下午，他开始注意那些被忽略的招牌。城市像一本摊开的书，每一条巷子都是脚注，每一盏路灯都是标点。`).join('\n\n')}`)
  fs.writeFileSync(file, chapters.join('\n\n'))
  return file
}

// Two launches: the first binds the vault (a restart is required, a reload is not enough),
// the second creates the content through the same IPC the app uses.
async function seedVault({ profile, vault, dataDir, fixtureUrl, log = () => {} }) {
  fs.mkdirSync(vault, { recursive: true })
  const book = writeBook(dataDir)
  let { app, page } = await launch(profile)
  try {
    await page.evaluate(async root => {
      const result = await window.electronAPI.vault.set(root)
      if (result?.status !== 'ready') throw new Error(`vault not ready: ${JSON.stringify(result).slice(0, 300)}`)
      localStorage.setItem('ready-workspace-root', root)
      localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
  } finally { await close(app) }
  ;({ app, page } = await launch(profile))
  try {
    const result = await page.evaluate(async ({ root, fixtureUrl, book }) => {
      const api = window.electronAPI
      const out = { errors: [] }
      const create = async (title, content, parentObjectId) => {
        const r = await api.documentPages.operate({ type: 'create', root, ...(parentObjectId ? { parentObjectId } : { parentPath: root }), title, content, operationId: crypto.randomUUID() })
        if (!r.ok) throw new Error(`page ${title}: ${r.message}`)
        return r.value
      }
      const day = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10) }
      const project = await create('新书发布', `# 新书发布\n\n这是项目主页。相关：[[选题库]]、[[会议 11-03]]。\n\n> [!tip] 本周重点\n> 确认封面与发行渠道，周五前给出定稿。\n\n## 待办\n\n- [ ] 封面三稿确认 📅 ${day(0)}\n- [ ] 联系印厂报价\n- [x] 书号申请\n\n## 时间线\n\n| 阶段 | 负责人 | 截止 |\n| --- | --- | --- |\n| 定稿 | 白 | 11-20 |\n| 印制 | 印厂 | 12-05 |\n`)
      await create('会议 11-03', '# 会议 11-03\n\n- 参会：白、编辑、设计\n- 结论：封面走第二方向\n\n回到 [[新书发布]]。\n', project.objectId)
      await create('发行渠道调研', '# 发行渠道调研\n\n## 线上\n\n电商、公众号、播客口播。\n\n## 线下\n\n独立书店巡回。\n', project.objectId)
      await create('读书笔记', '# 读书笔记\n\n随手记录。\n')
      const yaml = 'ready_database:\n  version: 1\n  source: 选题库\n  fields:\n    摘要: { id: text, name: 摘要, type: text }\n    状态: { id: status, name: 状态, type: select, options: [想法, 写作中, 已发布] }\n    日期: { id: date, name: 日期, type: date }\n  views:\n    - { id: table, name: 表格, type: table }\n    - { id: board, name: 看板, type: board, groupBy: status, cardFields: [text, date] }\n    - { id: calendar, name: 日历, type: calendar, dateField: date, cardFields: [text] }\n'
      const database = await create('选题库', `---\n${yaml}---\n选题与发布节奏。\n`)
      for (const [title, status, offset] of [['RSS 的筛子理论', '写作中', 2], ['画板到成文的工作流', '想法', 5], ['独立出版手记', '已发布', -6], ['浏览器智能体评测', '想法', 9], ['日历即时间轴', '写作中', 1]]) {
        const row = await api.documentDatabase({ type: 'createRow', databaseId: database.objectId, operationId: crypto.randomUUID(), title, values: { text: `${title}的一句话摘要`, status, date: day(offset) }, body: `# ${title}\n\n正文草稿。\n` })
        if (!row.ok) out.errors.push(`row ${title}: ${String(row.message).slice(0, 200)}`)
      }
      const ids = Array.from({ length: 5 }, () => crypto.randomUUID())
      const textNode = (id, x, y, text, extra = {}) => ({ id, type: 'text', x, y, width: 260, height: 140, text, ready: { kind: 'text' }, ...extra })
      const canvas = await api.canvas.create({ path: '灵感.canvas', operationId: crypto.randomUUID(), canvas: { ready: { id: crypto.randomUUID(), schemaVersion: 1, title: '灵感' }, nodes: [
        textNode(ids[0], 80, 80, '# 筛子\n\n先理解你在做什么，再决定给你看什么。'), textNode(ids[1], 380, 60, '注意力才是稀缺品。', { color: '4' }),
        textNode(ids[2], 380, 240, '- 订阅源\n- 规则\n- 反馈'), textNode(ids[3], 700, 120, '把画板上的卡片排成提纲 → 成文'),
        { id: ids[4], type: 'link', x: 80, y: 280, width: 260, height: 120, url: `${fixtureUrl}/a/2`, ready: { kind: 'link' } },
      ], edges: [{ id: crypto.randomUUID(), fromNode: ids[0], toNode: ids[1] }, { id: crypto.randomUUID(), fromNode: ids[2], toNode: ids[3] }] } })
      if (canvas.ok) await api.canvas.release(canvas.value.handleId)
      else out.errors.push(`canvas: ${String(canvas.error).slice(0, 200)}`)
      const imported = await api.library.importFiles([book])
      if (!imported.success) out.errors.push(`book: ${String(imported.error).slice(0, 200)}`)
      const source = await api.rss.addSource({ name: '演示订阅源', url: `${fixtureUrl}/feed` })
      const sourceId = source?.data?.id ?? source?.id ?? source?.data?.source?.id
      await api.rss.fetchAll(sourceId ? { sourceIds: [sourceId] } : undefined)
      const calendars = await api.calendar.snapshot()
      const calendarId = calendars?.data?.calendars?.find(c => c.primary)?.id ?? calendars?.data?.calendars?.[0]?.id
      const start = new Date(); start.setHours(10, 0, 0, 0)
      for (const [title, dayOffset, hour, location] of [['选题会', 0, 0, '会议室 A'], ['写作：RSS 的筛子理论', 0, 3, ''], ['封面评审', 1, 1, '线上'], ['印厂电话', 2, -1, ''], ['独立书店拜访', 3, 4, '下北泽']]) {
        const s = start.getTime() + dayOffset * 86400000 + hour * 3600000
        const id = `matrix-${crypto.randomUUID().slice(0, 8)}`
        const r = await api.calendar.mutate({ type: 'create', event: { id, uid: `${id}@local`, calendarId, title, location, start: s, end: s + 3600000, allDay: false, status: 'confirmed', transparency: 'opaque', createdAt: s, updatedAt: s } }, {})
        if (!r.success) out.errors.push(`event ${title}: ${String(r.error).slice(0, 200)}`)
      }
      await api.browser.addFastCardItem?.({ id: crypto.randomUUID(), kind: 'text', createdAt: Date.now(), text: '一个好的筛子，应该先理解你在做什么。', source: { url: `${fixtureUrl}/a/0`, title: '本地模型在端侧推理上的新进展' } })
      const indexed = await api.document.reindexWorkspace(root)
      out.indexed = Boolean(indexed?.success)
      const cards = await api.rss.queryCards?.({})
      out.rssCards = cards?.data?.items?.length ?? cards?.data?.cards?.length ?? null
      return out
    }, { root: vault, fixtureUrl, book })
    log(`seeded vault: ${JSON.stringify(result)}`)
    if (result.errors.length) throw new Error(`seed errors: ${result.errors.join(' | ')}`)
    await sleep(2500)
  } finally { await close(app) }
}

module.exports = { REPO, launch, close, setContentSize, requestMode, ensureAppearance, startFixtureServer, seedVault, sleep }
