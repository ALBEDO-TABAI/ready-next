// Run after building Ready Next. Real UI + disk readback; only a disposable profile/vault.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright')

async function main() {
  const project = process.cwd()
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-pages-'))
  const profile = path.join(temporary, 'profile')
  const vault = path.join(temporary, '测试资料库')
  const evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const entry = path.resolve(project, require(path.join(project, 'package.json')).main)
  assert.ok(fs.existsSync(entry), 'Build Ready Next first: bundled Main is missing')
  // Install the observer before Main registers IPC and before any Renderer exists.
  // Forward every request to the original handler; no filesystem or page service is replaced.
  const bootstrap = path.join(temporary, 'pages-bootstrap.cjs')
  fs.writeFileSync(bootstrap, `
const { app, ipcMain } = require('electron')
app.setAppPath(${JSON.stringify(project)})
globalThis.__pageDirectoryReads = []
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handle(channel, (event, ...args) => {
  if (channel === 'document:list' || channel === 'documentPages:tree') globalThis.__pageDirectoryReads.push({ channel, path: channel === 'document:list' ? args[0] : args[0].path })
  return listener(event, ...args)
})
require(${JSON.stringify(entry)})
`)
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], cwd: project, env, timeout: 45000 })
    const deadline = Date.now() + 90000
    let page
    while (!page && Date.now() < deadline) {
      page = app.windows().find(window => window.url().includes('/renderer/index.html'))
      if (!page) await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(page, 'Ready renderer did not open')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
    await page.getByRole('group', { name: '侧栏视角' }).waitFor()
    const snapshot = async label => {
      const files = []
      const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else files.push({ path: path.relative(vault, file), ...(file.endsWith('.md') ? { content: fs.readFileSync(file, 'utf8') } : {}) }) } }
      walk(vault)
      fs.writeFileSync(path.join(evidence, `${label}.json`), JSON.stringify(files, null, 2))
      await page.screenshot({ path: path.join(evidence, `${label}.png`) })
      console.log(`PASS ${label}: disk readback + screenshot`)
    }
    await page.getByRole('group', { name: '侧栏视角' }).getByRole('button', { name: '文件', exact: true }).click()
    await page.getByRole('button', { name: '打开文件夹…', exact: true }).waitFor()
    const reads = await app.evaluate(() => globalThis.__pageDirectoryReads)
    assert.deepEqual(reads, [], `Empty profile issued directory reads: ${JSON.stringify(reads)}`)
    await snapshot('01-empty-no-directory-reads')
    await page.evaluate(async root => { const state = await window.electronAPI.vault.set(root); if (state.status !== 'ready') throw new Error('Vault not ready') }, vault)
    await page.getByRole('group', { name: '侧栏视角' }).getByRole('button', { name: '页面', exact: true }).click()
    const sidebar = page.getByLabel('页面侧栏', { exact: true })
    const confirmPage = async title => {
      const picker = sidebar.getByRole('dialog', { name: '保存到…' })
      await picker.getByLabel('标题', { exact: true }).fill(title)
      await picker.getByRole('button', { name: '确认', exact: true }).click()
      await picker.waitFor({ state: 'detached' })
    }
    const newRootPage = async title => { await sidebar.getByRole('button', { name: '新建页面', exact: true }).click(); await confirmPage(title) }
    await newRootPage('父页')
    assert.ok(fs.existsSync(path.join(vault, '父页.md')))
    const parentBytes = fs.readFileSync(path.join(vault, '父页.md'))
    const row = async title => {
      const id = await page.evaluate(async ({ vault, title }) => {
        const tree = await window.electronAPI.documentPages.tree({ path: vault, kind: 'vault' })
        if (!tree.ok) throw new Error(tree.message)
        const find = node => node.title === title ? node.objectId : node.children.map(find).find(Boolean)
        return find(tree.value)
      }, { vault, title })
      assert.ok(id, `Missing page: ${title}`)
      return sidebar.locator(`[data-page-id="${id}"]`)
    }
    let parentRow = await row('父页')
    await parentRow.locator('summary').first().click()
    await parentRow.getByRole('button', { name: '新建子页面', exact: true }).click(); await confirmPage('子页')
    assert.ok(fs.existsSync(path.join(vault, '父页', '子页.md')))
    assert.deepEqual(fs.readFileSync(path.join(vault, '父页.md')), parentBytes)
    await snapshot('02-create-parent-child')
    // Include the attachments member in subsequent real rename/move/trash checks.
    fs.mkdirSync(path.join(vault, '父页.assets')); fs.writeFileSync(path.join(vault, '父页.assets', 'fixture.txt'), 'attachment')
    await parentRow.getByRole('button', { name: '改名', exact: true }).click()
    await sidebar.getByLabel('页面名称').fill('改名页')
    await sidebar.getByRole('button', { name: '确认改名' }).click()
    await sidebar.getByRole('dialog', { name: '改名', exact: true }).waitFor({ state: 'detached' })
    assert.ok(fs.existsSync(path.join(vault, '改名页', '子页.md')))
    assert.equal(fs.readFileSync(path.join(vault, '改名页.assets', 'fixture.txt'), 'utf8'), 'attachment')
    assert.ok(!fs.existsSync(path.join(vault, '父页.md')))
    await snapshot('03-rename')
    await newRootPage('目标页')
    parentRow = await row('改名页')
    const summary = parentRow.locator('details').first()
    if (!(await summary.evaluate(element => element.open))) await summary.locator('summary').click()
    await parentRow.getByRole('button', { name: '移动到…', exact: true }).click()
    const picker = sidebar.getByRole('dialog', { name: '移动到…' })
    await picker.getByRole('treeitem', { name: '目标页', exact: true }).click()
    await picker.getByRole('button', { name: '确认', exact: true }).click(); await picker.waitFor({ state: 'detached' })
    const moved = path.join(vault, '目标页', '改名页.md')
    assert.ok(fs.existsSync(moved)); assert.ok(!fs.existsSync(path.join(vault, '改名页.md')))
    assert.ok(fs.existsSync(path.join(vault, '目标页', '改名页', '子页.md')))
    assert.equal(fs.readFileSync(path.join(vault, '目标页', '改名页.assets', 'fixture.txt'), 'utf8'), 'attachment')
    await snapshot('04-move')
    await sidebar.getByRole('button', { name: '展开 目标页', exact: true }).click()
    parentRow = await row('改名页'); await parentRow.locator('summary').first().click()
    await parentRow.getByRole('button', { name: '移到回收站', exact: true }).click()
    await parentRow.waitFor({ state: 'detached' })
    assert.ok(!fs.existsSync(moved))
    await sidebar.getByRole('button', { name: '回收站', exact: true }).click()
    await sidebar.getByLabel('回收站内容', { exact: true }).getByRole('button', { name: '恢复', exact: true }).waitFor()
    await snapshot('05-trash')
    await sidebar.getByRole('button', { name: '恢复', exact: true }).click()
    await sidebar.getByText('回收站为空', { exact: true }).waitFor()
    assert.ok(fs.existsSync(moved)); assert.ok(fs.existsSync(path.join(vault, '目标页', '改名页', '子页.md')))
    assert.equal(fs.readFileSync(path.join(vault, '目标页', '改名页.assets', 'fixture.txt'), 'utf8'), 'attachment')
    await snapshot('06-restore')
    const errors = await sidebar.getByRole('alert').allTextContents()
    assert.deepEqual(errors, [])
    console.log(`PASS Ready Next pages; evidence: ${evidence}; isolated profile: ${profile}`)
  } finally {
    if (app) await app.close()
    console.log(`Retained isolated test files for review: ${temporary}`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
