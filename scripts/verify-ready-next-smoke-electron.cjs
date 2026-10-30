// Build first (electron-vite build). Real-Electron smoke for the ready-next branch.
// Every launch uses a throwaway profile or a fake HOME; the daily Ready data is never opened.
const { _electron } = require('playwright')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` — ${detail}`}`)
  if (!pass) process.exitCode = 1
}

function step(label) {
  console.log(`… ${label}`)
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
  ])
}

function electronEnv(extra) {
  const env = { ...process.env, READY_START_HIDDEN: '1', ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(profile) {
  step('launch Electron')
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [process.cwd()],
    env: electronEnv({ READY_USER_DATA_DIR: profile }),
    timeout: 45000,
  })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const page = app.windows().find(w => w.url().includes('/renderer/index.html'))
    if (page) { step(`renderer ready: ${page.url()}`); return { app, page } }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  await app.close()
  throw new Error('Ready Next renderer did not start')
}

// The workbench listens for mode requests only after it mounts; repeat the request until the scene is current.
async function requestMode(page, mode) {
  const scene = page.locator(`[data-workbench-mode-panel="${mode}"][data-mode-visual-state="current"]`)
  const deadline = Date.now() + 30000
  while (!(await scene.count())) {
    if (Date.now() > deadline) throw new Error(`${mode} mode did not become current`)
    await page.evaluate(mode => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode, placement: 'open', presentation: 'immediate' } })), mode)
    await page.waitForTimeout(400)
  }
}

// C8: use the actual layer controls, external write and HTML drag, then read the authoritative file.
async function checkCalendarLayers(page, root) {
  const source = path.join(root, 'c8-layer.md')
  fs.writeFileSync(source, '---\ndate: 2026-10-30\n---\nC8 layer smoke\n')
  const indexed = await page.evaluate(root => window.electronAPI.document.reindexWorkspace(root), root)
  if (!indexed.success) throw new Error(JSON.stringify(indexed))
  await requestMode(page, 'calendar')
  await page.evaluate(async () => {
    const prefs = await window.electronAPI.calendar.putPreferences({ gridView: 'default', daysPerPeriod: 4, showWeekends: true, sidebar: true,
      layers: { events: true, documents: true, tasks: true, footprints: true } })
    if (!prefs.success) throw new Error(prefs.error)
    const day = await window.electronAPI.calendar.revealDay('2026-10-30')
    if (!day.success) throw new Error(day.error)
  })
  await page.getByRole('checkbox', { name: '文档日期', exact: true }).check()
  const id = await page.evaluate(source => window.electronAPI.objects.resolvePath(source), source)
  const chip = page.locator(`[data-layer-entry="page:${id.objectId}"]`).first()
  await chip.waitFor({ state: 'visible', timeout: 10000 })
  fs.writeFileSync(source, '---\ndate: 2026-10-31\n---\nC8 layer smoke\n')
  const began = performance.now()
  await page.locator('[data-layer-day="2026-10-31"] [data-layer="documents"]').filter({ hasText: 'c8-layer' }).waitFor({ state: 'visible', timeout: 1000 })
  const elapsed = performance.now() - began
  ok('C8 external file date renders within one second', elapsed < 1000, `${elapsed.toFixed(1)}ms`)
  console.log(`C8 window latency ${elapsed.toFixed(1)}ms`)
  // The event panel left open by the M6 link checks covers part of the grid (the drop day included); close it
  // first, as a person would, so the drag lands on the visible day.
  for (let i = 0; i < 5 && await page.locator('.ev-sec').first().isVisible().catch(() => false); i++) {
    await page.getByTestId('ready-calendar').focus()
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  }
  ok('C8 the event panel is closed before dragging', !await page.locator('.ev-sec').first().isVisible().catch(() => false))
  await page.evaluate(() => {
    window.__layerDrag = []
    for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : null
      window.__layerDrag.push(`${type}@${target?.closest('[data-layer-day]')?.getAttribute('data-layer-day') ?? target?.tagName}:${event.dataTransfer?.dropEffect ?? ''}`)
    }, true)
  })
  const dropDay = page.locator('[data-layer-day="2026-11-01"]').first()
  const geometry = await page.evaluate(({ source, target }) => {
    const at = (box) => { const el = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return `${el?.tagName}.${String(el?.className || '').slice(0, 30)}@${el?.closest('[data-layer-day]')?.getAttribute('data-layer-day')}:${el?.getAttribute('data-layer-entry') ?? ''}` }
    const chip = document.querySelector(source), day = document.querySelector(target)
    const a = chip?.getBoundingClientRect(), b = day?.getBoundingClientRect()
    return { chip: a && [Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height), at(a)], day: b && [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height), at(b)], viewport: [innerWidth, innerHeight] }
  }, { source: `[data-layer-entry="page:${id.objectId}"]`, target: '[data-layer-day="2026-11-01"]' })
  await chip.dragTo(dropDay)
  // waitForFunction does not await an async predicate, so poll the service and the disk from here.
  const moveDeadline = Date.now() + 10000
  let dragged = fs.readFileSync(source, 'utf8')
  while (Date.now() < moveDeadline) {
    const shown = await page.evaluate(async () => {
      const result = await window.electronAPI.calendarLayers.query({ from: '2026-11-01', to: '2026-11-02', timeZone: 'Asia/Tokyo' })
      return result.ok && result.value.some(entry => entry.title === 'c8-layer' && entry.date === '2026-11-01')
    })
    dragged = fs.readFileSync(source, 'utf8')
    if (shown && dragged.includes('2026-11-01')) break
    await page.waitForTimeout(100)
  }
  const layerAlerts = await page.locator('[data-layer-day] [role="alert"]').allTextContents()
  // Diagnostics only when the drag did not land: the entry as the service sees it, and a direct service move.
  const diagnosis = dragged.includes('2026-11-01') ? null : await page.evaluate(async () => {
    const range = { from: '2026-10-28', to: '2026-11-04', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    const query = await window.electronAPI.calendarLayers.query(range)
    const entry = query.ok ? query.value.find(item => item.title === 'c8-layer') : null
    const chips = [...document.querySelectorAll('[data-layer-entry]')].map(chip => [chip.getAttribute('data-layer-entry'), chip.closest('[data-layer-day]')?.getAttribute('data-layer-day'), chip.getAttribute('draggable')])
    const move = entry ? await window.electronAPI.calendarLayers.move({ range, id: entry.id, expectedVersion: entry.version, date: '2026-11-01' }) : null
    return { range, query: query.ok ? null : query, entry, chips, events: window.__layerDrag, move }
  })
  ok('C8 drag changes only the source date', dragged === '---\ndate: 2026-11-01\n---\nC8 layer smoke\n', JSON.stringify({ dragged, layerAlerts, diagnosis, geometry }))
}

// I2: exercise a real file-tree open, the Ready move command, the live watcher and restart.
async function checkObjectPresentationBeforeRestart(app, page, root) {
  const from = path.join(root, 'i2-a.md'), internal = path.join(root, 'i2-b.md'), external = path.join(root, 'i2-c.md')
  const source = '# I2 reading fixture\n\n' + Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1}: reading position follows this object.\n`).join('\n')
  fs.writeFileSync(from, source)
  const mtime = fs.statSync(from).mtimeMs
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/renderer/index.html')) window.setSize(1500, 1000)
  })
  // Seed the previous format in this throwaway profile to exercise the real migration handshake.
  await page.evaluate(({ root, from }) => {
    localStorage.setItem('ready-workspace-root', root)
    localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    localStorage.removeItem('ready-object-presentation-migration-v1')
    localStorage.setItem('ready-file-appearances-v1', JSON.stringify({ [from]: { color: 'red', icon: '🐙' } }))
    localStorage.setItem('ready-document-reading-positions-v1', JSON.stringify([{ key: from, updatedAt: Date.now(), top: 400, ratio: 0.1, maxScroll: 4000, anchorTitle: null, anchorOrdinal: null, anchorProgress: null }]))
  }, { root, from })
  await page.reload()
  await requestMode(page, 'document')
  // This step is about the file tree: show the 文件 view, then expand the collapsed vault folder as a person would.
  const filesView = page.getByRole('group', { name: '侧栏视角' }).getByRole('button', { name: '文件', exact: true })
  if (await filesView.isVisible().catch(() => false) && await filesView.getAttribute('aria-pressed') !== 'true') await filesView.click()
  const fileRow = page.getByText('i2-a.md', { exact: true }).first()
  if (!await fileRow.isVisible().catch(() => false)) await page.getByText(path.basename(root), { exact: true }).first().click({ timeout: 20000 })
  await fileRow.click({ timeout: 20000 })
  await page.waitForFunction(from => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.path === from && tab.objectId), from)
  const identity = await page.evaluate(from => window.electronAPI.objects.resolvePath(from), from)
  ok('C2 opening a real file leaves its bytes and mtime unchanged', fs.readFileSync(from, 'utf8') === source && fs.statSync(from).mtimeMs === mtime)
  await page.waitForFunction(() => !localStorage.getItem('ready-file-appearances-v1') && !localStorage.getItem('ready-document-reading-positions-v1'))
  const before = await page.evaluate(id => ({
    appearance: JSON.parse(localStorage.getItem('ready-object-appearances-v1') || '{}')[id],
    position: JSON.parse(localStorage.getItem('ready-object-reading-positions-v1') || '[]').find(row => row.key === id),
  }), identity.objectId)
  ok('C2 migration retains appearance and reading position under the object ID', before.appearance?.icon === '🐙' && before.position?.top > 0, JSON.stringify(before))
  const renamed = await page.evaluate(({ from, internal }) => window.electronAPI.document.rename(from, internal), { from, internal })
  ok('C2 Ready rename succeeds', renamed.success, JSON.stringify(renamed))
  await page.waitForFunction(({ id, to }) => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.objectId === id && tab.path === to), { id: identity.objectId, to: internal })
  fs.renameSync(internal, external)
  await page.waitForFunction(({ id, to }) => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.objectId === id && tab.path === to), { id: identity.objectId, to: external }, { timeout: 20000 })
  ok('C2 external mv updates the open tab through the real watcher', true)
  ok('C2 open and both moves never insert ready_id', fs.readFileSync(external, 'utf8') === source)
  return { objectId: identity.objectId, path: external }
}

