// Real Ready Next window acceptance. Run outside the Codex sandbox after shell integration.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

if (process.argv.includes('--checks')) {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(require('electron'), ['--import', 'tsx', '--test', '--test-concurrency=1',
    'src/__tests__/ready-next-object-ui.test.tsx', 'src/__tests__/ready-next-object-relations-native.test.ts',
    'src/__tests__/native-surface-aware-overlay.test.ts'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}

async function main() {
  const { _electron } = require('playwright')
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-object-ui-')))
  const vault = path.join(temporary, '测试资料库'), profile = path.join(temporary, 'profile')
  fs.mkdirSync(vault)
  const html = path.join(vault, '网页.html')
  fs.writeFileSync(html, '<html><body style="background:#4db6ac">M5-C native browser fixture</body></html>')
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE; delete env.READY_START_HIDDEN
  // The first window can be a transient one; wait for the workbench renderer, and relaunch instead of reloading.
  let app, page
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], cwd: process.cwd(), env })
    const deadline = Date.now() + 60000
    page = undefined
    while (!page && Date.now() < deadline) {
      page = app.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
      if (!page) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(page, 'Ready Next renderer did not appear')
    await page.waitForFunction(() => Boolean(window.electronAPI?.documentPages))
  }
  await launch()
  try {
    await page.evaluate(async root => {
      const result = await window.electronAPI.vault.set(root)
      if (result.status !== 'ready') throw new Error('无法打开测试资料库')
      localStorage.setItem('ready-workspace-root', root)
      localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    await app.close(); await launch()
    const ids = await page.evaluate(async root => {
      const create = async (title, content) => {
        const result = await window.electronAPI.documentPages.operate({ type: 'create', root, parentPath: root, title, content, operationId: crypto.randomUUID() })
        if (!result.ok) throw new Error(result.message)
        return result.value.objectId
      }
      const target = await create('M5验收目标', '# 速览正文')
      const source = await create('M5验收来源', `[[M5验收目标]]`)
      const indexed = await window.electronAPI.document.reindexWorkspace(root)
      if (!indexed.success) throw new Error(indexed.error)
      return { target, source }
    }, vault)
    const shortcut = process.platform === 'darwin' ? 'Meta+k' : 'Control+k'
    const search = async keyword => {
      await page.keyboard.press(shortcut)
      const input = page.getByRole('combobox', { name: '搜索所有对象和命令' })
      await input.waitFor({ timeout: 10000 }) // Missing ObjectUIHost is a failure, never skip.
      await input.fill(keyword)
      return input
    }
    await search('M5验收目标')
    const option = page.getByRole('option').filter({ hasText: 'M5验收目标' }).locator('button').first()
    if (!await option.waitFor({ timeout: 10000 }).then(() => true, () => false)) {
      const state = await page.evaluate(async root => ({
        roots: (() => { try { return [localStorage.getItem('ready-workspace-root'), localStorage.getItem('ready-pinned-folders')] } catch { return null } })(),
        direct: await window.electronAPI.document.searchIndex({ query: 'M5验收目标', workspaceRoots: [root] }),
        listbox: document.querySelector('[role="listbox"]')?.textContent?.slice(0, 300),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(alert => alert.textContent),
      }), vault)
      await page.screenshot({ path: path.join(temporary, 'switcher-failure.png') })
      throw new Error(`⌘K found no option: ${JSON.stringify(state).slice(0, 1500)} (screenshot in ${temporary})`)
    }
    await option.click()
    await page.getByLabel('关联面板').waitFor()
    console.log('PASS 1: ⌘K 搜索页面并打开')
    await page.getByLabel('关联面板').locator('summary').click()
    await page.getByLabel('关联面板').getByRole('button', { name: 'M5验收来源', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="关联面板"]')?.textContent.includes('出链'))
    await page.getByLabel('关联面板').locator('summary').click()
    console.log('PASS 3: 从关联面板打开反链')
    await page.getByLabel('关联面板').getByRole('button', { name: '速览 M5验收目标', exact: true }).click()
    await page.getByRole('dialog').getByText('速览正文', { exact: true }).waitFor()
    await page.evaluate(async ({ root, id }) => {
      const result = await window.electronAPI.documentPages.operate({ type: 'trash', root, objectId: id, operationId: crypto.randomUUID() })
      if (!result.ok) throw new Error(result.message)
    }, { root: vault, id: ids.target })
    await page.getByRole('dialog').getByText('引用已失效', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    console.log('PASS 4: 速览引用，回收后立即显示失效')
    await page.evaluate(async url => {
      const result = await window.electronAPI.browser.createTab(url)
      if (!result.success) throw new Error(result.error)
      window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'browser', placement: 'primary', presentation: 'immediate' } }))
    }, pathToFileURL(html).href)
    const visibleNative = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.contentView.children.some(view => {
      const b = view.getBounds()
      return view.webContents && b.x >= 0 && b.y >= 0 && b.width > 1 && b.height > 1
    })))
    const waitNative = async expected => {
      const end = Date.now() + 10000
      while ((await visibleNative()) !== expected) { assert.ok(Date.now() < end, `Native visibility did not become ${expected}`); await page.waitForTimeout(50) }
    }
    await waitNative(true)
    await search('M5验收来源')
    await waitNative(false)
    await page.keyboard.press('Escape')
    await waitNative(true)
    console.log('PASS 2: 浏览器 ⌘K 隐藏网页，关闭后恢复')
    const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(win => win.isVisible()).capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(temporary, 'window.png'), Buffer.from(shot, 'base64'))
    console.log(`PASS M5-C real-window acceptance: ${temporary}`)
  } finally { if (app) await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
