// Build this checkout first. This gate requires a real Electron window; no CLI-only success mode.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { _electron } = require('playwright')
const crypto = require('node:crypto')
const zlib = require('node:zlib')

// Synthetic media for the board's media steps: a real PNG and a real WAV, generated here (no binary fixtures).
function pngImage(width, height, pixel) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4)
    return out
  }
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x / width, y / height), y * (width * 3 + 1) + 1 + x * 3)
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const dusk = (u, v) => [Math.round(235 - 150 * v), Math.round(170 - 90 * v + 40 * u), Math.round(120 + 90 * v)]
const field = (u, v) => [Math.round(60 + 120 * u), Math.round(150 - 60 * v), Math.round(90 + 40 * v * u)]
function wavSound(seconds, rate = 16000) {
  const samples = seconds * rate, bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'latin1'); bytes.writeUInt32LE(36 + samples * 2, 4); bytes.write('WAVEfmt ', 8, 'latin1'); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'latin1'); bytes.writeUInt32LE(samples * 2, 40)
  // Phrases with pauses, so the card's waveform has a shape.
  for (let i = 0; i < samples; i++) { const t = i / rate, envelope = Math.max(0, Math.sin(t * 2.4) * Math.sin(t * 9.1)) ** 1.5
    bytes.writeInt16LE(Math.round(envelope * 20000 * Math.sin(2 * Math.PI * (180 + 60 * Math.sin(t * 3)) * t)), 44 + i * 2) }
  return bytes
}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

