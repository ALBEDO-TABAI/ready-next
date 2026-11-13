#!/usr/bin/env node
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { _electron } = require('playwright')

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let previous = '', stable = 0, frames = 0
    const tick = () => {
      const rect = document.querySelector('.rss-mode-shell .workbench-canvas-shell').getBoundingClientRect()
      const current = [rect.x, rect.width].map((v) => Math.round(v * 10)).join(':')
      stable = current === previous ? stable + 1 : 0; previous = current
      if (stable >= 8 || ++frames > 180) return resolve()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-rss-layout-'))
  const evidence = process.argv[2] || '/tmp/ready-rss-layout-evidence'
  fs.mkdirSync(evidence, { recursive: true })
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body style="margin:0;background:#cf651f;color:white;font:24px sans-serif"><h1>Native browser boundary</h1><p>Isolated layout fixture</p></body></html>') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/layout-page`
  let app, page
  const results = [], errors = []
  try {
    const seed = path.join(root, 'seed.mts')
    fs.writeFileSync(seed, `import { DatabaseManager } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src/main/modules/database.ts')).href)};
const db=new DatabaseManager(true);db.settings.setSetting('rss:auto_refresh_interval_ms','0');
for(let n=0;n<12;n++) {const s=db.rss.addRSSSource({name:'合成来源 '+n+' 长名称与窄窗口检查',url:'https://layout.invalid/'+n});
db.rss.upsertRSSItems([{id:'layout-'+n,source_id:s,guid:'layout-'+n,title:'分栏检查 '+n+'：'+('较长的资讯标题与摘要，不应超出工作面。'.repeat(4)),link:'https://layout.invalid/item/'+n,summary:'合成摘要。'.repeat(20)}]);
db.rss.createRSSAnalysisJob({id:'job-'+n,itemId:'layout-'+n,action:'copy',sourceUrl:'https://layout.invalid/item/'+n,title:'较长的分析任务标题 '.repeat(8),targetDir:${JSON.stringify(root)},outputDir:${JSON.stringify(root)},status:'success',progress:100});}
await db.getRawDb().backup(${JSON.stringify(path.join(root, 'ready.db'))});db.close();`)
    const seeded = spawnSync(require('electron'), ['node_modules/tsx/dist/cli.mjs', seed], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    fs.writeFileSync(path.join(evidence, 'seed.log'), seeded.stdout + seeded.stderr)
    assert.equal(seeded.status, 0)
    const env = { ...process.env, READY_USER_DATA_DIR: root }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) { page = app.windows().find((entry) => entry.url().includes('/renderer/index.html')); if (page) break; await new Promise((resolve) => setTimeout(resolve, 100)) }
    assert.ok(page)
    await page.getByTitle('rss', { exact: true }).click()
    await page.locator('.rss-news-card').first().waitFor()
    await settle(page)
    await page.getByRole('toolbar', { name: '工具栏' }).getByRole('button', { name: '文件', exact: true }).click()
    await page.waitForFunction(() => { const panel = document.querySelector('[data-liquid-shell="side-panel"]'); return panel.dataset.sidePanelVariant === 'hidden' && panel.getBoundingClientRect().width <= 2.5 })
    const canvas = page.locator('.rss-mode-shell .workbench-canvas-shell')
    const checkMenu = async (kind, context) => {
      const isSource = kind === 'source'
      await (isSource ? page.getByTitle('全部源', { exact: true }) : page.getByRole('button', { name: /查看分析任务/ })).click()
      const panel = page.locator(isSource ? '.rss-source-menu-panel' : '.rss-task-menu-panel')
      await panel.waitFor(); await settle(page)
      const bounds = await canvas.boundingBox(), menu = await panel.boundingBox()
      const outside = menu.x < bounds.x - 1 || menu.y < bounds.y - 1 || menu.x + menu.width > bounds.x + bounds.width + 1 || menu.y + menu.height > bounds.y + bounds.height + 1
      const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((window) => window.contentView.children.map((view) => ({ url: view.webContents?.getURL(), visible: view.getVisible(), ...view.getBounds() }))).filter((entry) => entry.url?.includes('/layout-page')))
      const overlapped = native.some((view) => view.visible && view.width > 0 && view.height > 0 && menu.x < view.x + view.width && menu.x + menu.width > view.x && menu.y < view.y + view.height && menu.y + menu.height > view.y)
      const record = { context, kind, bounds, menu, outside, native, overlapped }
      results.push(record)
      if (outside || overlapped) errors.push(record)
      await page.screenshot({ path: path.join(evidence, `${context}-${kind}.png`) })
      if (isSource) await page.getByTitle('全部源', { exact: true }).click()
      else await panel.getByTitle('关闭', { exact: true }).click()
    }
    for (const target of [480, 768, 1200]) {
      if (target === 1200) await page.locator('[data-shell-assistant-tools] [data-assistant-toggle]').click()
      await settle(page)
      for (let attempt = 0; attempt < 4; attempt++) {
        const width = (await canvas.boundingBox()).width
        if (Math.abs(width - target) < 2) break
        await app.evaluate(({ BrowserWindow }, delta) => { const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().includes('/renderer/index.html')); const [width] = window.getSize(); window.setSize(Math.round(width + delta), 900) }, target - width)
        await settle(page)
      }
      assert.ok(Math.abs((await canvas.boundingBox()).width - target) < 2, 'actual RSS canvas width must match the requested case')
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => document.documentElement.dataset.theme = value, theme)
        for (const collapsed of [true, false]) {
          const toggle = page.getByRole('button', { name: collapsed ? '收起 RSS 导航' : '展开 RSS 导航', exact: true })
          if (await toggle.count()) await toggle.click()
          await settle(page)
          const overflow = await canvas.evaluate((element) => element.scrollWidth > element.clientWidth)
          if (overflow) errors.push({ target, theme, collapsed, overflow })
          await checkMenu('source', `${target}-${theme}-${collapsed ? 'collapsed' : 'expanded'}`)
          await checkMenu('tasks', `${target}-${theme}-${collapsed ? 'collapsed' : 'expanded'}`)
        }
      }
    }
    await page.getByTitle('展开聊天面板', { exact: true }).click(); await settle(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().includes('/renderer/index.html')).setSize(1600, 1000))
    await page.evaluate((value) => window.electronAPI.browser.createTab(value), url)
    await page.getByTitle('browser', { exact: true }).click({ modifiers: ['Shift'] })
    await page.locator('[data-workbench-split-layout="true"]').waitFor(); await settle(page)
    const visibleBrowser = await app.evaluate(async ({ BrowserWindow }) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const view = BrowserWindow.getAllWindows().flatMap((window) => window.contentView.children).find((entry) => entry.webContents?.getURL().includes('/layout-page') && entry.getVisible() && entry.getBounds().width > 0)
        if (view && await view.webContents.executeJavaScript("document.readyState==='complete' && document.body.innerText.includes('Native browser boundary')")) return true
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      return false
    })
    assert.equal(visibleBrowser, true, 'the split must contain a genuinely visible native browser')
    await checkMenu('source', 'native-split'); await checkMenu('tasks', 'native-split')
    await page.locator('[data-shell-assistant-tools] [data-assistant-toggle]').click(); await settle(page)
    await checkMenu('source', 'native-split-chat-collapsed'); await checkMenu('tasks', 'native-split-chat-collapsed')
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: errors.length === 0, results, errors }, null, 2))
    console.log(JSON.stringify({ ok: errors.length === 0, cases: results.length, errors, evidence }))
    assert.equal(errors.length, 0, 'RSS menus must remain inside their pane and avoid native browser coverage')
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
      console.log(JSON.stringify(await page.evaluate(() => ({ sidebars: Array.from(document.querySelectorAll('[data-liquid-shell="side-panel"]')).map((entry) => ({ width: entry.getBoundingClientRect().width, variant: entry.dataset.sidePanelVariant, hidden: entry.closest('[aria-hidden="true"],[inert]')?.className })) })).catch(() => ({}))))
    }
    throw error
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