async function checkObjectPresentationAfterRestart(page, identity) {
  await requestMode(page, 'document')
  await page.waitForFunction(({ objectId, path }) => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.objectId === objectId && tab.path === path && tab.objectBinding?.status === 'resolved'), identity)
  const restored = await page.evaluate(({ objectId }) => ({
    tabs: JSON.parse(localStorage.getItem('ready-doc-tabs-v2')).state.tabs.filter(tab => tab.objectId === objectId),
    appearance: JSON.parse(localStorage.getItem('ready-object-appearances-v1') || '{}')[objectId],
    position: JSON.parse(localStorage.getItem('ready-object-reading-positions-v1') || '[]').find(row => row.key === objectId),
  }), identity)
  ok('C2 reopening retains one tab, appearance and reading position', restored.tabs.length === 1 && restored.appearance?.icon === '🐙' && restored.position?.top > 0, JSON.stringify(restored))
  // The M6 meeting note opens its own tab before the restart; bring this tab to the front through the tab rail.
  const activeTab = await page.evaluate(() => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.activeTabId)
  if (activeTab !== restored.tabs[0].id) await page.locator(`[title^="${path.basename(identity.path)}"]`).first().click({ timeout: 20000 })
  await page.locator('.document-path-bar').getByText(identity.path, { exact: true }).waitFor({ timeout: 20000 })
  ok('C2 the visible document header shows the final path', true)
  // Scroll scopes are keyed by object id (path only for files without one).
  await page.waitForFunction(({ path, objectId }) => Array.from(document.querySelectorAll('[data-ready-document-scroll-key]')).some(scope =>
    [objectId, path].includes(scope.getAttribute('data-ready-document-scroll-key')) && [scope, ...scope.querySelectorAll('*')].some(element => element.scrollTop > 0)), identity, { timeout: 20000 })
  ok('C2 the reopened document visibly restores its reading position', true)
  // The document tab rail renders each tab with its title attribute; the custom icon is its visible glyph.
  const iconShown = await page.waitForFunction(name => [...document.querySelectorAll('[title]')]
    .some(el => el.getAttribute('title').startsWith(name) && el.textContent.includes('🐙')), path.basename(identity.path), { timeout: 15000 }).then(() => true, () => false)
  ok('C2 the reopened tab visibly retains its custom icon', iconShown)
}

