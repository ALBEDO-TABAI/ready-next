// Build the current checkout first. Real-window acceptance is run by Claude with isolated data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
if (process.argv.includes('--checks')) {
  const result = spawnSync(require('electron'), ['--import', 'tsx', '--test', '--test-concurrency=1',
    'src/__tests__/ready-library-import-parsers.test.ts', 'src/__tests__/ready-library-import.test.ts', 'src/__tests__/ready-library-import-ui.test.tsx'],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}
async function main() {
  const { _electron } = require('playwright'), JSZip = require('jszip')
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-import-')))
  const profile = path.join(temporary, 'profile'), vault = path.join(temporary, 'vault'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const zip = new JSZip(), pageName = '首页 ' + 'a'.repeat(32), dbName = '任务 ' + 'b'.repeat(32)
  zip.file(pageName + '.md', '# 首页\n\n<aside>导入提示</aside>\n\n![图](' + encodeURI(pageName + '/image.png') + ')\n![缺失](missing.png)\n')
  zip.file(pageName + '/image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64'))
  zip.file(dbName + '.csv', 'Name,编号\n事项,00123\n')
  const source = path.join(temporary, 'notion.zip'), original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(source, original)
  const env = { ...process.env, READY_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.READY_START_HIDDEN
  let app, page
  const wait = async (predicate, label, timeout = 30000) => {
    const deadline = Date.now() + timeout
    while (!await predicate()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], cwd: process.cwd(), env, timeout: 45000 })
    await wait(async () => { page = app.windows().find(window => window.url().includes('/renderer/index.html')); return !!page }, 'Ready Next renderer did not open', 45000)
    await wait(() => page.evaluate(() => !!window.electronAPI?.documentImport), 'Import API missing')
  }
  const wizard = () => page.getByRole('dialog', { name: '导入 Notion / Inkwell', exact: true })
  const showWizard = async () => {
    await wait(async () => {
      if (await page.locator('.ink-doc-app').isVisible()) return true
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      return false
    }, 'Document sidebar missing')
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    await page.getByRole('navigation', { name: '文档侧栏' }).getByRole('button', { name: '导入', exact: true }).click()
  }
  try {
    await launch()
    await page.evaluate(async root => {
      const state = await window.electronAPI.vault.set(root); if (state.status !== 'ready') throw new Error('Test vault unavailable')
      localStorage.setItem('ready-workspace-root', root); localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    await app.close(); await launch(); await showWizard()
    // Only replace the native picker result; parsing, preflight, writes and UI all run through production IPC.
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, source)
    await wizard().getByRole('button', { name: '选择 Notion ZIP' }).click()
    await wizard().getByRole('button', { name: '选择导入位置' }).waitFor()
    assert.match(await wizard().innerText(), /3 页，1 个库，1 行，1 个附件/)
    await page.screenshot({ path: path.join(evidence, '01-preflight.png') })
    await wizard().getByRole('button', { name: '选择导入位置' }).click()
    const picker = page.getByRole('dialog', { name: '保存到…', exact: true })
    await picker.getByRole('textbox', { name: '标题', exact: true }).fill('导入验收')
    await picker.getByRole('button', { name: '确认', exact: true }).click()
    await wizard().getByRole('button', { name: '开始导入', exact: true }).click()
    await wait(async () => (await wizard().innerText()).includes('导入结束，但有缺失'), 'Import did not report its known missing attachment')
    const records = await page.evaluate(async () => { const result = await window.electronAPI.documentImport.list(); if (!result.ok) throw new Error(result.message); return result.value })
    assert.equal(records.length, 1); assert.equal(records[0].state, 'incomplete'); assert.equal(records[0].results.length, 4)
    assert.ok(records[0].issues.some(issue => issue.message.includes('missing.png')))
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(records[0], null, 2))
    const disk = new Map(records[0].results.map(result => [result.path, fs.readFileSync(result.path)]))
    await page.screenshot({ path: path.join(evidence, '02-result.png') })
    await wizard().getByRole('button', { name: '打开页面：首页.md', exact: true }).click()
    await wizard().getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('[data-ready-block-editor]:visible').first().waitFor()
    await page.screenshot({ path: path.join(evidence, '03-page.png') })
    await showWizard(); await wizard().getByRole('button', { name: '核对结果', exact: true }).click()
    await wizard().getByRole('button', { name: '打开数据库：任务.md', exact: true }).click()
    await wizard().getByRole('button', { name: '关闭', exact: true }).click()
    await page.locator('.ready-database[data-database-id]:visible').first().waitFor()
    await page.screenshot({ path: path.join(evidence, '04-database.png') })
    await app.close(); await launch()
    const resumed = await page.evaluate(async id => { const result = await window.electronAPI.documentImport.resume(id); if (!result.ok) throw new Error(result.message); return result.value }, records[0].id)
    assert.deepEqual(resumed.results, records[0].results); assert.equal(resumed.state, 'incomplete')
    for (const [file, bytes] of disk) assert.deepEqual(fs.readFileSync(file), bytes)
    assert.deepEqual(fs.readFileSync(source), original)
    console.log(JSON.stringify({ ok: true, sourceUnchanged: true, restartUnchanged: true, evidence }, null, 2))
  } finally { if (app) await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
