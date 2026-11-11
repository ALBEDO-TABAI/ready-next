// Build this checkout first. This gate requires a real Electron window; no CLI-only success mode.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { _electron } = require('playwright')

async function main() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-canvas-')))
  const vault = path.join(temporary, 'vault'), profile = path.join(temporary, 'profile'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const oldPath = path.join(vault, '旧画板.readyboard')
  const oldBytes = fs.readFileSync(path.join(__dirname, 'fixtures/ready-next-canvas.readyboard'))
  fs.writeFileSync(oldPath, oldBytes)
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app, page
  const poll = async (check, message) => {
    const deadline = Date.now() + 45000
    while (!await check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    await poll(() => { page = app.windows().find(p => p.url().includes('/renderer/index.html')); return Boolean(page) }, 'Renderer missing')
    await poll(() => page.evaluate(() => Boolean(window.electronAPI?.canvas)), 'Canvas preload missing')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
  }
  const snapshot = async label => {
    const files = []
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push({ path: path.relative(vault, file), bytes: fs.readFileSync(file).toString('base64') })
    } }
    walk(vault)
    const state = await page.evaluate(async () => ({ drafts: await window.electronAPI.documentDrafts.list(), fastcard: await window.electronAPI.browser.listFastCardItems() }))
    assert.equal(state.drafts.ok, true); assert.equal(state.fastcard.success, true)
    fs.writeFileSync(path.join(evidence, `${label}.json`), JSON.stringify({ files, state }, null, 2))
    await page.screenshot({ path: path.join(evidence, `${label}.png`) })
    console.log(`PASS ${label}: disk readback + screenshot`)
  }
  const reveal = async objectId => {
    // A normal ReadyRef link exercises the production reference dispatcher.
    const result = await page.evaluate(async ({ objectId, vault }) => {
      const api = window.electronAPI
      const tree = await api.documentPages.tree({ path: vault, kind: 'vault' })
      if (!tree.ok) throw new Error(tree.message)
      return tree.value.children.find(node => node.objectId === objectId)
    }, { objectId, vault })
    assert.ok(result, 'Object missing from page tree')
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app').isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    const row = page.getByLabel('页面侧栏', { exact: true }).locator(`[data-page-id="${objectId}"]`)
    await row.locator(':scope > .ink-sb-row > .ink-sb-label-btn').click()
  }
  try {
    await launch()
    await page.evaluate(async root => { const state = await window.electronAPI.vault.set(root); if (state.status !== 'ready') throw new Error('Vault not ready') }, vault)
    const seeded = await page.evaluate(async root => {
      const api = window.electronAPI
      const doc = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '来源文档', content: '# 来源\n\n真实正文', operationId: crypto.randomUUID() })
      if (!doc.ok) throw new Error(doc.message)
      const canvas = await api.canvas.create({ path: 'X.canvas', operationId: crypto.randomUUID(), canvas: { nodes: [], edges: [], ready: { id: crypto.randomUUID(), schemaVersion: 1, title: 'X' } } })
      if (!canvas.ok) throw new Error(canvas.error)
      await api.canvas.release(canvas.value.handleId)
      return { canvasId: canvas.value.objectId, documentId: doc.value.objectId }
    }, vault)
    await reveal(seeded.canvasId)
    // No form row (W4 MS1): the dock places a text card; right-click the stage for 新建 (文档卡…, 链接…).
    const stage = page.locator('[data-workbench-mode-panel="document"] .rn-canvas').first()
    await stage.getByRole('button', { name: '文字卡', exact: true }).click()
    await stage.getByRole('button', { name: '完成编辑', exact: true }).click()
    await stage.click({ button: 'right', position: { x: 160, y: 520 } })
    await stage.getByRole('menuitem', { name: '文档卡…', exact: true }).click()
    await stage.getByRole('menuitem', { name: '来源文档', exact: true }).click()
    await stage.click({ button: 'right', position: { x: 520, y: 520 } })
    await stage.getByRole('menuitem', { name: '链接…', exact: true }).click()
    await stage.getByLabel('链接网址').fill('https://example.com')
    await stage.getByRole('button', { name: '添加链接卡', exact: true }).click()
    const readCanvas = () => JSON.parse(fs.readFileSync(path.join(vault, 'X.canvas'), 'utf8'))
    await poll(() => readCanvas().nodes.length === 3, 'Three card types not persisted')
    await snapshot('01-three-card-types')
    const textId = readCanvas().nodes.find(node => node.type === 'text').id
    await page.locator(`[data-node-id="${textId}"]`).dblclick()
    const rich = page.getByLabel('文字卡编辑').locator('[contenteditable="true"]').first()
    await rich.fill('中文画板验收')
    await poll(() => readCanvas().nodes.find(node => node.id === textId).text.includes('中文画板验收'), 'Chinese input not persisted')
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await rich.press(`${mod}+z`)
    await poll(() => !readCanvas().nodes.find(node => node.id === textId).text.includes('中文画板验收'), 'Undo not persisted')
    await rich.fill('中文成文验收')
    await page.getByRole('button', { name: '完成编辑', exact: true }).click()
    await snapshot('02-chinese-undo')
    await page.locator(`[data-node-id="${textId}"]`).click()
    await page.locator(`[data-node-id="${textId}"]`).click({ button: 'right' })
    // M7: the selected cards go to the AI chat as a structured, read-only attachment.
    await page.getByRole('menuitem', { name: '问 AI', exact: true }).click()
    await page.locator('.chat-reference-chip').first().waitFor({ timeout: 15000 })
    await snapshot('02b-ask-ai')
    await page.locator(`[data-node-id="${textId}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '添加到文档', exact: true }).click()
    await poll(() => readCanvas().nodes.some(node => node.ready.kind === 'draft'), 'Draft card missing')
    await reveal(seeded.canvasId)
    await page.locator('[data-kind="draft"]').getByRole('button', { name: '保存到…', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '保存到…', exact: true })
    await picker.getByLabel('标题', { exact: true }).fill('成文')
    await picker.getByRole('button', { name: '确认', exact: true }).click()
    await poll(() => fs.existsSync(path.join(vault, 'X/成文.md')), 'Composition document missing')
    assert.match(fs.readFileSync(path.join(vault, 'X/成文.md'), 'utf8'), /中文成文验收/)
    await poll(() => readCanvas().nodes.filter(node => node.ready.kind === 'document').length === 2, 'Draft was not replaced by document card')
    await snapshot('03-composition-under-X')
    // W4 MS2: a note written as Markdown renders at rest; the file keeps the source.
    await stage.getByRole('button', { name: '便签', exact: true }).click()
    await page.getByLabel('文字卡编辑').locator('[contenteditable="true"]').first().fill('# 卡片标题')
    await stage.getByRole('button', { name: '完成编辑', exact: true }).click()
    await poll(() => readCanvas().nodes.some(node => node.ready.kind === 'note' && node.text.includes('# 卡片标题')), 'Note Markdown not persisted')
    await stage.locator('.canvas-card[data-kind="note"] .canvas-markdown h1', { hasText: '卡片标题' }).waitFor()
    // MS3: search marks the matching card.
    await stage.getByRole('button', { name: '在画板中搜索', exact: true }).click()
    await page.keyboard.type('卡片标题')
    await stage.locator('.canvas-card[data-matched="true"]').first().waitFor()
    assert.equal(await stage.locator('.canvas-card[data-matched="true"]').count(), 1)
    await page.keyboard.press('Escape')
    // MS3: a sub-board from 新建, entered by double-click, left by the breadcrumb.
    await stage.click({ button: 'right', position: { x: 820, y: 640 } })
    await stage.getByRole('menuitem', { name: '子画板', exact: true }).click()
    await poll(() => fs.existsSync(path.join(vault, 'X', '子画板.canvas')) && readCanvas().nodes.some(node => node.ready.kind === 'subcanvas'), 'Sub-board missing')
    await stage.locator('.canvas-card[data-kind="subcanvas"]').first().dblclick()
    const sub = page.locator('[data-workbench-mode-panel="document"] .rn-canvas[aria-label="子画板"]').first()
    await sub.waitFor()
    await sub.locator('.canvas-crumbs').getByRole('button', { name: 'X', exact: true }).click()
    await page.locator('[data-workbench-mode-panel="document"] .rn-canvas[aria-label="X"]').first().waitFor()
    // MS3: 导出 Markdown (Main's save dialog answered with a fixed path).
    const exportPath = path.join(temporary, 'X 导出.zip')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exportPath)
    await stage.getByRole('button', { name: '更多', exact: true }).click()
    await stage.getByRole('menuitem', { name: '导出为 Markdown', exact: true }).click()
    await poll(() => fs.existsSync(exportPath) && fs.statSync(exportPath).size > 0, 'Markdown export missing')
    await snapshot('03b-markdown-search-subboard-export')
    // Close the canvas with the close-document shortcut so the transfer happens while it is not open.
    const canvasOpen = () => page.evaluate(() => (JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs ?? []).some(tab => /\.canvas$/i.test(tab.path || '')))
    for (let i = 0; i < 10 && await canvasOpen(); i++) {
      await page.locator('[data-workbench-mode-panel="document"] .canvas-crumbs').first().click({ position: { x: 4, y: 4 } }).catch(() => {})
      await page.keyboard.press(`${mod}+w`); await page.waitForTimeout(400)
    }
    assert.equal(await canvasOpen(), false, 'The canvas tab is still open before the FastCard transfer')
    const receipt = await page.evaluate(async objectId => {
      const item = { id: crypto.randomUUID(), kind: 'text', text: '浏览器 FastCard 文字', createdAt: Date.now(), source: { pageUrl: 'https://example.com', pageTitle: 'Example' } }
      const added = await window.electronAPI.browser.addFastCardItem(item)
      if (!added.success) throw new Error(added.error)
      const saved = await window.electronAPI.fastCard.transfer({ operationId: crypto.randomUUID(), itemIds: [item.id], target: { kind: 'existing', objectId } })
      if (!saved.success) throw new Error(saved.error)
      const retained = await window.electronAPI.browser.addFastCardItem({ id: crypto.randomUUID(), kind: 'text', text: '重启后仍在暂存', createdAt: Date.now() })
      if (!retained.success) throw new Error(retained.error)
      return saved.data
    }, seeded.canvasId)
    assert.ok(readCanvas().nodes.some(node => receipt.nodeIds.includes(node.id)))
    await reveal(seeded.canvasId)
    await page.getByText('浏览器 FastCard 文字', { exact: true }).waitFor()
    await snapshot('04-transfer-closed-canvas')
    const before = fs.readFileSync(path.join(vault, 'X.canvas'))
    // Kill by pid and confirm the exit within a bound: a lost signal must fail this check, never hang it.
    const pid = app.process().pid, exited = once(app.process(), 'exit')
    process.kill(pid, 'SIGKILL')
    const outcome = await Promise.race([exited.then(() => 'exited'), new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))])
    if (outcome !== 'exited') { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* silent-catch: already gone */ } }
    assert.equal(outcome, 'exited', `Ready Next (pid ${pid}) did not exit after SIGKILL`)
    app = undefined
    await launch(); await reveal(seeded.canvasId)
    assert.deepEqual(fs.readFileSync(path.join(vault, 'X.canvas')), before)
    assert.match(fs.readFileSync(path.join(vault, 'X/成文.md'), 'utf8'), /中文成文验收/)
    const cards = await page.evaluate(() => window.electronAPI.browser.listFastCardItems())
    assert.ok(cards.success && cards.data.some(item => item.text === '重启后仍在暂存'))
    await snapshot('05-restart')
    const oldObject = await page.evaluate(file => window.electronAPI.objects.resolvePath(file), oldPath)
    await reveal(oldObject.objectId)
    await page.getByRole('button', { name: '转换为 .canvas', exact: true }).click()
    await poll(() => fs.existsSync(path.join(vault, '旧画板.canvas')), 'Import missing')
    assert.deepEqual(fs.readFileSync(oldPath), oldBytes)
    const imported = JSON.parse(fs.readFileSync(path.join(vault, '旧画板.canvas'), 'utf8'))
    assert.ok(imported.nodes.some(node => node.text === '旧画板原文'))
    await snapshot('06-import-source-unchanged')
    console.log(`PASS M4 window gate: ${evidence}`)
  } finally { if (app) await app.close(); console.log(`Evidence retained: ${temporary}`) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
