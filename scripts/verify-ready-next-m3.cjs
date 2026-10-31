// Build this checkout before the window run. --cli performs only the isolated
// component/service contracts; it never claims screenshots or restart proof.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { spawnSync } = require('node:child_process')

const tests = [
  'src/__tests__/ready-next-m3.test.tsx',
  'src/__tests__/ready-drafts-ui.test.tsx',
  'src/__tests__/untitled-doc-tab-save.test.ts',
  'src/__tests__/ready-page-ui.test.tsx',
]
async function main() {
  const check = spawnSync(require('electron'), ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', ...tests], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(check.stdout || ''); process.stderr.write(check.stderr || '')
  assert.equal(check.status, 0, 'M3 component/service checks failed')
  assert.match(check.stdout, /# skipped 0\b/, 'Skipped contracts do not pass M3')
  if (process.argv.includes('--cli')) { console.log('PASS M3 CLI; real-window acceptance remains pending'); return }

  const { _electron } = require('playwright')
  // Page operations take the canonical vault root (macOS temp paths sit behind the /var -> /private/var link).
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-m3-')))
  const profile = path.join(temporary, 'profile'), vault = path.join(temporary, '测试资料库'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  assert.ok(fs.existsSync(path.resolve(require('../package.json').main)), 'Build this checkout first')
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE; delete env.READY_START_HIDDEN
  let app, page
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    const deadline = Date.now() + 60000
    page = undefined
    while (!page && Date.now() < deadline) {
      page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
      if (!page) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(page, 'Ready Next renderer did not appear')
    // The document shell is visible even when the topbar has no draft controls to show.
    while (!await page.locator('.ink-doc-app').isVisible().catch(() => false)) {
      assert.ok(Date.now() < deadline, 'Document mode did not open')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(150)
    }
  }
  const snapshot = async label => {
    const files = []
    const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push({ path: path.relative(vault, file), bytes: fs.readFileSync(file).toString('base64'), ...(file.endsWith('.md') ? { content: fs.readFileSync(file, 'utf8') } : {}) })
    } }
    walk(vault)
    const drafts = await page.evaluate(async () => {
      const result = await window.electronAPI.documentDrafts.list()
      if (!result.ok) throw new Error(result.message)
      return result.value
    })
    fs.writeFileSync(path.join(evidence, `${label}.json`), JSON.stringify({ files, drafts }, null, 2))
    await page.screenshot({ path: path.join(evidence, `${label}.png`) })
    console.log(`PASS ${label}: disk/database readback + screenshot`)
  }
  const sidebar = () => page.getByLabel('页面侧栏', { exact: true })
  const row = id => sidebar().locator(`section[aria-label="页面"] [data-page-id="${id}"]`)
  const createPage = async title => {
    await sidebar().getByRole('button', { name: '在 测试资料库 中新建页面', exact: true }).click()
    await page.waitForFunction(() => { const input = document.querySelector('textarea[aria-label="页面标题"]'); return input?.value === '未命名' && !input.disabled })
    const input = page.getByRole('textbox', { name: '页面标题', exact: true })
    await input.fill(title); await input.press('Enter')
    await sidebar().locator('.ink-sb-label-btn').filter({ hasText: new RegExp(`^${title}$`) }).waitFor()
    return page.evaluate(async ({ vault, title }) => {
      const result = await window.electronAPI.documentPages.tree({ path: vault, kind: 'vault' })
      if (!result.ok) throw new Error(result.message)
      const node = result.value.children.find(node => node.title === title)
      if (!node) throw new Error('Created page absent from tree')
      return node.objectId
    }, { vault, title })
  }
  const action = async (id, title, label) => {
    await row(id).getByRole('button', { name: `${title} 操作`, exact: true }).click()
    await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click()
  }
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await launch()
    await page.evaluate(async root => { const result = await window.electronAPI.vault.set(root); if (result.status !== 'ready') throw new Error('Vault not ready') }, vault)
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    await snapshot('01-empty-profile-vault')
    const parentId = await createPage('父页')
    await row(parentId).getByRole('button', { name: '父页', exact: true }).click()
    const header = page.getByLabel('页面头部', { exact: true })
    await header.getByRole('button', { name: '添加图标', exact: true }).click()
    const icon = page.getByRole('dialog', { name: '选择图标', exact: true })
    await icon.getByLabel('自定义图标').fill('🌱'); await icon.getByRole('button', { name: '使用', exact: true }).click()
    await header.getByLabel('页面标题').fill('验收页'); await header.getByLabel('页面标题').press('Enter')
    await row(parentId).getByRole('button', { name: '验收页', exact: true }).waitFor()
    const parentFile = path.join(vault, '验收页.md')
    assert.match(fs.readFileSync(parentFile, 'utf8'), /🌱/)
    await snapshot('02-page-header')
    await page.getByRole('button', { name: '添加文字', exact: true }).click()
    const rich = page.locator('[contenteditable="true"]:visible').first()
    await rich.fill('中文第一段第二段'); await rich.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home'); await rich.press('ArrowRight'); await rich.press('ArrowRight'); await rich.press('ArrowRight'); await rich.press('ArrowRight'); await rich.press('ArrowRight'); await rich.press('Enter')
    await page.getByTestId('draft-status').filter({ hasText: '已持久确认' }).waitFor()
    const original = await page.evaluate(async id => {
      const result = await window.electronAPI.documentDrafts.list()
      if (!result.ok) throw new Error(result.message)
      const draft = result.value.find(draft => draft.objectId === id)
      if (!draft || !draft.content.includes('中文第一段\n\n第二段')) throw new Error('Split text was not confirmed')
      return draft.content
    }, parentId)
    await snapshot('03-chinese-split-confirmed')
    const exited = once(app.process(), 'exit'); app.process().kill('SIGKILL'); await exited; app = undefined
    await launch()
    // The confirmed body is durable in Main. The tab list lives in localStorage and may not reach disk before a
    // SIGKILL, so an orphaned draft comes back through "未保存的草稿" (the designed recovery path).
    const recovered = await page.evaluate(async id => {
      const result = await window.electronAPI.documentDrafts.list()
      if (!result.ok) throw new Error(result.message)
      return result.value.find(draft => draft.objectId === id) ?? null
    }, parentId)
    assert.equal(recovered?.content, original, 'the confirmed draft survives SIGKILL in Main')
    const tabOpen = await page.evaluate(id => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs?.some(tab => tab.objectId === id), parentId)
    if (tabOpen) await row(parentId).getByRole('button', { name: '验收页', exact: true }).click()
    else {
      await page.getByRole('button', { name: /^未保存的草稿/ }).click()
      await page.getByTestId(`draft-recovery-${recovered.draftId}`).locator('button.ink-sb-label-btn').click()
    }
    await page.locator('.draggable-mode-switch__label--edit:visible').first().click()
    const source = page.locator('textarea.document-source-textarea:visible').first()
    await source.waitFor(); assert.equal(await source.inputValue(), original)
    await source.press(`${mod}+s`)
    // Playwright's waitForFunction does not await an async predicate; poll the disk from here.
    const savedDeadline = Date.now() + 15000
    while (fs.readFileSync(parentFile, 'utf8') !== original && Date.now() < savedDeadline) await page.waitForTimeout(100)
    assert.equal(fs.readFileSync(parentFile, 'utf8'), original)
    await snapshot('04-sigkill-restored')
    // Create an untitled document through the app shortcut.
    await page.keyboard.press(`${mod}+t`)
    await page.locator('.draggable-mode-switch__label--edit:visible').first().click()
    await source.fill('子页草稿正文')
    await page.getByTestId('draft-status').filter({ hasText: '已持久确认' }).waitFor()
    await page.getByTestId('draft-controls').getByRole('button', { name: '保存到…', exact: true }).click()
    const picker = page.getByTestId('draft-controls').getByRole('dialog', { name: '保存到…', exact: true })
    await picker.getByLabel('标题', { exact: true }).fill('子稿')
    await picker.getByRole('treeitem', { name: '验收页', exact: true }).click(); await picker.getByRole('button', { name: '确认', exact: true }).click()
    await picker.waitFor({ state: 'detached' })
    assert.match(fs.readFileSync(path.join(vault, '验收页', '子稿.md'), 'utf8'), /子页草稿正文/)
    await snapshot('05-draft-child')
    const targetId = await createPage('目标页')
    // A real indexed reference, created through the page service, follows the move.
    const ref = await page.evaluate(async root => window.electronAPI.documentPages.operate({ type: 'create', root, parentPath: root, operationId: crypto.randomUUID(), title: '引用页', content: '[[验收页]]' }), vault)
    assert.ok(ref.ok)
    await action(parentId, '验收页', '移动到…')
    const move = page.getByRole('dialog', { name: '移动到…', exact: true })
    await move.getByRole('treeitem', { name: '目标页', exact: true }).click(); await move.getByRole('button', { name: '确认', exact: true }).click(); await move.waitFor({ state: 'detached' })
    const moved = path.join(vault, '目标页', '验收页.md')
    assert.ok(fs.existsSync(moved)); assert.ok(!fs.existsSync(parentFile))
    // The link repair rewrites references after the move settles (object event window, then repair); poll the disk.
    const repairDeadline = Date.now() + 15000
    while (!/\[\[目标页\/验收页\]\]/.test(fs.readFileSync(ref.value.path, 'utf8')) && Date.now() < repairDeadline) await page.waitForTimeout(200)
    assert.match(fs.readFileSync(ref.value.path, 'utf8'), /\[\[目标页\/验收页\]\]/)
    assert.match(fs.readFileSync(path.join(vault, '目标页', '验收页', '子稿.md'), 'utf8'), /子页草稿正文/)
    await snapshot('06-move-reference')
    await row(targetId).getByRole('button', { name: '展开 目标页', exact: true }).click()
    await action(parentId, '验收页', '移到回收站'); await row(parentId).waitFor({ state: 'detached' })
    assert.ok(!fs.existsSync(moved)); await snapshot('07-trash')
    await page.getByRole('navigation', { name: '文档侧栏' }).getByRole('button', { name: '回收站', exact: true }).click()
    await page.getByLabel('回收站内容', { exact: true }).getByRole('button', { name: '恢复 验收页', exact: true }).click(); await page.getByText('回收站为空', { exact: true }).waitFor()
    assert.ok(fs.existsSync(moved)); assert.match(fs.readFileSync(moved, 'utf8'), /中文第一段\n\n第二段/)
    await snapshot('08-restored')
    assert.deepEqual(await page.getByRole('alert').allTextContents(), [])
    console.log(`PASS M3 real window: ${evidence}`)
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {})
    throw error
  } finally { if (app) await app.close(); console.log(`Retained isolated evidence: ${temporary}`) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