// R3b: calendar-union currently has no reference item in its chip context menu,
// and its pointer drag edits dates rather than exporting a chat payload. Construct
// the occurrence from production calendar IPC, then exercise the real composer
// drop handler and attachment button. No model request or renderer-store injection.
async function checkCalendarReference(page) {
  let reference
  await requestMode(page, 'calendar')
  await page.locator('.ready-calendar').waitFor()
  if (!reference) {
    reference = await page.evaluate(async () => {
      const api = window.electronAPI.calendar
      const snapshot = await api.snapshot()
      if (!snapshot.success) throw Error(snapshot.error)
      const calendar = snapshot.data.calendars.find(c => c.primary && !c.readOnly)
      if (!calendar) throw Error('No writable calendar')
      const start = Date.parse('2026-11-03T09:00:00Z'), second = start + 86400000
      const id = 'r3b-repeat', title = 'R3b second occurrence'
      const saved = await api.mutate({ type: 'create', event: {
        id, uid: id + '@test', calendarId: calendar.id, title, allDay: false,
        start, end: start + 3600000, timeZone: 'UTC', rrule: 'FREQ=DAILY;COUNT=3',
        status: 'confirmed', transparency: 'opaque', createdAt: start, updatedAt: start,
      } }, {})
      if (!saved.success) throw Error(saved.error)
      const rows = await api.getEvents(new Date(second), new Date(second + 86400000), 'UTC')
      if (!rows.success) throw Error(rows.error)
      const eventId = `${id}#${second / 1000}`
      const occurrence = rows.data.find(row => row.id === eventId)
      if (!occurrence || occurrence.startTime * 1000 !== second) throw Error('Second occurrence readback failed')
      return { type: 'calendar-event', name: title, title, eventId, allDay: false,
        startTime: new Date(second).toISOString(), endTime: new Date(second + 3600000).toISOString(), second, seriesId: id }
    })
  }
  // Exercise draft drop once; the post-restart check below clicks persisted history.
  await page.locator('[data-chat-composer-shell="true"]').waitFor()
  await page.locator('[data-chat-composer-shell="true"]').evaluate((element, payload) => {
    const transfer = new DataTransfer()
    transfer.setData('application/x-ready-drag', JSON.stringify(payload))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, reference)
  const attachment = page.locator('.chat-reference-chip button').filter({ hasText: reference.title }).first()
  await attachment.waitFor()
  // Clear any existing selection so a stale selected chip cannot satisfy the check.
  await page.locator('.ready-calendar').focus()
  await page.keyboard.press('Escape')
  await attachment.click()
  await page.waitForFunction(({ seriesId, second }) => [...document.querySelectorAll('.ready-calendar .chip.selected')]
    .some(el => el.getAttribute('data-key') === `${seriesId}|${second}`), reference)
  const selectedStart = await page.locator('.ready-calendar .chip.selected').first().getAttribute('data-key')
  ok('C1 calendar attachment selects the second occurrence start', Number(selectedStart.split('|')[1]) === reference.second, selectedStart)
  return reference
}

// No local IPC writes arbitrary chat messages. Remote receive requires a bound
// account, so seed through the real stores only after closing this throwaway app.
// M6-A: real event panel + SaveToPicker. The preceding C1 step has created a recurring event.
async function checkCalendarLinksBeforeRestart(page, reference, root) {
  const created = await page.evaluate(async root => {
    const result = await window.electronAPI.documentPages.operate({type:'create',root,parentPath:root,
      title:'M6 linked page',content:'# M6 linked page\n',operationId:'m6-smoke-page'})
    if (!result.ok) throw new Error(result.message)
    return result.value
  }, root)
  await requestMode(page, 'calendar')
  await page.evaluate(id => window.electronAPI.calendar.revealEvent(id), reference.eventId)
  const panel = page.getByRole('region', {name:'日程关联'})
  await panel.waitFor()
  const uri = `ready://doc/page/${encodeURIComponent(created.objectId)}`
  await panel.getByLabel('关联地址', {exact:true}).fill(uri)
  await panel.getByRole('button', {name:'添加关联',exact:true}).click()
  await panel.getByRole('button', {name:'解除关联 M6 linked page',exact:true}).waitFor()
  await panel.getByRole('button', {name:'会议笔记',exact:true}).click()
  const picker = panel.getByRole('dialog', {name:'保存到…'})
  await picker.getByLabel('标题', {exact:true}).fill('M6 meeting notes')
  await picker.getByRole('button', {name:'确认',exact:true}).click()
  await panel.getByRole('button', {name:'打开会议笔记',exact:true}).waitFor()
  const links = await page.evaluate(async ({seriesId,second}) => {
    const result=await window.electronAPI.calendar.snapshot()
    if(!result.success)throw new Error(result.error)
    return result.data.links.filter(link=>link.eventId===seriesId&&link.originalStart===second)
  },reference)
  ok('M6 second occurrence owns both page and meeting note', links.length===2 && links.some(link=>link.purpose==='meeting-note'))
  return {pageId:created.objectId,note:links.find(link=>link.purpose==='meeting-note').target,reference}
}

async function checkCalendarLinksAfterRestart(page, saved) {
  const state = await page.evaluate(async () => {
    const result=await window.electronAPI.calendar.snapshot()
    if(!result.success)throw new Error(result.error)
    return result.data
  })
  const links=state.links.filter(link=>link.eventId===saved.reference.seriesId&&link.originalStart===saved.reference.second)
  const note=links.find(link=>link.purpose==='meeting-note')
  ok('M6 page and note links survive restart with original instance identity', links.length===2 && note?.target.id===saved.note.id)
  const location=await page.evaluate(id=>window.electronAPI.objects.locate(id),saved.note.id)
  ok('M6 meeting note file survives restart', !!location?.path && fs.existsSync(location.path))
  await requestMode(page,'calendar')
  await page.evaluate(id=>window.electronAPI.calendar.revealEvent(id),saved.reference.eventId)
  const panel=page.getByRole('region',{name:'日程关联'})
  await panel.getByRole('button',{name:'解除关联 M6 linked page',exact:true}).click()
  const detached=await page.evaluate(async()=>window.electronAPI.calendar.snapshot())
  ok('M6 removing the page association leaves the meeting note intact', detached.success
    && !detached.data.links.some(link=>link.target.id===saved.pageId)
    && detached.data.links.some(link=>link.target.id===saved.note.id))
  await panel.getByRole('button',{name:'撤销上次关联修改',exact:true}).click()
  await panel.getByRole('button',{name:'解除关联 M6 linked page',exact:true}).waitFor()
  ok('M6 panel undo restores the page association after restart', true)
}

// Closed scopes remain invisible by product contract; keep a separate closed
// fixture for migration/readback, never reopen its tombstone to fake a UI pass.
async function seedCalendarHistory(profile, reference) {
  const realProfile = fs.realpathSync(profile)
  const tempRoot = fs.realpathSync(os.tmpdir())
  if (path.dirname(realProfile) !== tempRoot || !path.basename(realProfile).startsWith('ready-next-smoke-')) throw Error('Fixture requires an isolated smoke profile')
  const dbPath = fs.realpathSync(path.join(realProfile, 'ready.db'))
  if (path.dirname(dbPath) !== realProfile) throw Error('Fixture database escaped profile')
  const { pathToFileURL } = require('node:url')
  const { ChatStore } = await import(pathToFileURL(path.resolve('src/main/modules/database/chat-store.ts')).href)
  const { toReadyUri } = await import(pathToFileURL(path.resolve('src/shared/ready-ref.ts')).href)
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  const history = { scopeId: 'r3c-saved-history', messageId: 'r3c-saved-message', title: 'R3c saved calendar history',
    closedId: 'r3c-closed-history', closedMessageId: 'r3c-closed-message' }
  try {
    db.transaction(() => {
      const chat = new ChatStore(() => db)
      const attachment = { id: 'r3c-second', name: reference.title, source: 'calendar-event', type: 'text', size: 0, ext: '',
        path: toReadyUri({ kind: 'event', id: reference.seriesId, occurrence: String(reference.second) }) }
      chat.createConversation(history.scopeId, 'butler', history.title)
      chat.addChatMessage(history.messageId, history.scopeId, 'user', 'R3c saved attachment before restart', new Date().toISOString(), { attachments: [attachment] }, 0)
      chat.createConversation(history.closedId, 'butler', 'R3c closed calendar history')
      chat.addChatMessage(history.closedMessageId, history.closedId, 'user', 'R3c immutable original', new Date().toISOString(), {
        attachments: [{ ...attachment, path: 'calendar-event://' + encodeURIComponent(reference.eventId) },
          { ...attachment, id: 'missing', name: 'Gone', path: 'calendar-event://missing' }],
      }, 0)
      db.prepare('UPDATE chat_conversations SET closed_at=? WHERE id=?').run(new Date().toISOString(), history.closedId)
      // Simulate the pre-142 profile; the next real boot must build the mapping.
      db.prepare('DELETE FROM migrations WHERE name=?').run('144_calendar_attachment_display_refs')
    })()
    if (reference.r45Url) history.r45 = await seedR45History(db, reference.r45Url)
    return history
  } finally { db.close() }
}

async function readChatMessages(page, id) {
  // Chat persistence registers its IPC after the window loads; retry until the handler answers.
  const deadline = Date.now() + 30000
  for (;;) {
    try { return await page.evaluate(id => window.electronAPI.chat.getMessages(id), id) }
    catch (error) { if (!/No handler registered/.test(String(error)) || Date.now() > deadline) throw error }
    await page.waitForTimeout(250)
  }
}

async function checkCalendarHistoryAfterRestart(page, reference, history) {
  const saved = await readChatMessages(page, history.scopeId)
  ok('C1 saved chat attachment is read from persisted history after restart', saved.success && saved.data.some(row => row.id === history.messageId), JSON.stringify(saved))
  await page.getByRole('button', { name: /当前会话：.*点击查看历史对话/ }).click()
  // The title appears in the header and in the history list; either opens the conversation.
  const row = page.locator('.chat-header-floating-menu').getByText(history.title, { exact: true }).first()
  if (!await row.isVisible()) await page.getByRole('button', { name: '展开历史会话', exact: true }).first().click()
  await row.click()
  // The saved history repeats the reference; any enabled copy must open the same occurrence.
  const attachment = page.locator('[data-chat-message-attachment="true"]:not([disabled])').filter({ hasText: reference.title }).first()
  await attachment.waitFor()
  // Clear selection; a restored calendar selection cannot satisfy the click check.
  await requestMode(page, 'calendar')
  await page.locator('.ready-calendar').focus()
  await page.keyboard.press('Escape')
  await attachment.click()
  await page.waitForFunction(({ seriesId, second }) => [...document.querySelectorAll('.ready-calendar .chip.selected')]
    .some(el => el.getAttribute('data-key') === `${seriesId}|${second}`), reference)
  ok('C1 clicking persisted history after restart selects the second occurrence', true)
  const display = await page.evaluate(id => window.electronAPI.calendar.getAttachmentDisplayRefs([id]), history.closedMessageId)
  ok('C1 closed history migration survives real boot with resolved and unavailable mappings', display.success
    && display.data[0]?.target.ref?.occurrence === String(reference.second)
    && display.data[1]?.target.status === 'unlocatable', JSON.stringify(display))
  const closed = await readChatMessages(page, history.closedId)
  ok('C1 closed scope remains hidden under the current product contract', closed.success && closed.data.length === 0)
  step('Closed-history UI click remains blocked by the product visibility contract; this is not a closed-history UI pass')
}

// R45 uses saved fixtures and real UI actions; it never needs a model or a remote website.
async function seedR45History(db, url) {
  const { pathToFileURL } = require('node:url')
  const load = file => import(pathToFileURL(path.resolve(file)).href)
  const { RSSStore } = await load('src/main/modules/database/rss-store.ts')
  const { ChatStore } = await load('src/main/modules/database/chat-store.ts')
  const { rssReferencePath } = await load('src/shared/rss-reference.ts')
  const { toReadyUri } = await load('src/shared/ready-ref.ts')
  const rss = new RSSStore(() => db), chat = new ChatStore(() => db)
  const source = rss.addRSSSource({ name: 'R45 fixture', url: `${url}/feed` })
  rss.upsertRSSItems([{ id: 'r45-item', source_id: source, guid: 'r45-item', title: 'R45 saved article', link: url, summary: 'R45 exact selection and remaining text.' }])
  const article = rss.content.getArticle('r45-item')
  const reference = { kind: 'excerpt', read: { format: 'reading-v1', itemId: article.id, expectedRevision: article.revision,
    range: { start: { run: 0, offset: 4 }, end: { run: 0, offset: 9 } }, offset: 0, length: 12000 } }
  const history = { scopeId: 'r45-history', title: 'R45 browser and RSS history', messageId: 'r45-message', url, reference }
  chat.createConversation(history.scopeId, 'butler', history.title)
  chat.addChatMessage(history.messageId, history.scopeId, 'user', 'R45 persisted references', new Date().toISOString(), { attachments: [
    { id: 'r45-web', name: 'R45 webpage', source: 'browser-tab', path: toReadyUri({ kind: 'web', url }), url, type: 'text', size: 0, ext: '.url' },
    { id: 'r45-rss', name: 'R45 saved excerpt', source: 'rss-reference', path: rssReferencePath(reference), rssReference: reference, type: 'text', size: 0, ext: '.rss' },
  ] }, 0)
  return history
}

async function checkR45References(app, page, history, createDrafts) {
  const saved = await readChatMessages(page, history.scopeId)
  ok('R45 history contains a webpage and an exact RSS reference', saved.success && JSON.parse(saved.data.find(row => row.id === history.messageId)?.meta_json || '{}').attachments?.length === 2, JSON.stringify(saved))
  await page.getByRole('button', { name: /当前会话：.*点击查看历史对话/ }).click()
  const row = page.locator('.chat-header-floating-menu').getByText(history.title, { exact: true }).first()
  if (!await row.isVisible()) await page.getByRole('button', { name: '展开历史会话', exact: true }).first().click()
  await row.click()
  if (createDrafts) {
    const tab = await page.evaluate(url => window.electronAPI.browser.createTab(url), history.url)
    if (!tab.success || !tab.tabId) throw Error('R45 browser fixture failed')
    await page.locator('[data-chat-composer-shell="true"]').evaluate((element, payload) => {
      const transfer = new DataTransfer(); transfer.setData('application/x-ready-drag', JSON.stringify(payload))
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, { type: 'browser-tab', name: 'R45 draft webpage', tabId: tab.tabId, url: history.url })
    await page.locator('.chat-reference-chip button').filter({ hasText: 'R45 draft webpage' }).click()
  } else await page.locator('[data-chat-message-attachment="true"]:not([disabled])').filter({ hasText: 'R45 webpage' }).first().click()
  await page.locator('[data-workbench-mode-panel="browser"][data-mode-visual-state="current"]').waitFor()
  const deadline = Date.now() + 15000
  while (!await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(w => w.getURL() === url && !w.isLoading()), history.url)) {
    if (Date.now() > deadline) throw Error('R45 browser reference did not load its original URL')
    await page.waitForTimeout(100)
  }
  ok(`R45 ${createDrafts ? 'new' : 'restarted history'} browser reference opens its webpage`, true)
  await page.locator('[data-chat-message-attachment="true"]:not([disabled])').filter({ hasText: 'R45 saved excerpt' }).first().click()
  await page.getByRole('button', { name: '在 RSS 中定位', exact: true }).click()
  await page.locator('.rss-reader-title').filter({ hasText: 'R45 saved article' }).waitFor()
  await page.waitForFunction(() => window.getSelection()?.toString() === 'exact')
  if (createDrafts) {
    await page.getByRole('button', { name: '引用', exact: true }).click()
    await page.getByRole('button', { name: '引用所选文字', exact: true }).click()
    await page.locator('.chat-reference-chip button').filter({ hasText: 'R45 saved article · 选区' }).click()
    await page.getByRole('button', { name: '在 RSS 中定位', exact: true }).click()
    await page.waitForFunction(() => window.getSelection()?.toString() === 'exact')
  }
  ok(`R45 ${createDrafts ? 'new' : 'restarted history'} RSS reference selects the original exact text`, true)
}

async function checkIdentityAndFastCard() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-smoke-'))
  let app
  let page
  const server = require('node:http').createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>R45 webpage</title><p>R45 local webpage fixture</p>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const r45Url = `http://127.0.0.1:${server.address().port}/`
  try {
    ;({ app, page } = await launch(profile))
    const identity = await withTimeout(app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath('userData') })), 20000, 'read app identity')
    ok('C15 app identifies as Ready Next', identity.name === 'Ready Next', JSON.stringify(identity))
    ok('C15 userData is the isolated profile', fs.realpathSync(identity.userData) === fs.realpathSync(profile), JSON.stringify(identity))

    const vault = await withTimeout(page.evaluate(() => window.electronAPI.vault.get()), 20000, 'read vault state')
    ok('D17 a fresh dev profile has no vault and suggests a test vault inside the profile',
      vault.status === 'unconfigured' && fs.realpathSync(path.dirname(vault.defaultSuggestion)) === fs.realpathSync(profile), JSON.stringify(vault))
    const created = await withTimeout(page.evaluate(() => window.electronAPI.vault.createDefault()), 20000, 'create default vault')
    ok('D17 creating the default vault makes it ready inside the profile',
      created.status === 'ready' && fs.realpathSync(created.root).startsWith(fs.realpathSync(profile)), JSON.stringify(created))

    const item = {
      id: `smoke-${Date.now()}`, kind: 'text', createdAt: Date.now(), text: 'ready-next smoke',
      source: { pageUrl: 'https://example.test/', pageTitle: 'Example', domain: 'example.test', capturedAt: Date.now() },
    }
    const added = await withTimeout(page.evaluate(entry => window.electronAPI.browser.addFastCardItem(entry), item), 20000, 'add FastCard item')
    ok('C7 FastCard add returns a persisted receipt', added?.success === true && added.data?.id === item.id, JSON.stringify(added))
    const objectIdentity = await checkObjectPresentationBeforeRestart(app, page, created.root)
    const calendarReference = { ...await checkCalendarReference(page), r45Url }
    const calendarLinks = await checkCalendarLinksBeforeRestart(page, calendarReference, created.root)
    await checkCalendarLayers(page, created.root)
    step('close app')
    await withTimeout(app.close(), 150000, 'close app')
    app = undefined
    const seeded = spawnSync(require('electron'), ['--import', 'tsx', __filename, '--seed-calendar-history', profile, JSON.stringify(calendarReference)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000,
    })
    if (seeded.status !== 0) throw Error(`Calendar history fixture failed: ${seeded.stderr || seeded.stdout}`)
    const history = JSON.parse(seeded.stdout.trim())

    ;({ app, page } = await launch(profile))
    await checkObjectPresentationAfterRestart(page, objectIdentity)
    await checkCalendarHistoryAfterRestart(page, calendarReference, history)
    await checkCalendarLinksAfterRestart(page, calendarLinks)
    await checkR45References(app, page, history.r45, true)
    await withTimeout(app.close(), 150000, 'R45 close before restart')
    app = undefined
    ;({ app, page } = await launch(profile))
    await checkR45References(app, page, history.r45, false)
    const reopenedVault = await withTimeout(page.evaluate(() => window.electronAPI.vault.get()), 20000, 'read vault after restart')
    ok('D17 the vault setting survives a restart', reopenedVault.status === 'ready' && reopenedVault.root === created.root, JSON.stringify(reopenedVault))
    const listed = await withTimeout(page.evaluate(() => window.electronAPI.browser.listFastCardItems()), 20000, 'list FastCard items')
    const restored = listed?.success === true && listed.data.find(entry => entry.id === item.id)
    ok('C7 FastCard item survives a restart', restored && restored.text === item.text && restored.source?.pageUrl === item.source.pageUrl, JSON.stringify(listed))
    step('close app')
    await withTimeout(app.close(), 150000, 'close app')
    app = undefined
  } finally {
    // A failed check must not leave Electron running, or the script never exits.
    if (app) await withTimeout(app.close(), 30000, 'close app after failure').catch(() => app.process().kill('SIGKILL'))
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

// Electron resolves the home folder without $HOME, so the real daily folder cannot be faked.
// The guard accepts extra protected folders (it can never drop the daily one); protect a
// throwaway folder and point userData inside it.
function checkDailyDataRefusal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-protected-'))
  const daily = path.join(root, 'Ready')
  fs.mkdirSync(daily, { recursive: true })
  try {
    const run = spawnSync(require('electron'), [process.cwd()], {
      env: electronEnv({ READY_NEXT_EXTRA_PROTECTED_DIRS: daily, READY_USER_DATA_DIR: path.join(daily, 'nested') }),
      timeout: 30000,
      encoding: 'utf8',
    })
    ok('C15 an override inside the daily Ready folder exits with code 1', run.status === 1,
      `status=${run.status} signal=${run.signal} stderr=${String(run.stderr).slice(0, 400)}`)
    ok('C15 the refused boot creates nothing inside the daily folder', !fs.existsSync(path.join(daily, 'nested')))
    ok('C15 the refusal explains why', /cannot use daily Ready data/.test(String(run.stderr)), String(run.stderr).slice(0, 400))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

module.exports = { seedCalendarHistory, seedR45History }

if (require.main === module && process.argv[2] === '--seed-calendar-history') {
  seedCalendarHistory(process.argv[3], JSON.parse(process.argv[4])).then(result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1 })
} else if (require.main === module) void (async () => {
  try {
    await checkIdentityAndFastCard()
    checkDailyDataRefusal()
  } catch (error) {
    ok('smoke run completed', false, error instanceof Error ? error.stack : String(error))
  }
  const failed = results.filter(r => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()