async function main() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-canvas-')))
  const vault = path.join(temporary, 'vault'), profile = path.join(temporary, 'profile'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const oldPath = path.join(vault, '旧画板.readyboard')
  const oldBytes = fs.readFileSync(path.join(__dirname, 'fixtures/ready-next-canvas.readyboard'))
  fs.writeFileSync(oldPath, oldBytes)
  // Verification never puts a window in front of the person (READY_START_HIDDEN keeps it unshown).
  const env = { ...process.env, READY_USER_DATA_DIR: profile, READY_START_HIDDEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app, page
  const poll = async (check, message) => {
    const deadline = Date.now() + 45000
    while (!await check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const launch = async () => {
    // The record step uses Chromium's fake capture device (a generated tone, no microphone, no permission prompt)
    // and plays it back muted: nothing is heard and nothing of the machine's is recorded.
    app = await _electron.launch({ executablePath: require('electron'), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', process.cwd()], env, timeout: 45000 })
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
  // M4 2026-11-14 — media on the board, on its own board so the steps above keep their card counts: a fixture voice
  // card with a transcript and a link card with a kept preview and cover (no network), then a dropped picture, a
  // pasted picture, a recording from the fake device, the slideshow and transcript search.
  const mediaSteps = async () => {
    const memo = wavSound(6), cover = pngImage(480, 270, dusk), now = new Date().toISOString()
    fs.mkdirSync(path.join(vault, '媒体.assets'))
    fs.writeFileSync(path.join(vault, '媒体.assets', `${sha256(memo)}-memo.wav`), memo)
    fs.writeFileSync(path.join(vault, '媒体.assets', 'cover.png'), cover)
    const board = await page.evaluate(async ({ memoFile, memoHash, now }) => {
      const canvas = await window.electronAPI.canvas.create({ path: '媒体.canvas', operationId: crypto.randomUUID(), canvas: { edges: [], ready: { id: crypto.randomUUID(), schemaVersion: 1, title: '媒体' }, nodes: [
        { id: 'fixture-memo', type: 'file', file: memoFile, x: 0, y: 0, width: 300, height: 176, ready: { kind: 'audio', media: { mime: 'audio/wav', sha256: memoHash, originalName: 'memo.wav', durationMs: 6000, transcript: '明天上午把封面第三稿发给印厂，再确认发行渠道。' }, preview: { title: '选题会录音', fetchedAt: now } } },
        { id: 'fixture-link', type: 'link', url: 'https://example.com/essay', x: 0, y: 200, width: 260, height: 220, ready: { kind: 'link', preview: { title: '注意力才是稀缺品', description: '一个好的筛子先理解你在做什么。', site: 'Example', image: '媒体.assets/cover.png', fetchedAt: now } } },
      ] } })
      if (!canvas.ok) throw new Error(canvas.error)
      await window.electronAPI.canvas.release(canvas.value.handleId)
      return canvas.value.objectId
    }, { memoFile: `媒体.assets/${sha256(memo)}-memo.wav`, memoHash: sha256(memo), now })
    await reveal(board)
    const stage = page.locator('[data-workbench-mode-panel="document"] .rn-canvas[aria-label="媒体"]').first()
    await stage.waitFor()
    const read = () => JSON.parse(fs.readFileSync(path.join(vault, '媒体.canvas'), 'utf8'))
    const attachment = node => fs.readFileSync(path.join(vault, node.file))
    // The fixture cards: the voice card shows length, transcript and real peaks; the link card its kept cover, unfetched.
    const memoCard = stage.locator('.canvas-card[data-node-id="fixture-memo"]')
    await memoCard.locator('.cv-audio__wave[data-shape="peaks"]').waitFor({ timeout: 15000 })
    assert.equal(await memoCard.locator('.cv-audio__time').innerText(), '0:06')
    assert.match(await memoCard.locator('.cv-audio__transcript').innerText(), /发给印厂/)
    const coverBox = await stage.locator('.canvas-card[data-node-id="fixture-link"] .canvas-link-cover').evaluate(image => ({ width: image.naturalWidth, complete: image.complete }))
    assert.deepEqual(coverBox, { width: 480, complete: true }, 'the kept cover is shown from the board attachments')
    assert.equal(read().nodes.find(node => node.id === 'fixture-link').ready.preview.fetchedAt, now, 'a kept preview is not fetched again')
    // Drop a picture file (as from Finder): a drop event carrying a File, at a point on the stage.
    const transfer = async (type, file, point) => stage.evaluate((element, { type, file, point }) => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], file.name, { type: file.type }))
      const rect = element.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, clientX: rect.left + (point?.x ?? 0), clientY: rect.top + (point?.y ?? 0) }
      if (type === 'paste') { element.focus(); return !element.dispatchEvent(new ClipboardEvent('paste', { ...init, clipboardData: data })) }
      element.dispatchEvent(new DragEvent('dragover', { ...init, dataTransfer: data }))
      return !element.dispatchEvent(new DragEvent('drop', { ...init, dataTransfer: data }))
    }, { type, file, point })
    const photo = pngImage(640, 400, field)
    assert.equal(await transfer('drop', { base64: photo.toString('base64'), name: '田野 photo.png', type: 'image/png' }, { x: 400, y: 100 }), true, 'the board takes a dropped file')
    await poll(() => read().nodes.some(node => node.ready.kind === 'image'), 'Dropped picture was not written')
    const dropped = read().nodes.find(node => node.ready.kind === 'image')
    assert.match(dropped.file, /^媒体\.assets\/[a-f0-9]{64}-田野_photo\.png$/)
    assert.deepEqual(attachment(dropped), photo, 'the attachment in the vault is the dropped file')
    assert.deepEqual({ sha: dropped.ready.media.sha256, mime: dropped.ready.media.mime, width: dropped.width, height: dropped.height }, { sha: sha256(photo), mime: 'image/png', width: 320, height: 200 })
    await poll(async () => await stage.locator(`.canvas-card[data-node-id="${dropped.id}"] .cv-image img`).evaluate(image => image.complete && image.naturalWidth === 640).catch(() => false), 'Dropped picture is not shown')
    // Paste a picture (⌘V with image data): a paste event carrying the picture, placed where the person is looking.
    const pastedBytes = pngImage(300, 300, dusk)
    assert.equal(await transfer('paste', { base64: pastedBytes.toString('base64'), name: 'image.png', type: 'image/png' }), true, 'the board takes a pasted picture')
    await poll(() => read().nodes.filter(node => node.ready.kind === 'image').length === 2, 'Pasted picture was not written')
    const pasted = read().nodes.find(node => node.ready.kind === 'image' && node.id !== dropped.id)
    assert.deepEqual(attachment(pasted), pastedBytes)
    // Record: the dock's record tool shows the running time and a stop control, then drops a voice card.
    await stage.getByRole('button', { name: '录音', exact: true }).click()
    const stop = stage.getByRole('button', { name: '停止录音', exact: true })
    await stop.waitFor({ timeout: 15000 })
    await poll(async () => /^0:0[1-9]$/.test(await stop.locator('[role="timer"]').innerText()), 'Recording time does not run')
    await page.screenshot({ path: path.join(evidence, '07a-recording.png') })
    await page.waitForTimeout(1200)
    await stop.click()
    await poll(() => read().nodes.some(node => node.ready.kind === 'audio' && node.id !== 'fixture-memo'), 'Voice card was not written')
    const voice = read().nodes.find(node => node.ready.kind === 'audio' && node.id !== 'fixture-memo')
    assert.match(voice.file, /^媒体\.assets\/[a-f0-9]{64}-录音_[\d_-]+\.webm$/)
    assert.ok(voice.ready.media.durationMs >= 1500 && voice.ready.media.durationMs < 30000, `recorded length ${voice.ready.media.durationMs}`)
    assert.equal(voice.ready.media.mime, 'audio/webm'); assert.equal(voice.ready.preview.title, '录音')
    const sound = attachment(voice)
    assert.ok(sound.length > 1000 && sound.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')), 'the recording is a WebM file in the vault')
    assert.equal(sha256(sound), voice.ready.media.sha256)
    const voiceCard = stage.locator(`.canvas-card[data-node-id="${voice.id}"]`)
    assert.match(await voiceCard.locator('[data-untranscribed]').innerText(), /^未转写 · 还没有接入能转写音频的模型/)
    assert.match(await voiceCard.locator('.cv-audio__time').innerText(), /^0:0[1-9]$/)
    // It plays: the button turns to 暂停, and back to 播放 when the sound has run to its end.
    await voiceCard.getByRole('button', { name: '播放', exact: true }).click()
    await voiceCard.getByRole('button', { name: '暂停', exact: true }).waitFor({ timeout: 10000 })
    await voiceCard.getByRole('button', { name: '播放', exact: true }).waitFor({ timeout: 20000 })
    assert.equal(await voiceCard.locator('[role="alert"]').count(), 0, 'playback reported no error')
    await snapshot('07-media-cards')
    // Slideshow: double-click a picture; → steps to the next picture of the board, Esc closes.
    await stage.locator(`.canvas-card[data-node-id="${dropped.id}"]`).dblclick({ position: { x: 20, y: 20 } })
    const show = page.locator('[data-float-id="canvas-slideshow"]')
    await show.locator('.cv-slideshow__picture').waitFor()
    assert.equal(await show.locator('.cv-slideshow__count').innerText(), '1 / 2')
    const stageBox = await stage.boundingBox(), showBox = await show.locator('.cv-slideshow').boundingBox()
    assert.ok(Math.abs(showBox.x - stageBox.x) < 1 && Math.abs(showBox.width - stageBox.width) < 1 && Math.abs(showBox.height - stageBox.height) < 1, 'the slideshow covers the board, not the window')
    await page.waitForTimeout(400) // the fade has finished
    await page.screenshot({ path: path.join(evidence, '07b-slideshow.png') })
    await page.keyboard.press('ArrowRight')
    await poll(async () => await show.locator('.cv-slideshow__count').innerText() === '2 / 2', 'Slideshow did not step')
    await page.keyboard.press('Escape')
    await show.waitFor({ state: 'detached' })
    // Search reads transcripts.
    await stage.getByRole('button', { name: '在画板中搜索', exact: true }).click()
    await page.keyboard.type('印厂')
    await stage.locator('.canvas-card[data-matched="true"]').first().waitFor()
    assert.deepEqual(await stage.locator('.canvas-card[data-matched="true"]').evaluateAll(cards => cards.map(card => card.dataset.nodeId)), ['fixture-memo'])
    await page.keyboard.press('Escape')
    // 新建 has 文件…, and a link card's menu has 刷新预览 (neither is activated here: no system dialog, no network).
    await stage.click({ button: 'right', position: { x: Math.round(stageBox.width - 60), y: Math.round(stageBox.height - 200) } })
    await page.getByRole('menuitem', { name: '文件…', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await stage.locator('.canvas-card[data-node-id="fixture-link"]').click({ button: 'right', position: { x: 30, y: 30 } })
    await page.getByRole('menuitem', { name: '刷新预览', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await snapshot('08-media-search')
  }
  try {
    await launch()
    await page.evaluate(async root => { const state = await window.electronAPI.vault.set(root); if (state.status !== 'ready') throw new Error('Vault not ready') }, vault)
    // READY_NEXT_CANVAS_THEME=dark: the theme is read at startup, so it applies from the restart step on (media steps included).
    if (process.env.READY_NEXT_CANVAS_THEME) await page.evaluate(theme => window.electronAPI.theme.set(theme), process.env.READY_NEXT_CANVAS_THEME)
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
    // A private address: Main refuses it before any connection, so this check needs no network (the card says why).
    await page.getByLabel('链接网址').fill('http://192.168.0.1/')
    await page.getByRole('button', { name: '添加链接卡', exact: true }).click()
    const readCanvas = () => JSON.parse(fs.readFileSync(path.join(vault, 'X.canvas'), 'utf8'))
    await poll(() => readCanvas().nodes.length === 3, 'Three card types not persisted')
    await snapshot('01-three-card-types')
    const textId = readCanvas().nodes.find(node => node.type === 'text').id
    await page.locator(`[data-node-id="${textId}"]`).dblclick()
    const rich = page.getByLabel('文字卡编辑').locator('[contenteditable="true"]').first()
    // Wait for the editor explicitly, so a failure names this step instead of a generic fill timeout.
    await poll(async () => await rich.count() > 0, 'Text card editor did not open')
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
    // MS3: 永久删除 takes a recycled card out of the file; 清空 asks once more in place, then empties the bin.
    const purgeCard = async (kind) => {
      const id = readCanvas().nodes.find(node => node.ready.kind === kind && !node.ready.trash).id
      await stage.locator(`.canvas-card[data-node-id="${id}"]`).click()
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
    await mediaSteps()
    console.log(`PASS M4 window gate: ${evidence}`)
  } finally { if (app) await app.close(); console.log(`Evidence retained: ${temporary}`) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
