// Build first. Claude runs this gate with a real Electron window and an isolated profile/vault.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { _electron } = require('playwright')

async function main() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-timeline-')))
  const vault = path.join(temporary, 'vault'), profile = path.join(temporary, 'profile')
  fs.mkdirSync(vault)
  // Verification never puts a window in front of the person.
  const env = { ...process.env, READY_START_HIDDEN: '1', READY_USER_DATA_DIR: profile, READY_DB_PATH: path.join(profile, 'ready.db') }; delete env.ELECTRON_RUN_AS_NODE
  let app, page
  const poll = async (check, label) => {
    const deadline = Date.now() + 30000
    while (!await check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const mode = async value => page.evaluate(mode => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode, placement: 'open', presentation: 'immediate' } })), value)
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env })
    await poll(() => { page = app.windows().find(p => p.url().includes('/renderer/index.html')); return !!page }, 'Renderer missing')
    await poll(() => page.evaluate(() => !!window.electronAPI?.calendarLinkage), 'Timeline preload missing')
  }
  const reveal = async id => {
    await mode('document')
    const result = await page.evaluate(async ({ id, vault }) => {
      const tree = await window.electronAPI.documentPages.tree({ path: vault, kind: 'vault' })
      if (!tree.ok) throw new Error(tree.message)
      return tree.value.children.find(node => node.objectId === id)
    }, { id, vault })
    assert.ok(result)
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app').isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    await page.getByLabel('页面侧栏', { exact: true }).locator(`[data-page-id="${id}"]`).locator(':scope > .ink-sb-row > .ink-sb-label-btn').click()
  }
  const shot = async name => { await page.screenshot({ path: path.join(temporary, `${name}.png`) }); console.log(`PASS ${name}`) }
  try {
    await launch()
    await page.evaluate(async root => { const state = await window.electronAPI.vault.set(root); if (state.status !== 'ready') throw new Error('Vault not ready') }, vault)
    const seeded = await page.evaluate(async root => {
      const api = window.electronAPI, date = new Date().toISOString().slice(0, 10), start = Date.parse(`${date}T09:00:00Z`)
      const page = await api.documentPages.operate({ type: 'create', root, parentPath: root, title: '联动文档', content: '# 联动\n\n保留原文', operationId: crypto.randomUUID() })
      if (!page.ok) throw new Error(page.message)
      const canvas = await api.canvas.create({ path: '联动画板.canvas', operationId: crypto.randomUUID(), canvas: { ready: { id: crypto.randomUUID(), schemaVersion: 1, title: '联动画板' }, nodes: [], edges: [] } })
      if (!canvas.ok) throw new Error(canvas.error)
      await api.canvas.release(canvas.value.handleId)
      const calendar = await api.calendar.putCalendar({ id: 'timeline', accountId: 'local', name: '联动测试', color: '#4488CC', visible: true, primary: true })
      if (!calendar.success) throw new Error(calendar.error)
      const prefs = await api.calendar.putPreferences({ primaryTimeZone: 'UTC', gridView: 'default', daysPerPeriod: 1, contextPanel: true })
      if (!prefs.success) throw new Error(prefs.error)
      const result = await api.calendar.mutate({ type: 'create', event: { id: 'timeline-event', uid: 'timeline@local', calendarId: 'timeline', title: '拖出测试事件', location: '会议室 A', start, end: start + 3600000, allDay: false, status: 'confirmed', transparency: 'opaque', createdAt: start, updatedAt: start } }, {})
      if (!result.success) throw new Error(result.error)
      return { documentId: page.value.objectId, canvasId: canvas.value.objectId, date }
    }, vault)
    await mode('calendar')
    await page.evaluate(() => window.electronAPI.calendar.revealEvent('timeline-event'))
    const drag = await page.evaluateHandle(() => new DataTransfer())
    await page.getByRole('button', { name: '拖出日程', exact: true }).dispatchEvent('dragstart', { dataTransfer: drag })
    await reveal(seeded.documentId)
    await page.locator('[data-ready-block-editor]').dispatchEvent('drop', { dataTransfer: drag })
    await poll(() => page.locator('[data-ready-block-editor] a[href="ready://calendar/event/timeline-event"]').count().then(n => n === 1), 'Event capsule missing')
    await page.locator('[data-ready-block-editor] [contenteditable="true"]').first().press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    assert.equal(await page.locator('[data-ready-block-editor] a[href="ready://calendar/event/timeline-event"]').count(), 0)
    await page.locator('[data-ready-block-editor]').dispatchEvent('drop', { dataTransfer: drag })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await poll(() => fs.readFileSync(path.join(vault, '联动文档.md'), 'utf8').includes('ready://calendar/event/timeline-event'), 'Document not persisted')
    await shot('01-event-document-one-undo')
    await reveal(seeded.canvasId)
    await page.locator('[data-canvas-surface]').dispatchEvent('drop', { dataTransfer: drag, clientX: 350, clientY: 300 })
    const readCanvas = () => JSON.parse(fs.readFileSync(path.join(vault, '联动画板.canvas'), 'utf8'))
    await poll(() => readCanvas().nodes.some(n => n.ready.ref?.kind === 'event'), 'Event card not saved')
    await page.getByLabel('事件卡', { exact: true }).getByText('会议室 A').waitFor()
    await page.evaluate(async () => {
      const api = window.electronAPI.calendar, snapshot = await api.snapshot()
      const result = await api.mutate({ type: 'update', key: 'timeline-event', patch: { title: '实时更新事件', location: '会议室 B' } }, { 'timeline-event': snapshot.data.events.find(e => e.id === 'timeline-event').revision })
      if (!result.success) throw new Error(result.error)
    })
    await page.getByLabel('事件卡', { exact: true }).getByText('会议室 B').waitFor()
    await shot('02-event-canvas-live')
    // The board's dock places a text card that opens ready to type (W4 MS1); it is named by its text.
    const stage = page.locator('[data-workbench-mode-panel="document"] .rn-canvas').first()
    await stage.getByRole('button', { name: '文字卡', exact: true }).click()
    const cardEditor = page.getByLabel('文字卡编辑').locator('[contenteditable="true"]').first()
    await poll(async () => await cardEditor.count() > 0, 'Text card editor did not open')
    await cardEditor.click(); await page.keyboard.insertText('新文字卡')
    await stage.getByRole('button', { name: '完成编辑', exact: true }).click()
    await poll(() => readCanvas().nodes.some(n => n.type === 'text' && n.text.includes('新文字卡')), 'Text card missing')
    const textId = readCanvas().nodes.find(n => n.type === 'text').id
    await page.locator(`[data-node-id="${textId}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '安排日程…', exact: true }).click()
    await page.getByLabel('日程开始', { exact: true }).fill(`${seeded.date}T14:00`)
    await page.getByLabel('日程结束', { exact: true }).fill(`${seeded.date}T15:00`)
    await page.getByRole('button', { name: '创建日程', exact: true }).click()
    await page.locator('.canvas-schedule-mark a[data-ready-ref-capsule][data-ref-kind="event"]').first().waitFor()
    const related = await page.evaluate(() => window.electronAPI.calendar.snapshot())
    assert.ok(related.data.links.some(link => link.target.kind === 'canvas' && link.target.node === textId))
    await shot('03-card-schedule')
    await mode('calendar'); await page.evaluate(date => window.electronAPI.calendar.revealDay(date), seeded.date)
    await page.getByRole('region', { name: '这一天', exact: true }).waitFor()
    await page.locator('[data-day-item="activity"]').filter({ hasText: '联动画板.canvas' }).waitFor()
    await shot('04-this-day')
    const before = fs.readFileSync(path.join(vault, '联动画板.canvas')), docBefore = fs.readFileSync(path.join(vault, '联动文档.md'))
    const exit = once(app.process(), 'exit'); app.process().kill('SIGKILL'); await exit; app = undefined
    await launch(); await reveal(seeded.canvasId)
    assert.deepEqual(fs.readFileSync(path.join(vault, '联动画板.canvas')), before)
    assert.deepEqual(fs.readFileSync(path.join(vault, '联动文档.md')), docBefore)
    await page.getByLabel('事件卡', { exact: true }).getByText('会议室 B').waitFor()
    await page.locator('.canvas-schedule-mark a[data-ready-ref-capsule][data-ref-kind="event"]').first().waitFor()
    const summary = await page.evaluate(date => window.electronAPI.calendarLinkage.day({ date, timeZone: 'UTC' }), seeded.date)
    assert.ok(summary.items.some(item => item.kind === 'events' && item.title === '新文字卡'))
    await shot('05-restart-readback')
    console.log(`Evidence: ${temporary}`)
  } finally { if (app) await app.close(); console.log(`Retained isolated fixture: ${temporary}`) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
