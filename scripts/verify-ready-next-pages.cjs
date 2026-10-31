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
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app, [data-draft-boot="no_vault"]').first().isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app, [data-draft-boot="no_vault"]').first().waitFor({ state: 'visible' })
    const snapshot = async label => {
      const files = []
      const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else files.push({ path: path.relative(vault, file), ...(file.endsWith('.md') ? { content: fs.readFileSync(file, 'utf8') } : {}) }) } }
      walk(vault)
      fs.writeFileSync(path.join(evidence, `${label}.json`), JSON.stringify(files, null, 2))
      await page.screenshot({ path: path.join(evidence, `${label}.png`) })
      console.log(`PASS ${label}: disk readback + screenshot`)
    }
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app, [data-draft-boot="no_vault"]').first().isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    // An empty profile has no vault: Document mode offers the first-run choice instead of the shell.
    await page.locator('[data-draft-boot="no_vault"]').getByRole('button', { name: '选择文件夹…', exact: true }).waitFor()
    const reads = await app.evaluate(() => globalThis.__pageDirectoryReads)
    assert.deepEqual(reads, [], `Empty profile issued directory reads: ${JSON.stringify(reads)}`)
    await snapshot('01-empty-no-directory-reads')
    await page.evaluate(async root => { const state = await window.electronAPI.vault.set(root); if (state.status !== 'ready') throw new Error('Vault not ready') }, vault)
    // With a vault the drafts start and the document shell replaces the first-run notice.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app').isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    const sidebar = page.getByLabel('页面侧栏', { exact: true })
    const renameNewPage = async title => {
      await page.waitForFunction(() => { const input = document.querySelector('textarea[aria-label="页面标题"]'); return input?.value === '未命名' && !input.disabled })
      const input = page.getByRole('textbox', { name: '页面标题', exact: true })
      await input.fill(title); await input.press('Enter')
      await sidebar.locator('.ink-sb-label-btn').filter({ hasText: new RegExp(`^${title}$`) }).waitFor()
    }
    // Add buttons show on hover, as in Inkwell.
    const newRootPage = async title => { await sidebar.locator('section[aria-label="页面"] .ink-sb-section-head').hover(); await sidebar.getByRole('button', { name: '在 测试资料库 中新建页面', exact: true }).click(); await renameNewPage(title) }
    const action = async (row, title, label) => {
      await row.locator('.ink-sb-row').first().hover(); await row.getByRole('button', { name: `${title} 操作`, exact: true }).click()
      await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click()
    }
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
      return sidebar.locator(`section[aria-label="页面"] [data-page-id="${id}"]`)
    }
    let parentRow = await row('父页')
    await parentRow.locator('.ink-sb-row').first().hover(); await parentRow.getByRole('button', { name: '在 父页 中新建页面', exact: true }).click(); await renameNewPage('子页')
    assert.ok(fs.existsSync(path.join(vault, '父页', '子页.md')))
    assert.deepEqual(fs.readFileSync(path.join(vault, '父页.md')), parentBytes)
    await snapshot('02-create-parent-child')
    // Include the attachments member in subsequent real rename/move/trash checks.
    fs.mkdirSync(path.join(vault, '父页.assets')); fs.writeFileSync(path.join(vault, '父页.assets', 'fixture.txt'), 'attachment')
    await action(parentRow, '父页', '改名')
    await page.getByRole('dialog', { name: '改名', exact: true }).getByLabel('页面名称').fill('改名页')
    await page.getByRole('dialog', { name: '改名', exact: true }).getByRole('button', { name: '确定', exact: true }).click()
    await page.getByRole('dialog', { name: '改名', exact: true }).waitFor({ state: 'detached' })
    assert.ok(fs.existsSync(path.join(vault, '改名页', '子页.md')))
    assert.equal(fs.readFileSync(path.join(vault, '改名页.assets', 'fixture.txt'), 'utf8'), 'attachment')
    assert.ok(!fs.existsSync(path.join(vault, '父页.md')))
    await snapshot('03-rename')
    await newRootPage('目标页')
    parentRow = await row('改名页')
    await action(parentRow, '改名页', '移动到…')
    const picker = page.getByRole('dialog', { name: '移动到…' })
    await picker.getByRole('treeitem', { name: '目标页', exact: true }).click()
    await picker.getByRole('button', { name: '确认', exact: true }).click(); await picker.waitFor({ state: 'detached' })
    const moved = path.join(vault, '目标页', '改名页.md')
    assert.ok(fs.existsSync(moved)); assert.ok(!fs.existsSync(path.join(vault, '改名页.md')))
    assert.ok(fs.existsSync(path.join(vault, '目标页', '改名页', '子页.md')))
    assert.equal(fs.readFileSync(path.join(vault, '目标页', '改名页.assets', 'fixture.txt'), 'utf8'), 'attachment')
    await snapshot('04-move')
    await sidebar.getByRole('button', { name: '展开 目标页', exact: true }).click()
    parentRow = await row('改名页'); await action(parentRow, '改名页', '移到回收站')
    await parentRow.waitFor({ state: 'detached' })
    assert.ok(!fs.existsSync(moved))
    await page.getByRole('navigation', { name: '文档侧栏' }).getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByLabel('回收站内容', { exact: true }).getByRole('button', { name: '恢复 改名页', exact: true }).waitFor()
    await snapshot('05-trash')
    await page.getByLabel('回收站内容', { exact: true }).getByRole('button', { name: '恢复 改名页', exact: true }).click()
    await page.getByText('回收站为空', { exact: true }).waitFor()
    assert.ok(fs.existsSync(moved)); assert.ok(fs.existsSync(path.join(vault, '目标页', '改名页', '子页.md')))
    assert.equal(fs.readFileSync(path.join(vault, '目标页', '改名页.assets', 'fixture.txt'), 'utf8'), 'attachment')
    await snapshot('06-restore')
    const errors = await page.getByRole('alert').allTextContents()
    assert.deepEqual(errors, [])
    console.log(`PASS Ready Next pages; evidence: ${evidence}; isolated profile: ${profile}`)
  } finally {
    if (app) await app.close()
    console.log(`Retained isolated test files for review: ${temporary}`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
