// M5-F: build Ready Next and register M5-A's IPC before running this real-window proof.
// --checks runs the command-line contract suite without opening a window or rebuilding dependencies.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { parse, stringify } = require('yaml')

if (process.argv.includes('--checks')) {
  const files = [
    'src/__tests__/ready-database-views.test.tsx',
    'src/__tests__/ready-database-inline.test.tsx',
    'src/__tests__/ready-database-views-native.test.tsx',
    'src/__tests__/ready-database-views.serial.test.tsx',
  ]
  const result = spawnSync(require('electron'), ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}

async function main() {
  const { _electron } = require('playwright')
  // Page operations take the canonical vault root (macOS temp paths sit behind the /var -> /private/var link).
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-database-')))
  const profile = path.join(temporary, 'profile'), vault = path.join(temporary, '测试资料库'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const entry = path.resolve(process.cwd(), require('../package.json').main)
  assert.ok(fs.existsSync(entry), '先构建 Ready Next，并由 M5-F 注册 documentDatabase IPC')
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], cwd: process.cwd(), env, timeout: 45000 })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const page = app.windows().find(window => window.url().includes('/renderer/index.html'))
      if (page) return page
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Ready Next 窗口未打开')
  }
  const fields = content => parse(content.split(/^---\s*$/m)[1])
  const readRows = () => fs.readdirSync(path.join(vault, '验收库')).filter(name => name.endsWith('.md')).map(name => ({ name, content: fs.readFileSync(path.join(vault, '验收库', name), 'utf8') }))
  try {
    let page = await launch()
    await page.evaluate(async root => {
      const vault = await window.electronAPI.vault.set(root)
      if (vault.status !== 'ready') throw new Error('测试资料库未打开')
      localStorage.setItem('ready-workspace-root', root)
      localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    const definition = { version: 1, source: '验收库', fields: {
      内容: { id: 'text', name: '内容', type: 'text' }, 状态: { id: 'status', name: '状态', type: 'select', options: ['待办', '完成'] }, 日期: { id: 'date', name: '日期', type: 'date' },
    }, views: [
      { id: 'table', name: '表格', type: 'table' },
      { id: 'board', name: '看板', type: 'board', groupBy: 'status', cardFields: ['text', 'date'] },
      { id: 'calendar', name: '日历', type: 'calendar', dateField: 'date', cardFields: ['text'] },
    ] }
    const databaseId = await page.evaluate(async ({ root, content }) => {
      const result = await window.electronAPI.documentPages.operate({ type: 'create', root, parentPath: root, operationId: 'm5b-create-db', title: '验收库', content })
      if (!result.ok) throw new Error(result.message)
      return result.value.objectId
    }, { root: vault, content: `---\n${stringify({ ready_database: definition })}---\n数据库验收正文\n` })
    const rowId = await page.evaluate(async databaseId => {
      const result = await window.electronAPI.documentDatabase({ type: 'createRow', databaseId, operationId: 'm5b-create-row', title: '验收行', values: { text: '原文', status: '待办', date: { start: '2026-10-15', end: '2026-10-17' } }, body: '保留正文\n' })
      if (!result.ok) throw new Error(`M5-A 接线未就绪或建行失败：${result.message}`)
      return result.value.objectId
    }, databaseId)
    await page.evaluate(async root => {
      const result = await window.electronAPI.documentPages.operate({ type: 'create', root, parentPath: root, operationId: 'm5b-create-preview', title: '视图验收', content: '# 视图验收\n\n![[验收库#表格]]\n\n![[验收库#看板]]\n\n![[验收库#日历]]\n' })
      if (!result.ok) throw new Error(result.message)
    }, vault)
    assert.deepEqual(fields(fs.readFileSync(path.join(vault, '验收库.md'), 'utf8')).ready_database, definition)
    const snapshot = async label => {
      fs.writeFileSync(path.join(evidence, `${label}.json`), JSON.stringify({ definition: fs.readFileSync(path.join(vault, '验收库.md'), 'utf8'), rows: readRows() }, null, 2))
      await page.screenshot({ path: path.join(evidence, `${label}.png`), fullPage: true })
      console.log(`PASS ${label}: disk readback + screenshot`)
    }
    await snapshot('01-create')
    await app.close(); page = await launch()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app').isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    const note = page.getByText('视图验收.md', { exact: true }).first()
    if (!await note.isVisible()) await page.getByText(path.basename(vault), { exact: true }).first().click()
    await note.click()
    const table = page.locator('.ready-database[data-view-type="table"]:visible').first()
    const board = page.locator('.ready-database[data-view-type="board"]:visible').first()
    const calendar = page.locator('.ready-database[data-view-type="calendar"]:visible').first()
    await table.waitFor({ timeout: 15000 })
    const rowFile = path.join(vault, '验收库', '验收行.md')
    const before = fs.readFileSync(rowFile, 'utf8')
    await table.locator(`[data-row-id="${rowId}"] [data-field-id="text"]`).click()
    await table.getByLabel('字段值', { exact: true }).fill('表格修改')
    await table.getByLabel('保存单元格', { exact: true }).click()
    await table.getByRole('dialog').waitFor({ state: 'detached' })
    assert.deepEqual(fields(fs.readFileSync(rowFile, 'utf8')), { ...fields(before), 内容: '表格修改' })
    await snapshot('02-table-edit')
    // M7: the current view's rows go to the AI chat, each row as its own page.
    await table.getByRole('button', { name: '把当前视图发给 AI', exact: true }).click()
    await page.locator('.chat-reference-chip').first().waitFor({ timeout: 15000 })
    await snapshot('02b-ask-ai')
    // Another view's write reaches this one by itself (observeDatabase); there is no 刷新 button (W3 §4.4).
    await board.locator(`[data-row-id="${rowId}"]`).dragTo(board.locator('[data-group="完成"]'))
    await board.locator('[data-group="完成"]').locator(`[data-row-id="${rowId}"]`).waitFor()
    assert.deepEqual(fields(fs.readFileSync(rowFile, 'utf8')), { ...fields(before), 内容: '表格修改', 状态: '完成' })
    await snapshot('03-board-drag')
    await calendar.getByLabel('显示月份', { exact: true }).fill('2026-10')
    await calendar.locator(`[data-row-id="${rowId}"]`).first().dragTo(calendar.locator('[data-date="2026-10-20"]'))
    await calendar.locator('[data-date="2026-10-20"]').locator(`[data-row-id="${rowId}"]`).waitFor()
    assert.deepEqual(fields(fs.readFileSync(rowFile, 'utf8')), { ...fields(before), 内容: '表格修改', 状态: '完成', 日期: { start: '2026-10-20', end: '2026-10-22' } })
    await snapshot('04-calendar-drag')
    const current = fs.readFileSync(rowFile, 'utf8')
    assert.ok(current.endsWith('保留正文\n'))
    fs.writeFileSync(rowFile, current.replace('表格修改', '外部修改'))
    // The directory watcher brings the external write into every view; nothing to click.
    for (const view of [table, board, calendar]) {
      await view.locator(`[data-row-id="${rowId}"] [data-field-id="text"]`).first().filter({ hasText: '外部修改' }).waitFor()
      assert.deepEqual(await view.getByRole('alert').allTextContents(), [])
    }
    assert.equal(fields(fs.readFileSync(rowFile, 'utf8')).内容, '外部修改')
    await snapshot('05-external-refresh')
    // The database page itself shows the full database in the page view, under its header.
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app').isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    await page.locator('.ink-sidebar section[aria-label="页面"] .ink-sb-label-btn').filter({ hasText: /^验收库$/ }).click()
    await page.locator('[data-ready-database-page] .ready-database[data-view-type]:visible').first().waitFor({ timeout: 20000 })
    await snapshot('06-database-page')
    console.log(`PASS M5-B real UI; evidence=${evidence}`)
  } finally {
    if (app) await app.close()
    console.log(`保留隔离验收资料：${temporary}`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
