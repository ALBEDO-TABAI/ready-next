#!/usr/bin/env node
'use strict'
// Runs only synthetic local content and an isolated Ready profile. No model calls.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { spawnSync } = require('node:child_process')
const { _electron } = require('playwright')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-rss-reader-'))
  const evidence = process.argv[2] || path.join(os.tmpdir(), `ready-rss-reader-evidence-${Date.now()}`)
  fs.mkdirSync(evidence, { recursive: true })
  fs.rmSync(path.join(evidence, 'result.json'), { force: true })
  let authenticatedFetches = 0
  const server = createServer((req, res) => {
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
  let app, report
  try {
    const seedPath = path.join(root, 'seed.mts')
    const databaseModule = pathToFileURL(path.join(process.cwd(), 'src/main/modules/database.ts')).href
    fs.writeFileSync(seedPath, `import { DatabaseManager } from ${JSON.stringify(databaseModule)};
const db = new DatabaseManager(true);
db.settings.setSetting('rss:auto_refresh_interval_ms', '0');
const source = db.rss.addRSSSource({name:'合成验收信源',url:${JSON.stringify(base + '/feed')},enabled:false});
for(let i=0;i<38;i++){
 const id='reader-'+i;
 db.rss.upsertRSSItems([{id,source_id:source,guid:id,title:'可读资讯 '+String(i).padStart(2,'0'),link:${JSON.stringify(base)}+'/article/'+i,summary:'来源摘要 '+i,author:'合成作者',published_at:1700000000+i}]);
 if(i!==1) db.rss.content.finishLoad(db.rss.content.beginLoad(id),{status:'ready',sourceUrl:${JSON.stringify(base)}+'/article/'+i,markdown:'# 已保存正文\\n\\n## 第一节\\n\\n'+('真实保存长文。'.repeat(4500))+'\\n\\n## 最后一节\\n\\nARTICLE-END-'+i+'\\n\\n\`\`\`ready-widget\\n<script>window.RSS_UNTRUSTED_EXECUTED=true</script>\\n\`\`\`'});
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
    await page.getByTitle('rss', { exact: true }).click()
    await page.getByText('可读资讯 35', { exact: true }).click()
    await page.getByText('ARTICLE-END-35', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor()
    assert.equal(await page.locator('.rss-article-reader iframe').count(), 0)
    assert.equal(await page.evaluate(() => window.RSS_UNTRUSTED_EXECUTED), undefined)
    const failedSave = await page.evaluate(() => window.electronAPI.rss.readArticle({ itemId: 'reader-35', length: 1 }))
    assert.equal(failedSave.data.article.read, false)
    await page.screenshot({ path: path.join(evidence, 'reader-light.png') })
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByText('可读资讯 10', { exact: true }).scrollIntoViewIfNeeded()
    const beforeReturn = await page.locator('.rss-feed-list').evaluate((element) => element.scrollTop)
    await page.getByText('可读资讯 10', { exact: true }).click()
    await page.getByText('ARTICLE-END-10', { exact: true }).waitFor()
    assert.equal(await page.locator('.rss-article-reader [role=alert]').count(), 0, 'previous item failure must not contaminate this article')
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
    assert.equal(await page.locator('.rss-feed-list').evaluate((element) => element.scrollTop), beforeReturn)
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
    await page.getByText('可读资讯 01', { exact: true }).click()
    await page.getByText('AUTHENTICATED-ARTICLE-END', { exact: true }).waitFor()
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.screenshot({ path: path.join(evidence, 'reader-dark.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/renderer/index.html'))?.setSize(1050, 800))
    await page.screenshot({ path: path.join(evidence, 'reader-narrow.png') })
    assert.equal(await page.locator('.rss-article-reader').evaluate((element) => element.scrollWidth > element.clientWidth), false)
    report = { ok: true, longArticle: true, sourceCodeInert: true, failedSaveVisible: true, readPersisted: true, returnPreservesScroll: true, outlineNavigation: true, browserLoginReused: true, narrowNoOverflow: true }
  } finally {
    if (app) await app.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence }))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
