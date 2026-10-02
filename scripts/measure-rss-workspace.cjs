#!/usr/bin/env node
'use strict'
// Same-machine comparison against the planning baseline; only temporary synthetic profiles are opened.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { performance } = require('node:perf_hooks')
const { _electron } = require('playwright')

async function frames(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function scrollSample(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const list = document.querySelector('[data-liquid-scroll-root="rss-feed-list"]')
    const intervals = [], started = performance.now()
    let previous = started, count = 0, direction = 1
    const step = (now) => {
      if (count > 5) intervals.push(now - previous)
      previous = now
      if (list.scrollTop >= list.scrollHeight - list.clientHeight - 2) direction = -1
      if (list.scrollTop <= 0) direction = 1
      list.scrollTop += direction * 120
      if (++count < 125) return requestAnimationFrame(step)
      intervals.sort((a, b) => a - b)
      resolve({ frames: intervals.length, p50Ms: intervals[Math.floor(intervals.length / 2)], p95Ms: intervals[Math.floor(intervals.length * .95)],
        over33ms: intervals.filter((value) => value > 33.4).length, maxMs: intervals.at(-1), elapsedMs: now - started })
    }
    requestAnimationFrame(step)
  }))
}

async function sample(sourceRoot, count, label, evidence) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-rss-performance-'))
  let app
  try {
    const seedPath = path.join(root, 'seed.mts')
    fs.writeFileSync(seedPath, `import { DatabaseManager } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'src/main/modules/database.ts')).href)};
const db = new DatabaseManager(true), rss = db.rss || db;
(db.settings || db).setSetting('rss:auto_refresh_interval_ms','0');
const source = rss.addRSSSource({name:'Synthetic performance source',url:'https://rss-performance.invalid/feed'});
db.getRawDb().exec('BEGIN');
for(let i=0;i<${count};i++){
  const id='performance-'+i;
  rss.upsertRSSItems([{id,source_id:source,guid:id,title:'性能资讯 '+String(i).padStart(4,'0')+' 包含较长标题的固定合成资料',link:'https://rss-performance.invalid/article/'+i,summary:'固定摘要，用于同机加载、筛选与滚动比较。'.repeat(4),author:'Synthetic',published_at:1700000000+i}]);
  if(i%2===0) rss.markRSSRead(id);
}
db.getRawDb().exec('COMMIT');
await db.getRawDb().backup(${JSON.stringify(path.join(root, 'ready.db'))});db.close();`)
    const seeded = spawnSync(require('electron'), [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), seedPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    })
    fs.writeFileSync(path.join(evidence, `${label}-${count}-seed.log`), seeded.stdout + seeded.stderr)
    assert.equal(seeded.status, 0, 'synthetic database seeding failed')
    const env = { ...process.env, READY_USER_DATA_DIR: root }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: require('electron'), args: [sourceRoot], env, timeout: 45000 })
    let page
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      page = app.windows().find((entry) => entry.url().includes('/renderer/index.html'))
      if (page) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(page, 'workbench did not open')
    await app.evaluate(({ BrowserWindow, app }) => { const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().includes('/renderer/index.html')); window.setSize(1440, 900); app.focus({ steal: true }) })
    const started = performance.now()
    await page.getByTitle('rss', { exact: true }).click()
    await page.locator('.rss-item-row').first().waitFor()
    const after = label === 'after'
    const expected = after ? 50 : count
    await page.waitForFunction((n) => document.querySelectorAll('[data-liquid-scroll-root="rss-feed-list"] .rss-item-row').length === n, expected)
    await frames(page)
    const initialMs = performance.now() - started
    const beforeScroll = await page.evaluate(() => {
      const list = document.querySelector('[data-liquid-scroll-root="rss-feed-list"]')
      return { rssWidth: document.querySelector('.rss-mode-shell').getBoundingClientRect().width,
        rows: list.querySelectorAll('.rss-item-row').length, domNodes: list.querySelectorAll('*').length,
        heapBytes: performance.memory?.usedJSHeapSize ?? null }
    })
    const scrolling = await scrollSample(page)
    const switchStarted = performance.now()
    if (after) {
      await page.getByRole('navigation', { name: 'RSS 内部导航' }).getByRole('button', { name: '未读', exact: true }).click()
      await page.waitForFunction((n) => document.querySelector('.rss-workspace-heading p')?.textContent.startsWith(`${n} 条`), count / 2)
    } else {
      await page.locator('select').filter({ has: page.locator('option[value="unread"]') }).selectOption('unread')
      await page.waitForFunction((n) => document.querySelectorAll('[data-liquid-scroll-root="rss-feed-list"] .rss-item-row').length === n, count / 2)
    }
    await frames(page)
    const switchMs = performance.now() - switchStarted
    let searchMs = null, projections = null
    if (after) {
      const searchStarted = performance.now()
      await page.getByRole('textbox', { name: '搜索资讯', exact: true }).fill('性能资讯 0001')
      await page.getByRole('button', { name: '执行搜索', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.rss-workspace-heading p')?.textContent.startsWith('1 条'))
      await frames(page); searchMs = performance.now() - searchStarted
      await page.getByRole('button', { name: '清除搜索', exact: true }).click()
      await page.waitForFunction((n) => document.querySelector('.rss-workspace-heading p')?.textContent.startsWith(`${n} 条`), count / 2)
      await page.getByRole('button', { name: /查看分析任务/ }).click()
      await page.locator('.rss-task-menu-panel .ready-liquid-popover__projection-clone .rss-item-row').first().waitFor({ state: 'attached' })
      projections = await page.evaluate(() => ({ layers: document.querySelectorAll('.rss-task-menu-panel .ready-liquid-popover__projection').length,
        clonedRows: document.querySelectorAll('.rss-task-menu-panel .ready-liquid-popover__projection-clone .rss-item-row').length }))
      await page.locator('.rss-task-menu-panel').getByTitle('关闭', { exact: true }).click()
    }
    await page.screenshot({ path: path.join(evidence, `${label}-${count}.png`) })
    return { label, count, initialMs, ...beforeScroll, scrolling, switchMs, searchMs, projections }
  } finally { if (app) await app.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
}

async function main() {
  const [before, after = process.cwd(), evidence = '/tmp/ready-rss-performance-comparison'] = process.argv.slice(2)
  assert.ok(before && fs.existsSync(path.join(before, 'out/main/index.js')), 'provide a built baseline checkout/export')
  fs.mkdirSync(evidence, { recursive: true })
  const results = []
  for (const count of [200, 2000]) for (const [label, source] of [['before', before], ['after', after]]) {
    const result = await sample(path.resolve(source), count, label, evidence)
    results.push(result); console.log(JSON.stringify(result))
  }
  const report = { before, after, runtime: require('electron/package.json').version, workload: 'Same titles/summaries, half read; 1440x900 host; 125 scroll frames; warm local assets, isolated database per sample', results }
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
