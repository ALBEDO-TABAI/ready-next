// Build first. Default mode is the real-window acceptance for Claude, with isolated data only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
if (process.argv.includes('--checks')) {
  const result = require('node:child_process').spawnSync(require('electron'), ['--import', 'tsx', '--test', '--test-concurrency=1',
    'src/__tests__/ready-annotations.test.ts', 'src/__tests__/ready-annotations-native.test.ts', 'src/__tests__/ready-annotations-ui.test.tsx', 'src/__tests__/ready-annotations-preview.test.tsx'],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}
async function main() {
  const { _electron } = require('playwright')
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-annotations-')))
  const profile = path.join(temporary, 'profile'), vault = path.join(temporary, 'vault'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence); fs.mkdirSync(path.join(vault, '模板'))
  const file = path.join(vault, '原页.md'), target = path.join(vault, '引用.md')
  const original = '原块 ^source\n\n第二块'
  fs.writeFileSync(file, original); fs.writeFileSync(target, '插入位置'); fs.writeFileSync(path.join(vault, '模板', '会议.md'), '# {{title}}\n\n日期 {{date}}')
  const env = { ...process.env, READY_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.READY_START_HIDDEN
  let app
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const page = app.windows().find(window => window.url().includes('/renderer/index.html'))
      if (page) return page
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Ready Next renderer did not open')
  }
  try {
    let page = await launch()
    await page.evaluate(async root => {
      await window.electronAPI.vault.set(root)
      localStorage.setItem('ready-workspace-root', root); localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    await app.close(); page = await launch()
    const deadline = Date.now() + 30000
    while (!await page.getByTestId('draft-controls').isVisible()) {
      assert.ok(Date.now() < deadline, 'Document mode must open')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(150)
    }
    await page.getByRole('group', { name: '侧栏视角' }).getByRole('button', { name: '文件', exact: true }).click()
    const open = async name => {
      const row = page.getByText(name, { exact: true }).first()
      if (!await row.isVisible()) await page.getByText(path.basename(vault), { exact: true }).first().click()
      await row.click(); await page.locator('[data-ready-block-editor]:visible').first().waitFor()
    }
    const editor = () => page.locator('[data-ready-block-editor]:visible').first()
    const menu = async (text, action) => {
      const block = editor().locator('[data-block-start]').filter({ has: page.locator('[contenteditable]', { hasText: text }) }).first()
      await block.getByRole('button', { name: '块菜单', exact: true }).click()
      await page.getByRole('combobox', { name: '搜索操作' }).fill(action); await page.keyboard.press('Enter')
    }
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const save = async (file, accept) => {
      await page.keyboard.press(`${mod}+s`)
      const deadline = Date.now() + 15000
      let content = fs.readFileSync(file, 'utf8')
      while (!accept(content) && Date.now() < deadline) { await page.waitForTimeout(100); content = fs.readFileSync(file, 'utf8') }
      assert.ok(accept(content), `disk readback failed: ${file}; alerts: ${await page.getByRole('alert').allTextContents()}`)
      return content
    }
    const snapshot = async label => {
      fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify({ source: fs.readFileSync(file, 'utf8'), reference: fs.readFileSync(target, 'utf8'),
        comments: fs.existsSync(path.join(vault, '.ready', 'comments')) ? fs.readdirSync(path.join(vault, '.ready', 'comments')).map(name => JSON.parse(fs.readFileSync(path.join(vault, '.ready', 'comments', name), 'utf8'))) : [] }, null, 2))
      await page.screenshot({ path: path.join(evidence, label + '.png') }); console.log('PASS ' + label + ' disk readback')
    }
    await open('原页.md'); await menu('原块', '添加评论')
    await page.getByRole('textbox', { name: '评论内容', exact: true }).fill('评论验收')
    await page.getByRole('button', { name: '发表评论', exact: true }).click()
    await page.getByRole('complementary', { name: '评论面板' }).getByText('评论验收').waitFor()
    assert.equal(fs.readFileSync(file, 'utf8'), original); await snapshot('01-comment-body-unchanged')
    await menu('原块', '下移'); const moved = await save(file, text => text.indexOf('第二块') < text.indexOf('原块'))
    assert.ok(moved.indexOf('第二块') < moved.indexOf('原块'))
    await page.getByRole('button', { name: '定位到块', exact: true }).click()
    assert.ok(await editor().locator('[contenteditable]:focus').textContent().then(text => text.includes('原块')))
    await snapshot('02-move-comment-location')
    await page.getByRole('button', { name: '从模板新建页面', exact: true }).click()
    await page.getByLabel('模板标题', { exact: true }).fill('模板新页')
    await page.getByRole('button', { name: '创建页面', exact: true }).click()
    await page.getByRole('dialog', { name: '保存到…', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await page.getByRole('dialog', { name: '保存到…', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('dialog', { name: '从模板新建页面', exact: true }).waitFor({ state: 'detached' })
    assert.match(fs.readFileSync(path.join(vault, '模板新页.md'), 'utf8'), /日期 \d{4}-\d{2}-\d{2}/); await snapshot('03-template-page')
    await open('引用.md')
    const rich = editor().locator('[contenteditable]').first(); await rich.focus()
    await rich.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range) })
    await page.keyboard.insertText('/')
    await page.getByRole('combobox', { name: '搜索操作' }).fill('插入同步块'); await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '插入同步块', exact: true })
    await dialog.getByLabel('同步块引用', { exact: true }).fill('![[原页#^source]]'); await dialog.getByRole('button', { name: '插入', exact: true }).click()
    assert.equal((await save(target, text => text.trim() === '![[原页#^source]]')).trim(), '![[原页#^source]]')
    await page.getByRole('button', { name: '回到原处编辑', exact: true }).click()
    const source = editor().locator('[contenteditable]').filter({ hasText: '原块' }).first(); await source.fill('修改后的源块 ^source')
    assert.match(await save(file, text => text.includes('修改后的源块')), /修改后的源块/)
    await open('引用.md'); await page.getByRole('region', { name: '同步块' }).getByText('修改后的源块', { exact: true }).waitFor()
    assert.equal(fs.readFileSync(target, 'utf8').trim(), '![[原页#^source]]'); await snapshot('04-sync-refresh')
    console.log('Evidence: ' + evidence)
  } finally { await app?.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
