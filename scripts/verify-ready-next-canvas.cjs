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
  // Hidden window only, and everything the app may touch (HOME, TMPDIR, profile, vault) lives in the throwaway directory.
  const home = path.join(temporary, 'home'), scratch = path.join(temporary, 'tmp')
  fs.mkdirSync(home); fs.mkdirSync(scratch)
  const env = { ...process.env, READY_USER_DATA_DIR: profile, READY_START_HIDDEN: '1', HOME: home, TMPDIR: scratch }
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
    // The board's menus are the shared W1 menus (in the app's float host, not inside the board): 文档卡… continues
    // in a picker float at the same point.
    await page.getByRole('menuitem', { name: '文档卡…', exact: true }).click()
    await page.getByRole('menuitem', { name: '来源文档', exact: true }).click()
    // The card is written before the picker closes, and the board ignores right-clicks while a write is in flight.
    await page.locator('[data-float-id="canvas-new-document"]').waitFor({ state: 'detached', timeout: 15000 })
    await stage.click({ button: 'right', position: { x: 520, y: 520 } })
    await page.getByRole('menuitem', { name: '链接…', exact: true }).click()
    await page.getByLabel('链接网址').fill('https://example.com')
    await page.getByRole('button', { name: '添加链接卡', exact: true }).click()
    const readCanvas = () => JSON.parse(fs.readFileSync(path.join(vault, 'X.canvas'), 'utf8'))
    await poll(() => readCanvas().nodes.length === 3, 'Three card types not persisted')
    await snapshot('01-three-card-types')
    // Drawing and connectors (M4 §9): every one is an undo step, and a connector is picked, deleted and brought back.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const centre = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 } }
    const drag = async (from, to, more = {}) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down()
      for (let i = 1; i <= 8; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8); await page.waitForTimeout(16) }
      if (more.beforeUp) await more.beforeUp()
      await page.mouse.up()
    }
    const pickShape = async name => { await stage.getByRole('button', { name: '图形', exact: true }).click(); await page.locator('[data-float-id="canvas-shapes-menu"] [role^="menuitem"]').filter({ hasText: name }).first().click() }
    const selectTool = () => stage.getByRole('button', { name: '选择', exact: true }).getAttribute('aria-pressed')
    const noStop = async () => assert.equal(await stage.locator('.canvas-message[role="alert"]').count(), 0, 'the board reported an outside update')
    const board = await stage.boundingBox()
    await pickShape('矩形')
    await drag({ x: board.x + board.width * 0.62, y: board.y + board.height * 0.22 }, { x: board.x + board.width * 0.62 + 140, y: board.y + board.height * 0.22 + 90 })
    await poll(() => readCanvas().nodes.some(node => node.ready.kind === 'graphic'), 'Rectangle not persisted')
    await poll(async () => await selectTool() === 'true', 'The select tool did not come back after one rectangle')
    await noStop()
    await page.keyboard.press(`${mod}+z`)
    await poll(() => !readCanvas().nodes.some(node => node.ready.kind === 'graphic'), 'Undo did not remove the rectangle')
    await noStop()
    console.log('PASS draw rectangle → undo → gone')
    const cardOf = kind => stage.locator(`.canvas-card[data-node-id="${readCanvas().nodes.find(node => node.ready.kind === kind).id}"]`)
    await pickShape('连线')
    await drag(await centre(cardOf('document')), await centre(cardOf('link')))
    await poll(() => readCanvas().edges.length === 1, 'Connector not persisted')
    await poll(async () => await selectTool() === 'true', 'The select tool did not come back after one connector')
    const edgeId = readCanvas().edges[0].id, line = stage.locator(`[data-edge-id="${edgeId}"] .canvas-edge-line`)
    // The connector follows a moved card (⇧: no snapping) and is still there afterwards.
    const linkBefore = readCanvas().nodes.find(node => node.ready.kind === 'link'), linkAt = await centre(cardOf('link'))
    await page.keyboard.down('Shift'); await drag(linkAt, { x: linkAt.x + 60, y: linkAt.y + 50 }); await page.keyboard.up('Shift')
    await poll(() => readCanvas().nodes.find(node => node.id === linkBefore.id).y > linkBefore.y + 20, 'Card move not persisted')
    assert.equal(readCanvas().edges[0].id, edgeId); await line.waitFor()
    console.log('PASS connector survives a card move')
    await stage.click({ position: { x: 20, y: board.height - 20 } })
    // A point on the connector that is not under a card (cards sit above the lines).
    const middle = await line.evaluate(path => {
      const length = path.getTotalLength(), matrix = path.getScreenCTM()
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const at = path.getPointAtLength(length * t).matrixTransform(matrix)
        if (document.elementFromPoint(at.x, at.y)?.closest('[data-edge-id]')) return { x: at.x, y: at.y }
      }
      return null
    })
    assert.ok(middle, 'No free point on the connector')
    await page.mouse.click(middle.x, middle.y)
    await stage.locator(`[data-edge-id="${edgeId}"][data-selected]`).waitFor()
    await snapshot('01b-connector-selected')
    await page.keyboard.press('Delete')
    await poll(() => readCanvas().edges.length === 0, 'Delete did not remove the connector')
    await page.keyboard.press(`${mod}+z`)
    await poll(() => readCanvas().edges.length === 1 && readCanvas().edges[0].id === edgeId, 'Undo did not bring the connector back')
    // The dock's buttons do the same.
    await stage.getByRole('button', { name: '重做', exact: true }).click()
    await poll(() => readCanvas().edges.length === 0, 'Redo button did not remove the connector again')
    await stage.getByRole('button', { name: '撤销', exact: true }).click()
    await poll(() => readCanvas().edges.length === 1, 'Undo button did not bring the connector back')
    // Right-click offers 删除连线; that too is one step back.
    // The board ignores right-clicks while a write is in flight: wait for the undo to land in the window too.
    await line.waitFor(); await poll(async () => await stage.locator('.canvas-message[role="status"]').count() === 0, 'The board stayed busy')
    await page.mouse.click(middle.x, middle.y, { button: 'right' })
    await page.locator('[data-float-id="canvas-context-menu"] [role="menuitem"]').filter({ hasText: '删除连线' }).click()
    await poll(() => readCanvas().edges.length === 0, '删除连线 did not remove the connector')
    await page.keyboard.press(`${mod}+z`)
    await poll(() => readCanvas().edges.length === 1, 'Undo after 删除连线 failed')
    await noStop()
    console.log('PASS draw connector → select → Delete → undo → back (keyboard, dock buttons, right-click)')
    // Alignment and adaptive scaling (M4 §9.2), at 100% zoom so screen distances are world distances.
    const nodeOf = kind => readCanvas().nodes.find(node => node.ready.kind === kind)
    const idle = async () => { await poll(async () => await stage.locator('.canvas-message[role="status"]').count() === 0, 'The board stayed busy'); await page.waitForTimeout(150) }
    const dragCardTo = async (kind, x, y, beforeUp) => {
      const from = await centre(cardOf(kind)), node = nodeOf(kind)
      await drag(from, { x: from.x + x - node.x, y: from.y + y - node.y }, { beforeUp })
    }
    const undoTo = async (check, message) => { await idle(); await stage.focus(); await page.keyboard.press(`${mod}+z`); await poll(check, message); await idle() }
    await stage.click({ position: { x: 20, y: board.height - 20 } })
    const plain = nodeOf('text'), anchor = nodeOf('link')
    // Left edges 6px apart, far above the link card: the card snaps into line and a guide shows while dragging.
    await dragCardTo('text', anchor.x + 6, anchor.y - plain.height - 120, async () => {
      assert.ok(await stage.locator('.canvas-overlay .canvas-guide').count() >= 1, 'No alignment guide while dragging'); await snapshot('01c-snap-guide')
    })
    await poll(() => nodeOf('text').x === anchor.x, 'The card did not snap into line')
    console.log('PASS magnetic snap + smart guide')
    await undoTo(() => nodeOf('text').x === plain.x && nodeOf('text').y === plain.y, 'Undo did not put the card back')
    // 20px short of the link card's right edge, overlapping it: the dock mark shows; on release the card sits one
    // gap (12) away, takes the link card's height and its text scales with it. One undo takes all of it back.
    await dragCardTo('text', anchor.x + anchor.width + 20, anchor.y + 30, async () => {
      assert.equal(await stage.locator('.canvas-overlay .canvas-dock-mark').count(), 1, 'No dock mark while dragging'); await snapshot('01d-dock-marker')
    })
    await poll(() => { const n = nodeOf('text'); return n.x === anchor.x + anchor.width + 12 && n.y === anchor.y && n.height === anchor.height }, 'The card did not dock and scale')
    const docked = nodeOf('text'), k = anchor.height / plain.height
    assert.equal(docked.width, Math.round(plain.width * k)); assert.ok(Math.abs(docked.ready.appearance.fontScale - 13 / 24 * k) < 0.001)
    for (const value of [docked.x, docked.y, docked.width, docked.height]) assert.ok(Number.isInteger(value))
    await idle(); await snapshot('01e-dock-landed')
    console.log('PASS adaptive dock: one gap away, scaled to the neighbour, text scaled')
    await undoTo(() => { const n = nodeOf('text'); return n.x === plain.x && n.width === plain.width && !n.ready.appearance }, 'Undo did not take the docking back')
    // A multi-selection: one hull, whose corner arc scales every card in proportion as one undo step.
    await stage.focus(); await page.keyboard.press(`${mod}+a`)
    await stage.locator('.canvas-hull path').waitFor(); await snapshot('01f-selection-hull')
    const sizes = () => readCanvas().nodes.map(node => `${node.width}x${node.height}`).join()
    const beforeScale = sizes(), arc = await centre(stage.locator('.canvas-hull-handles [data-resize="nw"]'))
    // The top-left arc is the one in view here (the lower cards run past the stage's edge); pulling it outward grows the selection.
    await drag(arc, { x: arc.x - 70, y: arc.y - 50 })
    await poll(() => readCanvas().nodes.every((node, i) => node.width > Number(beforeScale.split(',')[i].split('x')[0])), 'The selection did not scale')
    console.log('PASS selection hull scales the group')
    await undoTo(() => sizes() === beforeScale, 'Undo did not take the group scale back')
    await stage.click({ position: { x: 20, y: board.height - 20 } })
    // 视图设置: a popover, kept in this profile only; the board file never carries it.
    await stage.getByRole('button', { name: '视图设置', exact: true }).click()
    const snapSwitch = page.locator('[data-float-id="canvas-view-settings"] [role="switch"][aria-label="磁吸"]')
    await snapSwitch.waitFor(); await snapshot('01g-view-settings')
    await snapSwitch.click()
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ready-next.canvas.view')).magneticSnap), false)
    await dragCardTo('text', anchor.x + 6, anchor.y - plain.height - 120)
    await poll(() => nodeOf('text').x === anchor.x + 6, 'With 磁吸 off the card should stay where it was dropped')
    await undoTo(() => nodeOf('text').x === plain.x, 'Undo did not put the card back')
    await stage.getByRole('button', { name: '视图设置', exact: true }).click()
    await snapSwitch.click(); await page.keyboard.press('Escape')
    assert.ok(!fs.readFileSync(path.join(vault, 'X.canvas'), 'utf8').includes('magneticSnap'), 'A view preference leaked into the board file')
    await stage.click({ position: { x: 20, y: board.height - 20 } })
    console.log('PASS view settings are local and switch snapping off')
    const textId = readCanvas().nodes.find(node => node.type === 'text').id
    await page.locator(`[data-node-id="${textId}"]`).dblclick()
    const rich = page.getByLabel('文字卡编辑').locator('[contenteditable="true"]').first()
    // Wait for the editor explicitly, so a failure names this step instead of a generic fill timeout.
    await poll(async () => await rich.count() > 0, 'Text card editor did not open')
    await rich.fill('中文画板验收')
    await poll(() => readCanvas().nodes.find(node => node.id === textId).text.includes('中文画板验收'), 'Chinese input not persisted')
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
    const noteEditor = page.getByLabel('文字卡编辑').locator('[contenteditable="true"]').first()
    await poll(async () => await noteEditor.count() > 0, 'Note editor did not open')
    // Typed as a person would: "# " turns the paragraph into a heading (filling the text at once stores a literal "\#").
    await noteEditor.click(); await page.keyboard.type('# '); await page.keyboard.insertText('卡片标题')
    await stage.getByRole('button', { name: '完成编辑', exact: true }).click()
    await poll(() => readCanvas().nodes.some(node => node.ready.kind === 'note' && node.text.startsWith('# 卡片标题')), 'Note Markdown not persisted')
    await stage.locator('.canvas-card[data-kind="note"] .canvas-markdown h1', { hasText: '卡片标题' }).waitFor()
    // MS3: search marks the matching card.
    await stage.getByRole('button', { name: '在画板中搜索', exact: true }).click()
    await page.keyboard.type('卡片标题')
    await stage.locator('.canvas-card[data-matched="true"]').first().waitFor()
    assert.equal(await stage.locator('.canvas-card[data-matched="true"]').count(), 1)
    await page.keyboard.press('Escape')
    // A context menu opened near the board's corner stays inside the board (it flips up and left).
    const stageBox = await stage.boundingBox()
    await stage.click({ button: 'right', position: { x: Math.round(stageBox.width - 24), y: Math.round(stageBox.height - 24) } })
    const items = page.locator('[data-float-id="canvas-context-menu"]').getByRole('menuitem')
    await items.first().waitFor()
    for (const box of await items.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } }))) {
      assert.ok(box.x >= stageBox.x && box.y >= stageBox.y && box.right <= stageBox.x + stageBox.width && box.bottom <= stageBox.y + stageBox.height, `menu item outside the board: ${JSON.stringify(box)}`)
    }
    await page.keyboard.press('Escape')
    // MS3: a sub-board from 新建, entered by double-click, left by the breadcrumb.
    // An empty spot above the cards, relative to the board (the assistant panel may narrow the board).
    await stage.click({ button: 'right', position: { x: Math.round(stageBox.width * 0.4), y: Math.round(stageBox.height * 0.2) } })
    await page.getByRole('menuitem', { name: '子画板', exact: true }).click()
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
    await page.getByRole('menuitem', { name: '导出为 Markdown', exact: true }).click()
    await poll(() => fs.existsSync(exportPath) && fs.statSync(exportPath).size > 0, 'Markdown export missing')
    await snapshot('03b-markdown-search-subboard-export')
    // MS3: 导出 PNG — Main captures this window's stage and writes a real PNG.
    const pngPath = path.join(temporary, 'X 导出.png')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, pngPath)
    await stage.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '导出为 PNG', exact: true }).click()
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await poll(() => fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000 && fs.readFileSync(pngPath).subarray(0, 8).equals(PNG_SIGNATURE), 'PNG export missing')
    // M4 §9: sub-boards as folders. Every pointer action goes to a point where the card is really on top.
    const boardStage = name => page.locator(`[data-workbench-mode-panel="document"] .rn-canvas[aria-label="${name}"]`).first()
    const readChild = name => JSON.parse(fs.readFileSync(path.join(vault, 'X', `${name}.canvas`), 'utf8'))
    const fitBoard = async name => { await boardStage(name).getByRole('button', { name: '适应内容', exact: true }).click(); await page.waitForTimeout(250) }
    const pointOn = async (id, ignore = []) => {
      let point = null
      await poll(async () => {
        point = await page.evaluate(({ id, ignore }) => {
          const element = document.querySelector(`[data-workbench-mode-panel="document"] [data-node-id="${id}"]`)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
            const x = rect.left + rect.width * i / 10, y = rect.top + rect.height * j / 10
            const top = document.elementsFromPoint(x, y).find(hit => hit.closest('[data-canvas-ui]') || (hit.closest('[data-node-id]') && !ignore.includes(hit.closest('[data-node-id]').dataset.nodeId)))
            if (top && !top.closest('[data-canvas-ui]') && top.closest('[data-node-id]').dataset.nodeId === id) return { x, y }
          }
          return null
        }, { id, ignore })
        return Boolean(point)
      }, `card ${id} cannot be reached`)
      return point
    }
    const documentIds = readCanvas().nodes.filter(node => node.ready.kind === 'document' && !node.ready.trash).map(node => node.id)
    assert.equal(documentIds.length, 2)
    // Selection → 收进子画板: one new sub-board card where the two cards were; the cards are in the child file.
    await fitBoard('X')
    const first = await pointOn(documentIds[0]); await page.mouse.click(first.x, first.y)
    const second = await pointOn(documentIds[1]); await page.keyboard.down('Shift'); await page.mouse.click(second.x, second.y); await page.keyboard.up('Shift')
    await page.mouse.click(second.x, second.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '收进子画板', exact: true }).click()
    await poll(() => fs.existsSync(path.join(vault, 'X', '子画板 2.canvas')) && !readCanvas().nodes.some(node => documentIds.includes(node.id)), '收进子画板 did not move the cards')
    assert.deepEqual(readChild('子画板 2').nodes.map(node => node.id).sort(), [...documentIds].sort())
    const folderCard = readCanvas().nodes.find(node => node.ready.kind === 'subcanvas' && node.file === 'X/子画板 2.canvas')
    assert.ok(folderCard, 'The new sub-board has no card on its parent')
    await boardStage('X').locator(`[data-node-id="${folderCard.id}"] .canvas-subboard__count`, { hasText: '2 张卡片' }).waitFor()
    await page.getByText(/已把 2 张卡片收进「子画板 2」/).waitFor()
    await snapshot('07-collected-into-sub-board')
    // Enter opens the selected sub-board card; 移出到上一级 takes one card back to X and follows it there.
    await fitBoard('X')
    const folderPoint = await pointOn(folderCard.id); await page.mouse.click(folderPoint.x, folderPoint.y)
    await page.keyboard.press('Enter')
    await boardStage('子画板 2').waitFor()
    await fitBoard('子画板 2')
    const inside = await pointOn(documentIds[0]); await page.mouse.click(inside.x, inside.y); await page.mouse.click(inside.x, inside.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '移出到上一级', exact: true }).click()
    await poll(() => readCanvas().nodes.some(node => node.id === documentIds[0]) && readChild('子画板 2').nodes.length === 1, '移出到上一级 did not move the card')
    await boardStage('X').waitFor()
    await page.getByText(/已把 1 张卡片移出到「X」/).waitFor()
    await snapshot('08-moved-out-to-parent')
    // ⌘Z on the parent (its own history is empty after the move): the card goes back into the sub-board, no copy stays.
    await boardStage('X').focus()
    await page.keyboard.press(`${mod}+z`)
    await poll(() => !readCanvas().nodes.some(node => node.id === documentIds[0]) && readChild('子画板 2').nodes.length === 2, 'Undo did not return the card to the sub-board')
    await snapshot('08b-move-out-undone')
    // ⌥↑ goes from a sub-board to its parent.
    await fitBoard('X')
    const again = await pointOn(folderCard.id); await page.mouse.dblclick(again.x, again.y)
    await boardStage('子画板 2').waitFor(); await boardStage('子画板 2').focus()
    await page.keyboard.press('Alt+ArrowUp')
    await boardStage('X').waitFor()
    // Drag a card onto the sub-board card: it moves in.
    await fitBoard('X')
    const linkId = readCanvas().nodes.find(node => node.type === 'link' && !node.ready.trash).id
    const from = await pointOn(linkId), to = await pointOn(folderCard.id, [linkId])
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 }); await page.mouse.move(to.x, to.y, { steps: 8 })
    await boardStage('X').locator(`[data-node-id="${folderCard.id}"][data-drop-target]`).waitFor()
    await page.screenshot({ path: path.join(evidence, '09a-drag-over-sub-board.png') })
    await page.mouse.up()
    await poll(() => !readCanvas().nodes.some(node => node.id === linkId) && readChild('子画板 2').nodes.some(node => node.id === linkId), 'The dragged card did not move into the sub-board')
    await boardStage('X').locator(`[data-node-id="${folderCard.id}"] .canvas-subboard__count`, { hasText: '3 张卡片' }).waitFor()
    await snapshot('09-dragged-into-sub-board')
    // Delete the sub-board card: its file leaves with it (library bin) and comes back with it, content intact.
    await fitBoard('X')
    const doomed = await pointOn(folderCard.id); await page.mouse.click(doomed.x, doomed.y)
    await page.keyboard.press('Delete')
    await poll(() => readCanvas().nodes.find(node => node.id === folderCard.id)?.ready.trash && !fs.existsSync(path.join(vault, 'X', '子画板 2.canvas')), 'The sub-board file did not leave with its card')
    await boardStage('X').getByRole('button', { name: '回收站', exact: true }).click()
    await page.screenshot({ path: path.join(evidence, '10a-sub-board-in-bin.png') })
    await boardStage('X').getByRole('button', { name: `恢复 ${folderCard.id}`, exact: true }).click()
    await poll(() => !readCanvas().nodes.find(node => node.id === folderCard.id)?.ready.trash && fs.existsSync(path.join(vault, 'X', '子画板 2.canvas')), 'The sub-board file did not come back with its card')
    assert.equal(readChild('子画板 2').nodes.length, 3)
    await boardStage('X').getByRole('button', { name: '回收站', exact: true }).click()
    await snapshot('10-sub-board-deleted-and-restored')
    // 导入 Stillroom 空间 (Main's open dialog answered with a fixed file): the space arrives as a sub-board of X.
    const JSZip = require('jszip')
    const note = { id: 'folder', type: 'folder', title: 'Folder', text: '', createdAt: 1, updatedAt: 1, canvasX: 0, canvasY: 0, parentId: null, deletedAt: null, metadata: {} }
    const space = new JSZip(); space.file('space.json', JSON.stringify({ app: 'stillroom', version: 1, notes: [note, { ...note, id: 'text', type: 'text', text: '<p>来自 Stillroom</p>', parentId: null, canvasX: 400 },
      ...['one', 'two', 'three'].map((key, index) => ({ ...note, id: key, type: 'image', mediaUrl: `idb:${key}`, canvasX: 800 + index * 300, metadata: { originalFilename: `${key}.png` } }))] }))
    // Three pictures of different tones, so the sub-board card has thumbnails to show.
    for (const [index, key] of ['one', 'two', 'three'].entries()) space.file(`media/${key}`, await app.evaluate(({ nativeImage }, tone) => {
      const size = 96, pixels = Buffer.alloc(size * size * 4)
      for (let i = 0; i < size * size; i++) { const shade = 70 + tone * 60 + Math.round((i % size) / size * 40); pixels[i * 4] = shade; pixels[i * 4 + 1] = shade; pixels[i * 4 + 2] = shade + 8; pixels[i * 4 + 3] = 255 }
      return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG().toString('base64')
    }, index), { base64: true })
    const spacePath = path.join(temporary, '我的空间.zip'); fs.writeFileSync(spacePath, await space.generateAsync({ type: 'nodebuffer' }))
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, spacePath)
    await boardStage('X').getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '导入 Stillroom 空间…', exact: true }).click()
    await poll(() => fs.existsSync(path.join(vault, 'X', '我的空间.canvas')) && readCanvas().nodes.some(node => node.ready.kind === 'subcanvas' && node.file === 'X/我的空间.canvas'), 'The Stillroom space was not imported as a sub-board')
    assert.ok(readChild('我的空间').nodes.some(node => node.type === 'text' && node.text.includes('来自 Stillroom')))
    await page.getByText(/已导入 Stillroom 空间「我的空间」/).waitFor()
    await poll(async () => await boardStage('X').locator('.canvas-subboard__thumbs img').count() === 3, 'The imported sub-board card shows no thumbnails')
    await boardStage('X').locator('.canvas-subboard__count', { hasText: '5 张卡片' }).waitFor()
    await boardStage('X').locator('.canvas-card[data-kind="subcanvas"][data-selected="true"] .canvas-subboard__thumbs').waitFor()
    await snapshot('11-stillroom-import')
    await fitBoard('X')
    // MS3: 永久删除 takes a recycled card out of the file; 清空 asks once more in place, then empties the bin.
    const purgeCard = async (kind) => {
      const id = readCanvas().nodes.find(node => node.ready.kind === kind && !node.ready.trash).id
      // A point where the card is on top: the selection bar of the card chosen before may float over its middle.
      const spot = await pointOn(id); await page.mouse.click(spot.x, spot.y)
      await page.keyboard.press('Delete')
      await poll(() => readCanvas().nodes.find(node => node.id === id)?.ready.trash, `${kind} card was not recycled`)
      return id
    }
    const noteId = await purgeCard('note')
    await stage.getByRole('button', { name: '回收站', exact: true }).click()
    await stage.getByRole('button', { name: `永久删除 ${noteId}`, exact: true }).click()
    await poll(() => !readCanvas().nodes.some(node => node.id === noteId), 'Purged card is still in the file')
    await stage.getByRole('button', { name: '回收站', exact: true }).click()
    const binTextId = await purgeCard('text')
    await stage.getByRole('button', { name: '回收站', exact: true }).click()
    await stage.getByRole('button', { name: '清空', exact: true }).click()
    await stage.getByRole('button', { name: '确认清空', exact: true }).click()
    await poll(() => !readCanvas().nodes.some(node => node.id === binTextId || node.ready.trash), 'The bin was not emptied')
    await stage.getByRole('button', { name: '回收站', exact: true }).click()
    // Close the canvas with the close-document shortcut so the transfer happens while it is not open.
    const canvasOpen = () => page.evaluate(() => (JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs ?? []).some(tab => /\.canvas$/i.test(tab.path || '')))
    for (let i = 0; i < 10 && await canvasOpen(); i++) {
      await page.locator('[data-workbench-mode-panel="document"] [data-canvas-surface]').first().focus().catch(() => {})
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
