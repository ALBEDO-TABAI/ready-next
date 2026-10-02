#!/usr/bin/env node
'use strict'
// Runs synthetic content, a local model-protocol fixture and an isolated Ready profile. No external model calls.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { spawnSync } = require('node:child_process')
const { _electron } = require('playwright')

// waitForFunction treats a Promise as truthy before its IPC result resolves; poll the resolved receipt instead.
async function waitForIPC(page, predicate, argument, options = {}) {
  const deadline = Date.now() + (options.timeout || 15000)
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('IPC condition did not become true before the deadline')
}

async function revealTitle(page, title) {
  const holder = page.locator('.rss-feed-list [data-liquid-scroll-root="rss-feed-list"]')
  const row = page.locator('.rss-news-card').getByText(title, { exact: true })
  for (let step = 0; step < 200; step++) {
    if (await row.count()) {
      try { await row.first().scrollIntoViewIfNeeded(); return }
      catch (error) { if (!String(error).includes('not attached')) throw error }
    }
    await holder.evaluate((node) => { node.scrollTop = node.scrollTop + node.clientHeight >= node.scrollHeight - 1 ? 0 : node.scrollTop + node.clientHeight * .7 })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  throw new Error(`RSS title not reached in virtual list: ${title}`)
}

async function main() {
  const installMediaFixture = (page) => page.route('https://rss-media.invalid/*', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#087f8c"/><path d="M130 50L210 90L130 130Z" fill="white"/></svg>' }))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-rss-reader-'))
  const evidence = process.argv[2] || path.join(os.tmpdir(), `ready-rss-reader-evidence-${Date.now()}`)
  fs.mkdirSync(evidence, { recursive: true })
  fs.rmSync(path.join(evidence, 'result.json'), { force: true })
  let authenticatedFetches = 0
  let videoFetches = 0
  let modelRequests = 0, holdModelResponse = false, updatedProcessingFeed = false, eventFeedVersion = 0, eventArticleChanged = false, eventArticleFailure = false
  let holdAnalysisResponse = false, releaseAnalysisResponse = null
  const server = createServer(async (req, res) => {
    if (req.url === '/video.mp4') { videoFetches++; res.writeHead(404); res.end('This reference must not be downloaded automatically'); return }
    if (req.url === '/event-feed') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      const statements = ['Seed history only.', 'Project Delta released Version 2.', 'Project Delta released Version 2.', 'Project Delta added image editing.']
      const entries = statements.slice(0, eventFeedVersion + 1).map((text, index) => `<item><guid>delta-${index}</guid><title>${index ? `Project Delta 报道 ${index}` : '事件验收历史种子'}</title><link>http://${req.headers.host}/event-article/${index}</link><description>${text}</description></item>`).join('')
      res.end(`<rss version="2.0"><channel><title>事件验收</title><link>http://${req.headers.host}</link><description>Local fixture</description>${entries}</channel></rss>`)
      return
    }
    if (req.url?.startsWith('/event-article/')) {
      if (eventArticleFailure) { res.writeHead(503); res.end('Synthetic refresh failure'); return }
      const statement = eventArticleChanged ? 'Updated body without a release statement.' : 'Project Delta released Version 2.'
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><title>Project Delta</title><body><article><h1>Project Delta</h1><p>${statement}</p><p>${'This synthetic original report provides details about the release. '.repeat(30)}</p></article></body></html>`)
      return
    }
    if (req.url === '/processing-feed') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      const article = (id, title) => `<item><guid>${id}</guid><title>${title}</title><link>http://127.0.0.1/article/${id}</link><description>Version 2 supports video editing.</description></item>`
      res.end(`<rss version="2.0"><channel><title>自动整理验收</title><link>http://127.0.0.1</link><description>Local fixture</description>${article('processing-history', '自动整理历史资讯')}${updatedProcessingFeed ? article('processing-new', '自动整理新增资讯') : ''}</channel></rss>`)
      return
    }
    if (req.url === '/v1/chat/completions') {
      modelRequests++
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const user = request.messages.find((message) => message.role === 'user')
      const userText = typeof user.content === 'string' ? user.content : user.content.map((part) => part.text || '').join('')
      if (userText.startsWith('标题:')) {
        if (holdAnalysisResponse) await new Promise((resolve) => { releaseAnalysisResponse = resolve })
        const text = `## 一、TextContent Analysis 视角\n合成报告 ${modelRequests}，只验证保存流程。\n## 二、Viral-Abstract-Script 视角\n不评估真实模型质量。\n## 三、Brainstorming 视角\n保留原始资料。`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ id: 'local-rss', model: 'local-rss-test', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'local-rss', model: 'local-rss-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
        return
      }
      const input = JSON.parse(userText)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (holdModelResponse) { res.write(': waiting for cancellation\n\n'); return }
      let event = input.eventContext && !input.eventContext.manual && !input.eventContext.reused ? { kind: 'insufficient', eventId: null, factId: null, quote: null, sourceRole: 'unknown', reason: '合成分类验收不强行归组。' } : undefined
      if (event && (input.source.text.includes('Project Delta released Version 2.') || input.source.text.includes('Project Delta added image editing.'))) {
        const prior = input.eventContext.candidates.find((candidate) => candidate.facts.some((fact) => fact.quote === 'Project Delta released Version 2.'))
        const release = prior?.facts.find((fact) => fact.quote === 'Project Delta released Version 2.')
        const progress = input.source.text.includes('Project Delta added image editing.')
        event = { kind: prior ? progress ? 'progress' : 'duplicate' : 'new', eventId: prior?.id || null,
          factId: prior && !progress ? release.id : null, quote: progress ? 'Project Delta added image editing.' : 'Project Delta released Version 2.',
          sourceRole: prior && !progress ? 'secondary' : 'direct', reason: progress ? 'A concrete subsequent development.' : 'The same original release.' }
      }
      const text = JSON.stringify({ ...(event ? { event } : {}), decisions: input.definitions.map((definition) => ({ definitionId: definition.id, included: true, reason: '合成验收：提供的原文包含可核对内容。', evidence: input.source.text.slice(0, 32) })) })
      res.end(`data: ${JSON.stringify({ id: 'local-rss', model: 'local-rss-test', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'local-rss', model: 'local-rss-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (req.url === '/login') {
      res.setHeader('set-cookie', 'rss_reader_test=verified; Path=/; HttpOnly; SameSite=Lax')
      res.end('<html><body>Local login complete</body></html>')
      return
    }
    if (!req.headers.cookie?.includes('rss_reader_test=verified')) {
      res.writeHead(401, { 'content-type': 'text/html' })
      res.end('<form><input type="password"></form>')
      return
    }
    authenticatedFetches += 1
    res.setHeader('content-type', 'text/html')
    res.end(`<html><title>登录态正文</title><body><article><h1>登录态正文</h1><p>${'这是仅在模拟登录后可读的完整正文。'.repeat(80)}</p><p>AUTHENTICATED-ARTICLE-END</p></article></body></html>`)
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const exportFolder = path.join(root, 'exports')
  fs.mkdirSync(exportFolder)
  let app, report
  try {
    const seedPath = path.join(root, 'seed.mts')
    const databaseModule = pathToFileURL(path.join(process.cwd(), 'src/main/modules/database.ts')).href
    fs.writeFileSync(seedPath, `import { DatabaseManager } from ${JSON.stringify(databaseModule)};
const db = new DatabaseManager(true);
db.settings.setSetting('rss:auto_refresh_interval_ms', '0');
const source = db.rss.addRSSSource({name:'合成验收信源',url:${JSON.stringify(base + '/feed')},enabled:false});
for(let i=0;i<132;i++){
 const id='reader-'+i;
 db.rss.upsertRSSItems([{id,source_id:source,guid:id,title:'可读资讯 '+String(i).padStart(2,'0'),link:i===3?'https://rss-media.invalid/image.svg':${JSON.stringify(base)}+(i===2?'/video.mp4':'/article/'+i),cover_image:i===2?'https://rss-media.invalid/cover.svg':null,summary:'来源摘要 '+i,author:'合成作者',published_at:1700000000+(i<38?1000+i:i)}]);
 if(i!==1 && i!==2 && i!==3) db.rss.content.finishLoad(db.rss.content.beginLoad(id),{status:'ready',sourceUrl:${JSON.stringify(base)}+'/article/'+i,markdown:'# 已保存正文\\n\\n## 第一节\\n\\n'+('真实保存长文。'.repeat(4500))+'\\n\\n## 最后一节\\n\\nARTICLE-END-'+i+'\\n\\n重复位置 **第二部分**\\n\\n重复位置 **第二部分**\\n\\n\`\`\`ready-widget\\n<script>window.RSS_UNTRUSTED_EXECUTED=true</script>\\n\`\`\`'});
}
(db as any).db.exec("CREATE TRIGGER synthetic_save_failure BEFORE UPDATE OF read,starred ON rss_items WHEN OLD.id='reader-35' BEGIN SELECT RAISE(ABORT, '合成保存失败'); END;");
await (db as any).db.backup(${JSON.stringify(path.join(root, 'ready.db'))}); db.close();`)
    const seed = spawnSync(require('electron'), ['node_modules/tsx/dist/cli.mjs', seedPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    fs.writeFileSync(path.join(evidence, 'seed.log'), seed.stdout + seed.stderr)
    assert.equal(seed.status, 0, 'synthetic database seeding failed')
    const env = { ...process.env, READY_USER_DATA_DIR: root }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    let page
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      page = app.windows().find((entry) => entry.url().includes('/renderer/index.html'))
      if (page) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(page, 'Ready workbench did not open')
    await installMediaFixture(page)
    await page.getByTitle('rss', { exact: true }).click()
    await page.locator('.rss-news-card').first().waitFor()
    let navigation = page.getByRole('navigation', { name: 'RSS 内部导航' })
    const expanded = (await navigation.boundingBox()).width
    await page.getByRole('button', { name: '收起 RSS 导航', exact: true }).click()
    assert.ok((await navigation.boundingBox()).width < expanded)
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('可读资讯 01')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 1)
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 50)
    await page.getByRole('button', { name: '引用当前结果', exact: true }).click()
    await page.locator('.chat-reference-chip').getByRole('button', { name: 'RSS 筛选结果 RSS 筛选结果引用', exact: true }).click()
    const referencePreview = page.getByRole('dialog', { name: '附件预览', exact: true })
    await referencePreview.getByText(/引用范围共 132 条/).waitFor()
    assert.equal(await referencePreview.getByRole('button', { name: '在 Finder 中显示', exact: true }).count(), 0)
    await page.screenshot({ path: path.join(evidence, 'rss-query-reference.png') })
    await referencePreview.getByRole('button', { name: '关闭', exact: true }).click()
    // Only the native folder picker is replaced; the UI, IPC, DB and filesystem remain real.
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    await page.getByRole('button', { name: '导出当前结果（JSON）', exact: true }).click()
    await page.getByRole('button', { name: '导出当前结果（JSON）', exact: true }).waitFor()
    assert.deepEqual(fs.readdirSync(exportFolder), [])
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, exportFolder)
    await page.getByRole('button', { name: '导出当前结果（JSON）', exact: true }).click()
    await page.getByRole('button', { name: '已导出发起时的 132 条结果 · 显示文件', exact: true }).waitFor()
    const exportName = fs.readdirSync(exportFolder).find((name) => name.endsWith('.json'))
    const exported = JSON.parse(fs.readFileSync(path.join(exportFolder, exportName), 'utf8'))
    assert.equal(exported.articles.length, 132, 'export must include unloaded pages')
    assert.equal(new Set(exported.articles.map((article) => article.id)).size, 132)
    assert.equal(exported.articles.find((article) => article.id === 'reader-1').body.markdown, null, 'export does not fetch missing bodies')
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 100)
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 132)
    assert.ok(await page.locator('.rss-news-card').count() <= 80, 'the loaded dataset must not mount every card')
    assert.equal(await page.locator('.rss-news-card').evaluateAll((cards) => cards.some((card) => getComputedStyle(card).backdropFilter !== 'none' || card.querySelector('canvas'))), false)
    await page.locator('.rss-feed-list [data-liquid-scroll-root="rss-feed-list"]').evaluate((element) => element.scrollTop = 0)
    await page.screenshot({ path: path.join(evidence, 'workspace-list.png') })
    await page.getByRole('button', { name: '展开 RSS 导航', exact: true }).click()
    await page.screenshot({ path: path.join(evidence, 'workspace-expanded.png') })
    await page.getByRole('button', { name: '收起 RSS 导航', exact: true }).click()
    await revealTitle(page, '可读资讯 35')
    await page.getByText('可读资讯 35', { exact: true }).click()
    await page.getByText('ARTICLE-END-35', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor()
    assert.equal(await page.locator('.rss-article-reader iframe').count(), 0)
    assert.equal(await page.evaluate(() => window.RSS_UNTRUSTED_EXECUTED), undefined)
    const failedSave = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-35', length: 1 }))
    assert.equal(failedSave.data.article.read, false)
    await page.screenshot({ path: path.join(evidence, 'reader-light.png') })
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await revealTitle(page, '可读资讯 10')
    const beforeReturn = await page.locator('.rss-feed-list [data-liquid-scroll-root="rss-feed-list"]').evaluate((element) => element.scrollTop)
    await page.getByRole('button', { name: '可读资讯 10', exact: true }).click()
    await page.locator('.rss-article-reader').getByText('ARTICLE-END-10', { exact: true }).waitFor()
    assert.equal(await page.locator('.rss-article-reader [role=alert]').count(), 0, 'previous item failure must not contaminate this article')
    const selectedRun = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.rss-reader-body [data-ready-reading-run]')].filter((node) => node.textContent === '第二部分')
      if (nodes.length !== 2) throw new Error('Synthetic duplicate reading runs are missing')
      const node = nodes[1], range = document.createRange()
      range.setStart(node.firstChild, 1); range.setEnd(node.firstChild, 3)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return node.getAttribute('data-ready-reading-run')
    })
    await page.getByRole('button', { name: '引用所选文字', exact: true }).click()
    await page.locator('.chat-reference-chip').getByRole('button', { name: '可读资讯 10 · 选区 RSS 选区引用', exact: true }).click()
    await referencePreview.getByText(/已保存正文中的选区/).waitFor()
    assert.match(await referencePreview.innerText(), /二部/)
    assert.doesNotMatch(await referencePreview.innerText(), /真实保存长文/)
    await referencePreview.getByRole('button', { name: '在 RSS 中定位', exact: true }).click()
    await page.waitForFunction((run) => {
      const selection = window.getSelection()
      return selection?.toString() === '二部' && selection.anchorNode?.parentElement?.getAttribute('data-ready-reading-run') === run
    }, selectedRun)
    await page.screenshot({ path: path.join(evidence, 'rss-selection-reveal.png') })
    await page.getByRole('button', { name: '引用本段', exact: true }).click()
    await page.locator('.chat-reference-chip').getByRole('button', { name: '可读资讯 10 · 段落 RSS 选区引用', exact: true }).click()
    await referencePreview.getByText(/重复位置 第二部分/).waitFor()
    await referencePreview.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '引用文章', exact: true }).click()
    await page.locator('.chat-reference-chip').getByRole('button', { name: '可读资讯 10 RSS 文章引用', exact: true }).click()
    await referencePreview.getByText(/片段预览，Agent 可继续读取/).waitFor()
    assert.match(await referencePreview.innerText(), /可读资讯 10/)
    await page.screenshot({ path: path.join(evidence, 'rss-article-reference.png') })
    await referencePreview.getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('.chat-reference-chip').getByRole('button', { name: 'RSS 筛选结果 RSS 筛选结果引用', exact: true }).click()
    await referencePreview.getByText('引用的资料已变化，请返回 RSS 重新引用。', { exact: true }).waitFor()
    await referencePreview.getByRole('button', { name: '关闭', exact: true }).click()
    while (await page.locator('.chat-reference-chip button[title="移除"]').count()) await page.locator('.chat-reference-chip button[title="移除"]').first().click()
    const sourceBeforeNote = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 24000 }))
    await page.getByRole('button', { name: '保存为笔记', exact: true }).click()
    await page.locator('.document-preview-surface').waitFor()
    await page.locator('.document-preview-surface').getByRole('heading', { name: '可读资讯 10', exact: true }).waitFor()
    const noteName = fs.readdirSync(exportFolder).find((name) => name.endsWith('.md'))
    assert.ok(noteName)
    const notePath = path.join(exportFolder, noteName)
    const noteText = fs.readFileSync(notePath, 'utf8')
    assert.match(noteText, /ARTICLE-END-10/)
    assert.match(noteText, /打开原文/)
    assert.doesNotMatch(await page.locator('.document-preview-surface').innerText(), /ready-rss-source|reader-10/)
    assert.equal(await page.locator('.document-preview-surface iframe').count(), 0)
    assert.equal(await page.evaluate(() => window.RSS_UNTRUSTED_EXECUTED), undefined)
    await page.screenshot({ path: path.join(evidence, 'saved-note.png') })
    fs.appendFileSync(notePath, '\n\nThis edit belongs only to the note.\n')
    const sourceAfterNote = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 24000 }))
    assert.deepEqual(sourceAfterNote.data, sourceBeforeNote.data, 'editing a note must not rewrite the RSS article')
    await page.getByTitle('rss', { exact: true }).click()
    await page.locator('.rss-article-reader').getByText('ARTICLE-END-10', { exact: true }).waitFor()
    await page.getByTitle('收起/展开聊天面板', { exact: true }).click()
    await page.getByRole('navigation', { name: '本文目录' }).waitFor()
    await page.getByRole('navigation', { name: '本文目录' }).getByRole('button', { name: '最后一节', exact: true }).click()
    await page.waitForFunction(() => {
      const target = Array.from(document.querySelectorAll('.rss-reader-body [data-ready-heading-title]')).find((node) => node.textContent === '最后一节')
      const box = target?.getBoundingClientRect()
      return box && box.top >= 0 && box.bottom < window.innerHeight
    })
    await page.screenshot({ path: path.join(evidence, 'reader-outline.png') })
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    assert.equal(await page.locator('.rss-feed-list [data-liquid-scroll-root="rss-feed-list"]').evaluate((element) => element.scrollTop), beforeReturn)
    const saved = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }))
    assert.equal(saved.data.article.read, true)

    // Real Chromium login writes the same partition that production RSS fetch consumes.
    const unavailable = await page.evaluate(() => window.electronAPI.rss.loadArticle({ itemId: 'reader-1' }))
    assert.equal(unavailable.success, false)
    await app.evaluate(async ({ BrowserWindow }, loginUrl) => {
      const login = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:browser' } })
      try { await login.loadURL(loginUrl) } finally { login.destroy() }
    }, base + '/login')
    const available = await page.evaluate(() => window.electronAPI.rss.loadArticle({ itemId: 'reader-1', force: true }))
    assert.equal(available.success, true)
    assert.ok(authenticatedFetches > 0)
    await revealTitle(page, '可读资讯 01')
    await page.getByText('可读资讯 01', { exact: true }).click()
    await page.getByText('AUTHENTICATED-ARTICLE-END', { exact: true }).waitFor()
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.screenshot({ path: path.join(evidence, 'reader-dark.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/renderer/index.html'))?.setSize(1050, 800))
    await page.screenshot({ path: path.join(evidence, 'reader-narrow.png') })
    assert.equal(await page.locator('.rss-article-reader').evaluate((element) => element.scrollWidth > element.clientWidth), false)
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.evaluate(() => window.electronAPI.rss.toggleStarred('reader-120'))
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('可读资讯 12')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 11)
    await page.getByRole('button', { name: '清空当前筛选范围中的全部内容', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 1)
    await navigation.getByRole('button', { name: '历史底稿', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 11)
    const history = await page.evaluate(() => window.electronAPI.rss.queryItems({ scope: 'library', search: '可读资讯 12' }))
    assert.equal(history.data.total, 11)
    const archived = history.data.items.filter((item) => !item.inboxVisible)
    assert.equal(archived.length, 10)
    assert.equal(await page.locator(`[data-rss-item-id="${archived[0].id}"] button[title="移出收件箱"]`).count(), 0)
    await page.reload()
    await page.getByTitle('rss', { exact: true }).click()
    await page.getByRole('button', { name: '展开 RSS 导航', exact: true }).waitFor()
    await page.getByRole('heading', { name: '历史底稿', exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '搜索资讯', exact: true }).inputValue(), '可读资讯 12')
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 11)

    await navigation.getByRole('button', { name: '全部动态', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('可读资讯 10')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 11)
    await navigation.getByRole('button', { name: '管理栏目', exact: true }).click()
    let editor = page.getByRole('region', { name: '栏目设置', exact: true })
    await editor.getByLabel('名称', { exact: true }).fill('制作方法')
    await editor.getByLabel('描述与归类标准', { exact: true }).fill('实际制作流程、教程和可复用案例，排除单纯宣传。')
    await editor.getByLabel('图标', { exact: true }).selectOption('video')
    await editor.getByLabel('顺序', { exact: true }).fill('2')
    await editor.getByRole('button', { name: '保存栏目', exact: true }).click()
    await navigation.getByRole('button', { name: '制作方法', exact: true }).waitFor()
    const definitions = await page.evaluate(() => window.electronAPI.rss.getDefinitions())
    const topic = definitions.data.find((entry) => entry.name === '制作方法')
    assert.ok(topic && topic.ruleRevision === 1)
    await editor.getByRole('button', { name: '关闭栏目设置', exact: true }).click()
    await page.locator('.rss-category-filters').getByRole('button', { name: '制作方法', exact: true }).waitFor()
    await page.getByRole('button', { name: '可读资讯 10', exact: true }).click()
    await page.locator('.rss-article-reader').getByText('ARTICLE-END-10', { exact: true }).waitFor()
    const bodyBeforeCategory = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }))
    await page.locator('.rss-membership-editor > summary').click()
    await page.getByLabel('制作方法归属', { exact: true }).selectOption('yes')
    await waitForIPC(page, (id) => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }).then((response) => response.data.article.classifications.some((entry) => entry.definitionId === id && entry.included === true)), topic.id)
    await page.getByLabel('精选归属', { exact: true }).selectOption('yes')
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.locator('.rss-category-filters').getByRole('button', { name: '制作方法', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 1)
    await navigation.getByRole('button', { name: '制作方法', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 1)
    await page.screenshot({ path: path.join(evidence, 'custom-topic.png') })
    await navigation.getByRole('button', { name: '精选', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 1)
    const curatedItem = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }))
    assert.equal(curatedItem.data.article.starred, false, 'curation is independent of bookmarks')
    assert.equal(curatedItem.data.article.revision, bodyBeforeCategory.data.article.revision)
    await navigation.getByRole('button', { name: '管理栏目', exact: true }).click()
    await editor.getByLabel('选择编辑栏目', { exact: true }).selectOption(topic.id)
    await editor.getByLabel('名称', { exact: true }).fill('制作流程')
    await editor.getByRole('button', { name: '保存栏目', exact: true }).click()
    await navigation.getByRole('button', { name: '制作流程', exact: true }).waitFor()
    const renamed = await page.evaluate((id) => window.electronAPI.rss.getDefinitions().then((response) => response.data.find((entry) => entry.id === id)), topic.id)
    assert.equal(renamed.ruleRevision, topic.ruleRevision)
    await editor.getByLabel('描述与归类标准', { exact: true }).fill('可复用的镜头制作与工作流程。')
    await editor.getByRole('button', { name: '保存栏目', exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.getDefinitions().then((response) => response.data.find((entry) => entry.id === id).ruleRevision === 2), topic.id)
    await page.screenshot({ path: path.join(evidence, 'topic-settings.png') })
    await editor.getByRole('button', { name: '关闭栏目设置', exact: true }).click()
    await app.close()
    app = null
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    const reopenDeadline = Date.now() + 45000
    page = null
    while (Date.now() < reopenDeadline) {
      page = app.windows().find((entry) => entry.url().includes('/renderer/index.html'))
      if (page) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(page, 'Ready did not reopen after classification was saved')
    await installMediaFixture(page)
    await page.getByTitle('rss', { exact: true }).click()
    navigation = page.getByRole('navigation', { name: 'RSS 内部导航' })
    editor = page.getByRole('region', { name: '栏目设置', exact: true })
    await navigation.getByRole('button', { name: '制作流程', exact: true }).waitFor()
    const persisted = await page.evaluate((id) => window.electronAPI.rss.getDefinitions().then((response) => response.data.find((entry) => entry.id === id)), topic.id)
    assert.equal(persisted.description, '可复用的镜头制作与工作流程。')
    assert.equal(persisted.position, 2)
    assert.equal(persisted.icon, 'video')
    await navigation.getByRole('button', { name: '制作流程', exact: true }).click()
    await navigation.getByRole('button', { name: '管理栏目', exact: true }).click()
    await editor.getByLabel('选择编辑栏目', { exact: true }).selectOption(topic.id)
    await editor.getByLabel('在左侧显示', { exact: true }).uncheck()
    await editor.getByRole('button', { name: '保存栏目', exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.getDefinitions().then((response) => response.data.find((entry) => entry.id === id).visible === false), topic.id)
    await navigation.getByRole('button', { name: '制作流程', exact: true }).waitFor({ state: 'hidden' })
    await editor.getByRole('button', { name: '删除分类', exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.getDefinitions().then((response) => !response.data.some((entry) => entry.id === id)), topic.id)
    await page.getByRole('heading', { name: '全部动态', exact: true }).waitFor()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 11)
    const afterDelete = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }))
    assert.equal(afterDelete.data.article.revision, bodyBeforeCategory.data.article.revision)
    assert.equal(afterDelete.data.article.classifications.some((entry) => entry.definitionId === topic.id), false)
    assert.equal(afterDelete.data.article.classifications.some((entry) => entry.definitionId === 'curated' && entry.included), true)

    const initialProcessing = await page.evaluate(() => window.electronAPI.rss.processingJobs())
    assert.equal(initialProcessing.data.total, 0, 'historical fixture import must not auto-process')
    const globalProcessing = page.locator('.rss-processing-panel').first()
    await globalProcessing.locator(':scope > summary').click()
    await globalProcessing.getByLabel('每日整理调用上限', { exact: true }).fill('2')
    await page.evaluate(() => window.electronAPI.rss.configureProcessing({ enabled: true, dailyLimit: 88 }))
    await globalProcessing.locator(':scope > summary').filter({ hasText: '0/88' }).waitFor()
    assert.equal(await globalProcessing.getByLabel('每日整理调用上限', { exact: true }).inputValue(), '2', 'background status must not replace an unsaved limit')
    await globalProcessing.getByRole('button', { name: '保存限额', exact: true }).click()
    await waitForIPC(page, () => window.electronAPI.rss.processingStatus().then((result) => result.data.settings.dailyLimit === 2))
    await globalProcessing.locator(':scope > summary').click()
    const modelSetup = await page.evaluate((baseUrl) => window.electronAPI.settings.setAIConfig({ provider: 'openai-compatible', apiKey: 'synthetic-only', model: 'local-rss-test', baseUrl }), base + '/v1')
    assert.equal(modelSetup.success, true)
    await page.locator('.rss-news-card').first().click()
    const membershipPanel = page.locator('.rss-membership-editor')
    await membershipPanel.locator(':scope > summary').click()
    const processingPanel = membershipPanel.locator('.rss-processing-panel')
    await processingPanel.locator(':scope > summary').click()
    const reprocess = processingPanel.getByRole('button', { name: '按当前标准整理本篇（使用模型）', exact: true })
    await reprocess.click()
    await processingPanel.locator('li').filter({ hasText: '整理完成' }).waitFor()
    assert.equal(modelRequests, 1)
    await page.screenshot({ path: path.join(evidence, 'processing-complete.png') })
    holdModelResponse = true
    await reprocess.click()
    const runningRow = processingPanel.locator('li').filter({ hasText: '正在整理' })
    await runningRow.waitFor()
    const requestDeadline = Date.now() + 5000
    while (modelRequests < 2 && Date.now() < requestDeadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(modelRequests, 2)
    await runningRow.getByRole('button', { name: '取消', exact: true }).click()
    await processingPanel.getByText('已取消；已发出的调用仍计入限额。', { exact: true }).waitFor()
    const afterCancel = await page.evaluate(() => window.electronAPI.rss.processingStatus())
    assert.equal(afterCancel.data.callsToday, 2)
    assert.equal(afterCancel.data.blocked, 'limit')
    await page.screenshot({ path: path.join(evidence, 'processing-canceled.png') })
    holdModelResponse = false
    await page.evaluate(() => window.electronAPI.rss.configureProcessing({ enabled: true, dailyLimit: 10 }))
    const automaticSource = await page.evaluate((url) => window.electronAPI.rss.addSource({ name: '自动整理验收', url }), base + '/processing-feed')
    assert.equal(automaticSource.success, true, automaticSource.error)
    assert.equal(modelRequests, 2, 'adding a feed must not process its historical import')
    updatedProcessingFeed = true
    const refreshedSource = await page.evaluate((id) => window.electronAPI.rss.refreshSource(id), automaticSource.data.id)
    assert.equal(refreshedSource.success, true, refreshedSource.error)
    await waitForIPC(page, () => window.electronAPI.rss.queryItems({ scope: 'library', search: '自动整理新增资讯' }).then((result) => result.data?.items[0]?.classifications.some((entry) => entry.origin === 'model' && entry.included)), undefined, { timeout: 15000 })
    const historyClassification = await page.evaluate(() => window.electronAPI.rss.queryItems({ scope: 'library', search: '自动整理历史资讯' }))
    assert.deepEqual(historyClassification.data.items[0].classifications, [])
    assert.equal(modelRequests, 3)

    const eventPanel = () => page.locator('.rss-event-panel')
    await eventPanel().locator(':scope > button').click()
    await eventPanel().getByRole('button', { name: '拆为独立事件', exact: true }).click()
    await waitForIPC(page, () => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }).then((response) => response.data?.article.event?.manual))
    const firstEvent = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }).then((response) => response.data.article.event))
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('可读资讯 11')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    await page.locator('[data-rss-item-id="reader-11"]').click()
    await eventPanel().locator(':scope > button').click()
    await eventPanel().getByLabel('搜索目标事件', { exact: true }).fill('可读资讯 10')
    await eventPanel().getByRole('button', { name: '搜索事件', exact: true }).click()
    await eventPanel().getByLabel('目标事件', { exact: true }).selectOption(firstEvent.eventId)
    await eventPanel().getByLabel('并入事实方式', { exact: true }).selectOption(firstEvent.factId)
    await eventPanel().getByRole('button', { name: '并入所选事件', exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.readEvents({ view: 'members', eventId: id }).then((response) => response.data?.total === 2), firstEvent.eventId)
    await page.screenshot({ path: path.join(evidence, 'event-duplicate.png') })
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('可读资讯 10')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    const grouped = page.locator('[data-rss-item-id="reader-10"] .rss-grouped-reports')
    await grouped.getByRole('button', { name: /同一事件/ }).click()
    await grouped.getByRole('button', { name: '可读资讯 10', exact: true }).waitFor()
    assert.equal(await grouped.locator('li').count(), 1, 'expansion must retain the search filter')
    await page.screenshot({ path: path.join(evidence, 'event-filtered-group.png') })
    await grouped.getByRole('button', { name: '可读资讯 10', exact: true }).click()
    if (await eventPanel().locator(':scope > button').getAttribute('aria-expanded') !== 'true') await eventPanel().locator(':scope > button').click()
    await eventPanel().getByRole('button', { name: '拆为独立事件', exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.readArticle({ itemId: 'reader-10', length: 1 }).then((response) => !!response.data?.article.event?.eventId && response.data.article.event.eventId !== id), firstEvent.eventId)
    const splitEvents = await page.evaluate(async () => Promise.all(['reader-10', 'reader-11'].map(async (itemId) => ({ itemId, result: await window.electronAPI.rss.readArticle({ itemId, length: 1 }) }))))
    fs.writeFileSync(path.join(evidence, 'event-split-readback.json'), JSON.stringify({ firstEvent, readerTitles: await page.locator('.rss-article-reader h1').allTextContents(), splitEvents }, null, 2))
    await eventPanel().getByLabel('搜索目标事件', { exact: true }).fill('可读资讯 11')
    await eventPanel().getByRole('button', { name: '搜索事件', exact: true }).click()
    await eventPanel().getByLabel('目标事件', { exact: true }).selectOption(firstEvent.eventId)
    await eventPanel().getByRole('button', { name: '合并当前整个事件', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.readEvents({ view: 'members', eventId: id }).then((response) => response.data?.total === 2 && response.data?.members.every((member) => member.manual)), firstEvent.eventId)
    const mergedFacts = await page.evaluate((id) => window.electronAPI.rss.readEvents({ view: 'facts', eventId: id }), firstEvent.eventId)
    fs.writeFileSync(path.join(evidence, 'event-merge-readback.json'), JSON.stringify(mergedFacts, null, 2))
    assert.equal(mergedFacts.data.total, 2, 'merging events must not silently merge distinct fact identities')
    assert.equal(modelRequests, 3, 'manual grouping must not invoke the model')
    const automaticEvents = await page.evaluate((url) => window.electronAPI.rss.addSource({ name: '事件验收', url }), base + '/event-feed')
    assert.equal(automaticEvents.success, true, automaticEvents.error)
    eventFeedVersion = 1
    await page.evaluate((id) => window.electronAPI.rss.refreshSource(id), automaticEvents.data.id)
    await waitForIPC(page, () => window.electronAPI.rss.queryItems({ scope: 'library', search: 'Project Delta 报道 1' }).then((response) => !!response.data?.items[0]?.event?.eventId))
    eventFeedVersion = 2
    await page.evaluate((id) => window.electronAPI.rss.refreshSource(id), automaticEvents.data.id)
    await waitForIPC(page, () => window.electronAPI.rss.queryCards({ scope: 'library', search: 'Project Delta' }).then((response) => response.data?.total === 2 && response.data.cardTotal === 1))
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('Project Delta')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('[data-rss-loaded-count]')?.dataset.rssLoadedCount) === 1)
    await page.locator('.rss-grouped-reports').getByRole('button', { name: /同一事件/ }).click()
    await page.locator('.rss-grouped-reports').getByRole('button', { name: 'Project Delta 报道 1', exact: true }).waitFor()
    const beforeEventRead = await page.evaluate(() => window.electronAPI.rss.queryItems({ search: 'Project Delta' }))
    assert.equal(beforeEventRead.data.items.filter((item) => item.read).length, 0, 'expanding a group is not reading every article')
    const deltaEventId = beforeEventRead.data.items[0].event.eventId
    await page.screenshot({ path: path.join(evidence, 'event-automatic-group.png') })
    await page.locator('.rss-grouped-reports').getByRole('button', { name: 'Project Delta 报道 1', exact: true }).click()
    await page.locator('.rss-article-reader').getByText('已保存正文', { exact: true }).waitFor()
    await waitForIPC(page, (id) => window.electronAPI.rss.readEvents({ view: 'members', eventId: id }).then((response) => response.data?.summary.unreadCount === 1 && response.data.summary.unseenFactCount === 0), deltaEventId)
    await waitForIPC(page, () => window.electronAPI.rss.processingStatus().then((response) => response.data?.pending === 0 && response.data.running === 0))
    eventFeedVersion = 3
    await page.evaluate((id) => window.electronAPI.rss.refreshSource(id), automaticEvents.data.id)
    await waitForIPC(page, (id) => window.electronAPI.rss.readEvents({ view: 'facts', eventId: id }).then((response) => response.data?.total === 2 && response.data.summary.unseenFactCount === 1), deltaEventId)
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.locator('.rss-grouped-reports').getByText('有 1 个新整理的事实或进展待查看', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(evidence, 'event-new-progress.png') })

    const deltaItemId = beforeEventRead.data.items.find((item) => item.title === 'Project Delta 报道 1').id
    const readDelta = () => page.evaluate((itemId) => window.electronAPI.rss.readArticle({ itemId, length: 12000 }), deltaItemId)
    const savedA = await readDelta(), callsBeforeRevision = modelRequests
    eventArticleChanged = true
    assert.equal((await page.evaluate((itemId) => window.electronAPI.rss.loadArticle({ itemId, force: true }), deltaItemId)).success, true)
    await waitForIPC(page, (itemId) => window.electronAPI.rss.readArticle({ itemId, length: 1 }).then((response) => response.data?.article.classifications.every((c) => !c.stale) && response.data.article.event?.factId === null), deltaItemId)
    assert.equal(modelRequests, callsBeforeRevision + 1)
    eventArticleChanged = false
    assert.equal((await page.evaluate((itemId) => window.electronAPI.rss.loadArticle({ itemId, force: true }), deltaItemId)).success, true)
    const restoredA = await readDelta()
    assert.equal(restoredA.data.article.revision, savedA.data.article.revision)
    assert.deepEqual(restoredA.data.article.classifications, savedA.data.article.classifications)
    assert.equal(restoredA.data.article.event.factId, savedA.data.article.event.factId)
    assert.equal(restoredA.data.article.event.stale, false)
    assert.equal(modelRequests, callsBeforeRevision + 1, 'returning to a saved version must not invoke the model')
    await page.locator('.rss-grouped-reports').getByRole('button', { name: 'Project Delta 报道 1', exact: true }).click()
    await page.locator('.rss-reader-body').getByText('Project Delta released Version 2.', { exact: true }).waitFor()
    eventArticleFailure = true
    await page.getByRole('button', { name: '重新获取正文', exact: true }).click()
    await page.getByText(/已保留上次保存的正文/).waitFor()
    const preserved = await readDelta()
    assert.equal(preserved.data.text, savedA.data.text)
    assert.equal(preserved.data.article.revision, savedA.data.article.revision)
    assert.equal(preserved.data.body.fetching, false)
    assert.ok(preserved.data.body.error)
    await page.screenshot({ path: path.join(evidence, 'body-refresh-failure-preserved.png') })

    const callsBeforeDigest = modelRequests
    await page.getByRole('button', { name: '日报与简报', exact: true }).click()
    const digestPanel = page.getByRole('region', { name: '日报与简报', exact: true })
    await digestPanel.getByRole('button', { name: '生成当前筛选范围简报', exact: true }).click()
    await digestPanel.getByRole('heading', { name: '当前范围简报 · 第 1 版', exact: true }).waitFor()
    const briefList = await page.evaluate(() => window.electronAPI.rss.readDigests())
    const brief = briefList.data.editions.find((edition) => edition.kind === 'range')
    assert.ok(brief); assert.equal(brief.referenceCount, 3)
    await digestPanel.getByRole('button', { name: '查看本刊采用的标准版本', exact: true }).click()
    await digestPanel.getByText(/标准第 1 版/).first().waitFor()
    await digestPanel.getByRole('button', { name: '引用本刊', exact: true }).click()
    await page.locator('.chat-reference-chip').getByRole('button', { name: '范围简报 第 1 版 RSS 刊物引用', exact: true }).click()
    const digestReferencePreview = page.getByRole('dialog', { name: '附件预览', exact: true })
    await digestReferencePreview.getByText(/当前范围简报 · 第 1 版/).waitFor()
    assert.match(await digestReferencePreview.innerText(), /Project Delta/)
    await digestReferencePreview.getByRole('button', { name: '关闭', exact: true }).click()
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, exportFolder)
    await digestPanel.getByRole('button', { name: '导出本刊', exact: true }).click()
    await digestPanel.getByText(/已导出：/).waitFor()
    const digestExport = fs.readdirSync(exportFolder).find((name) => name.startsWith('RSS-范围简报-') && name.endsWith('.md'))
    assert.ok(digestExport)
    const digestMarkdown = fs.readFileSync(path.join(exportFolder, digestExport), 'utf8')
    assert.match(digestMarkdown, /Project Delta released Version 2/)
    assert.match(digestMarkdown, /本刊采用的标准与订阅覆盖/)
    await digestPanel.getByRole('button', { name: '重新生成新版本', exact: true }).click()
    await digestPanel.getByRole('heading', { name: '当前范围简报 · 第 2 版', exact: true }).waitFor()
    assert.equal((await page.evaluate((reportId) => window.electronAPI.rss.readDigests({ view: 'entries', reportId }), brief.id)).data.report.version, 1)
    const nextLocalMinute = await page.evaluate(() => { const now = new Date(Date.now() + 60000); return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` })
    await page.evaluate((localTime) => window.electronAPI.rss.configureDigests({ enabled: true, localTime }), nextLocalMinute)
    await waitForIPC(page, () => window.electronAPI.rss.readDigests().then((result) => result.data?.editions.some((edition) => edition.kind === 'daily' && edition.total > 0)), undefined, { timeout: 75000 })
    assert.equal(modelRequests, callsBeforeDigest, 'daily publication and briefs do not start another model judgment')
    await page.screenshot({ path: path.join(evidence, 'daily-and-range-digests.png') })
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.screenshot({ path: path.join(evidence, 'digest-dark.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/renderer/index.html'))?.setSize(1050, 800))
    assert.equal(await digestPanel.evaluate((element) => element.scrollWidth > element.clientWidth), false)
    await page.screenshot({ path: path.join(evidence, 'digest-narrow.png') })

    const analysisReports = []
    await page.getByRole('navigation', { name: 'RSS 内部导航' }).getByRole('button', { name: '全部动态', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('可读资讯 01')
    await page.getByRole('button', { name: '执行搜索', exact: true }).click()
    await page.locator('[data-rss-item-id="reader-1"]').waitFor()
    const startAnalysis = () => page.evaluate((targetDir) => window.electronAPI.rss.startItemAnalysis({ itemId: 'reader-1', action: 'copy', title: 'ignored', link: 'ignored', targetDir, force: true }), path.join(root, 'analysis'))
    holdAnalysisResponse = true
    const firstAnalysis = await startAnalysis()
    assert.equal(firstAnalysis.success, true, firstAnalysis.error)
    for (let attempt = 0; !releaseAnalysisResponse && attempt < 300; attempt++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(typeof releaseAnalysisResponse, 'function', 'the first analysis must remain in flight while testing the queued task')
    const secondAnalysis = await startAnalysis()
    assert.equal(secondAnalysis.success, true, secondAnalysis.error)
    await page.evaluate(() => {
      const NativeObserver = window.MutationObserver
      window.__rssProjectionObservers = new Set()
      window.MutationObserver = class extends NativeObserver {
        observe(target, options) { if (target instanceof Element && target.matches('[data-liquid-scroll-root="rss-feed-list"]')) window.__rssProjectionObservers.add(this); return super.observe(target, options) }
        disconnect() { window.__rssProjectionObservers.delete(this); return super.disconnect() }
      }
    })
    await page.getByRole('button', { name: /查看分析任务/ }).click()
    const tasks = page.locator('.rss-task-menu-panel')
    await tasks.locator('.ready-liquid-popover__projection-clone .rss-item-row').first().waitFor({ state: 'attached' })
    await tasks.getByTitle('暂停任务', { exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.listItemAnalysisJobs({ itemId: 'reader-1' }).then((result) => result.data?.some((job) => job.id === id && job.status === 'paused')), secondAnalysis.data.id)
    await page.screenshot({ path: path.join(evidence, 'analysis-paused.png') })
    await tasks.getByTitle('继续任务', { exact: true }).click()
    await waitForIPC(page, (id) => window.electronAPI.rss.listItemAnalysisJobs({ itemId: 'reader-1' }).then((result) => result.data?.some((job) => job.id === id && job.status === 'queued')), secondAnalysis.data.id)
    holdAnalysisResponse = false
    releaseAnalysisResponse()
    for (const started of [firstAnalysis, secondAnalysis]) {
      assert.equal(started.success, true, started.error)
      await waitForIPC(page, (id) => window.electronAPI.rss.listItemAnalysisJobs({ itemId: 'reader-1' }).then((result) => result.data?.some((job) => job.id === id && ['success', 'failed'].includes(job.status))), started.data.id)
      const jobs = await page.evaluate(() => window.electronAPI.rss.listItemAnalysisJobs({ itemId: 'reader-1' }))
      const job = jobs.data.find((entry) => entry.id === started.data.id)
      assert.equal(job.status, 'success', job.error)
      assert.equal(job.meta.reportArtifact.jobId, job.id)
      assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(job.reportPath)).digest('hex'), job.meta.reportArtifact.sha256)
      analysisReports.push({ job, text: fs.readFileSync(job.reportPath, 'utf8') })
    }
    assert.notEqual(analysisReports[0].job.reportPath, analysisReports[1].job.reportPath)
    assert.equal(fs.readFileSync(analysisReports[0].job.reportPath, 'utf8'), analysisReports[0].text)
    fs.writeFileSync(path.join(evidence, 'analysis-report-publications.json'), JSON.stringify(analysisReports, null, 2))
    await tasks.getByTitle('关闭', { exact: true }).click()
    await app.evaluate(({ shell }) => { globalThis.__rssReportReveals = []; shell.showItemInFolder = (target) => { globalThis.__rssReportReveals.push(target) } })
    const completedOutput = page.locator(`[data-rss-item-id="reader-1"] [data-rss-analysis-job-id="${secondAnalysis.data.id}"]`).and(page.getByTitle(/^已完成/))
    await completedOutput.waitFor()
    await completedOutput.click()
    const revealed = await app.evaluate(async () => {
      for (let attempt = 0; !globalThis.__rssReportReveals.length && attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 20))
      return globalThis.__rssReportReveals.at(-1)
    })
    assert.equal(revealed, analysisReports[1].job.reportPath, 'the real RSS button must reveal the latest saved report through the document handler')
    await page.getByTitle('全部源', { exact: true }).click()
    const sourcePopup = page.locator('.rss-source-menu-panel')
    await sourcePopup.locator('.ready-liquid-popover__projection-clone .rss-item-row').first().waitFor({ state: 'attached' })
    assert.equal(await sourcePopup.locator('[data-liquid-scroll-root="chat-messages"]').count(), 0)
    assert.ok(await page.evaluate(() => window.__rssProjectionObservers.size > 0))
    await page.screenshot({ path: path.join(evidence, 'rss-source-projection.png') })
    await page.getByTitle('document', { exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.rss-source-menu-panel') && window.__rssProjectionObservers.size === 0)
    await page.getByTitle('rss', { exact: true }).click()
    await page.locator('[data-rss-item-id="reader-1"]').waitFor()
    for (const [id, title, notice] of [['reader-2', '可读资讯 02', '视频资讯：'], ['reader-3', '可读资讯 03', '图片资讯：']]) {
      await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill(title)
      await page.getByRole('button', { name: '执行搜索', exact: true }).click()
      await page.waitForFunction((itemId) => document.querySelector(`[data-rss-item-id="${itemId}"] .rss-cover-image img`)?.naturalWidth > 0, id)
      await page.locator(`[data-rss-item-id="${id}"]`).click()
      await page.getByText(notice, { exact: false }).waitFor()
      await page.waitForFunction(() => document.querySelector('.rss-article-reader .rss-cover-image img')?.naturalWidth > 0)
      await page.screenshot({ path: path.join(evidence, `${id}-media.png`) })
      await page.getByRole('button', { name: '返回列表', exact: true }).click()
    }
    assert.equal(videoFetches, 0, 'reading a saved video reference must not silently download it')

    report = { ok: true, exactSelectionReferenceAndReveal: true, paragraphReference: true, scheduledDailyEdition: true, digestDarkAndNarrow: true, rangeBriefExportAndRegeneration: true, digestReferences: true, savedVersionRestorationWithoutModel: true, failedRefreshPreservesBody: true, automaticEventGroupingAndProgress: true, factSeenDoesNotReadAllArticles: true, manualEventSplitMoveMerge: true, groupExpansionKeepsFilter: true, automaticRefreshProcessesOnlyNewItems: true, semanticProcessingThroughLocalProvider: true, cancelProcessingKeepsCallCount: true, historicalImportNotProcessed: true, customDefinitions: true, applicationRestartPreservesDefinitions: true, manualMemberships: true, curationSeparateFromBookmarks: true, typedRSSReferences: true, staleReferenceVisible: true, saveNoteReadback: true, noteEditIndependent: true, exportAllPages: true, cancelExport: true, navigationCollapse: true, searchAndPagination: true, historyAndFavoritesPreserved: true, preferencesSurviveReload: true, longArticle: true, sourceCodeInert: true, failedSaveVisible: true, readPersisted: true, returnPreservesScroll: true, outlineNavigation: true, browserLoginReused: true, narrowNoOverflow: true }
    report.independentAnalysisReports = true
    report.analysisPauseResumeAndReveal = true
    report.rssFloatingSourceAndCleanup = true
    report.mediaCoversAndPassiveReferences = true
  } catch (error) {
    const failedPage = app?.windows().find((entry) => entry.url().includes('/renderer/index.html'))
    if (failedPage) await failedPage.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    holdAnalysisResponse = false
    releaseAnalysisResponse?.()
    if (app) await app.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence }))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
