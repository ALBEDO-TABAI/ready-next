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
    // The board only records (2026-11-14): no transcript, and nothing said about one.
    assert.doesNotMatch(await voiceCard.innerText(), /转写/)
    assert.equal(await voiceCard.locator('.cv-audio__transcript, .cv-audio__note').count(), 0)
    await voiceCard.screenshot({ path: path.join(evidence, '07c-voice-card-recording-only.png') })
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

    // M4 §11 (2026-11-14) — crop a picture, download files as a ZIP. Pointer actions go to a point where the card is on top.
    const JSZip = require('jszip')
    const fit = async () => { await stage.getByRole('button', { name: '适应内容', exact: true }).click(); await page.waitForTimeout(300) }
    const pointOn = async id => {
      let point = null
      await poll(async () => {
        point = await page.evaluate(id => {
          const element = document.querySelector(`[data-workbench-mode-panel="document"] .rn-canvas[aria-label="媒体"] [data-node-id="${id}"]`)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          for (let i = 2; i < 9; i++) for (let j = 2; j < 9; j++) {
            const x = rect.left + rect.width * i / 10, y = rect.top + rect.height * j / 10, top = document.elementFromPoint(x, y)
            if (top && !top.closest('[data-canvas-ui]') && !top.closest('button,[role="slider"],video') && top.closest('[data-node-id]')?.dataset.nodeId === id) return { x, y }
          }
          return null
        }, id)
        return Boolean(point)
      }, `card ${id} cannot be reached`)
      return point
    }
    const nodeOf = id => read().nodes.find(node => node.id === id)
    const dragFrom = async (locator, dx, dy) => {
      const box = await locator.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 }); await page.mouse.move(x + dx, y + dy, { steps: 4 }); await page.mouse.up()
    }
    await fit()
    // 12 — 裁剪 from the card's menu: the whole picture dimmed, a frame with grips; Enter applies.
    const original = nodeOf(dropped.id), ratioOf = crop => (crop.w * 640) / (crop.h * 400)
    let at = await pointOn(dropped.id)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '裁剪 K', exact: true }).waitFor()
    await page.getByRole('menuitem', { name: '下载为 ZIP', exact: true }).waitFor()
    await page.screenshot({ path: path.join(evidence, '12-card-menu-crop-zip.png') })
    await page.getByRole('menuitem', { name: '裁剪 K', exact: true }).click()
    const crop = stage.locator('.cv-crop')
    await crop.waitFor()
    assert.match(await stage.getByRole('toolbar', { name: '裁剪', exact: true }).innerText(), /640 × 400/)
    const frameBox = await crop.locator('.cv-crop__frame').boundingBox()
    await dragFrom(crop.locator('[data-crop-grip="se"]'), -frameBox.width * .45, -frameBox.height * .2)
    await dragFrom(crop.locator('[data-crop-grip="l"]'), frameBox.width * .15, 0)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(evidence, '12a-crop-mode.png') })
    assert.deepEqual(nodeOf(dropped.id), original, 'nothing is written while cropping')
    await page.keyboard.press('Enter')
    await poll(() => nodeOf(dropped.id).ready.appearance?.crop?.mode === 'rect', 'The crop was not written')
    const cropped = nodeOf(dropped.id), kept = cropped.ready.appearance.crop
    assert.ok(kept.x > .1 && kept.x < .2 && kept.y === 0 && kept.w > .35 && kept.w < .45 && kept.h > .75 && kept.h < .85, `crop ${JSON.stringify(kept)}`)
    // The card took the crop's aspect ratio (integer geometry: within a pixel), the file and its bytes did not change.
    assert.ok(Math.abs(cropped.width - cropped.height * ratioOf(kept)) <= 1, `card ${cropped.width}×${cropped.height} vs crop ratio ${ratioOf(kept)}`)
    assert.ok(cropped.width < original.width && cropped.height < original.height)
    assert.equal(cropped.file, original.file); assert.deepEqual(cropped.ready.media, original.ready.media)
    assert.deepEqual(attachment(cropped), photo, 'cropping does not alter the attachment')
    // What is shown: the kept part at one scale on both axes (the picture's own 640:400), filling the card.
    const shown = async () => stage.locator(`.canvas-card[data-node-id="${dropped.id}"]`).evaluate(card => {
      const image = card.querySelector('.cv-image__crop img').getBoundingClientRect(), box = card.getBoundingClientRect()
      return { picture: image.width / image.height, left: (box.left - image.left) / image.width, top: (box.top - image.top) / image.height, right: (image.right - box.right) / image.width, covers: image.left <= box.left + .5 && image.right >= box.right - .5 && image.top <= box.top + .5 && image.bottom >= box.bottom - .5 }
    })
    await poll(async () => (await shown().catch(() => null))?.covers, 'The cropped picture does not fill its card')
    let view = await shown()
    assert.ok(Math.abs(view.picture - 640 / 400) < .01, `the picture is not stretched (${view.picture})`)
    assert.ok(Math.abs(view.left - kept.x) < .01 && Math.abs(view.top - kept.y) < .01, `the card shows the kept part (${JSON.stringify(view)})`)
    await page.mouse.click(8, 8) // away from the board: no hover grips in the picture of the result
    await page.screenshot({ path: path.join(evidence, '12b-cropped-card.png') })
    // A corner arc scales in proportion: the crop's aspect ratio is kept, the picture still unstretched.
    at = await pointOn(dropped.id); await page.mouse.click(at.x, at.y)
    await dragFrom(stage.locator(`.canvas-card[data-node-id="${dropped.id}"] [data-resize="se"]`), 36, 36)
    await poll(() => nodeOf(dropped.id).width > cropped.width, 'The cropped card was not resized')
    const resized = nodeOf(dropped.id)
    assert.ok(Math.abs(resized.width - resized.height * ratioOf(kept)) <= 1.5, `resized ${resized.width}×${resized.height}`)
    assert.deepEqual(resized.ready.appearance.crop, kept)
    view = await shown(); assert.ok(Math.abs(view.picture - 640 / 400) < .01 && view.covers)
    // Undo the resize, then the crop: one step each; the card is as it was dropped. Redo both for the download below.
    const undo = stage.getByRole('button', { name: '撤销', exact: true }), redo = stage.getByRole('button', { name: '重做', exact: true })
    await undo.click(); await poll(() => nodeOf(dropped.id).width === cropped.width, 'Undo did not take the resize back')
    await undo.click(); await poll(() => !nodeOf(dropped.id).ready.appearance, 'Undo did not take the crop back')
    assert.deepEqual(nodeOf(dropped.id), original, 'one undo restores the card and removes the crop')
    await redo.click(); await poll(() => nodeOf(dropped.id).ready.appearance?.crop, 'Redo did not bring the crop back')
    assert.deepEqual(nodeOf(dropped.id), cropped)
    // Esc leaves crop mode without writing.
    at = await pointOn(dropped.id); await page.mouse.click(at.x, at.y); await page.keyboard.press('k')
    await crop.waitFor(); await dragFrom(crop.locator('[data-crop-grip="t"]'), 0, 20); await page.keyboard.press('Escape')
    await crop.waitFor({ state: 'detached' })
    await page.waitForTimeout(300); assert.deepEqual(nodeOf(dropped.id), cropped, 'Esc cancels the crop')
    console.log('PASS 12-crop: crop mode, aspect ratio, bytes unchanged, proportional resize, undo / redo, Esc')

    // 13 — 下载为 ZIP for the selection (everything picked): Main's save dialog is answered with a path in the throwaway directory.
    const zipEntries = async file => { const zip = await JSZip.loadAsync(fs.readFileSync(file)); const out = {}
      for (const [name, entry] of Object.entries(zip.files)) out[name] = entry.dir ? null : await entry.async('nodebuffer')
      return out }
    const answerSave = file => app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
    const zipPath = path.join(temporary, '媒体 选区.zip')
    await answerSave(zipPath)
    await stage.focus(); await page.keyboard.press('Meta+a')
    at = await pointOn(dropped.id); await page.mouse.click(at.x, at.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '下载为 ZIP', exact: true }).click()
    await poll(() => fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0, 'The selection ZIP is missing')
    await page.waitForTimeout(300)
    const selection = await zipEntries(zipPath), recordingName = voice.ready.media.originalName
    assert.deepEqual(Object.keys(selection).sort(), ['image.png', 'links.md', 'memo.md', 'memo.wav', recordingName, '田野 photo.png'].sort())
    assert.deepEqual(selection['田野 photo.png'], photo, 'the cropped card still downloads its whole original file')
    assert.deepEqual(selection['image.png'], pastedBytes); assert.deepEqual(selection['memo.wav'], memo); assert.deepEqual(selection[recordingName], sound)
    assert.equal(selection['memo.md'].toString('utf8'), '# 选题会录音\n\n明天上午把封面第三稿发给印厂，再确认发行渠道。\n')
    assert.equal(selection['links.md'].toString('utf8'), '# 链接\n\n- [注意力才是稀缺品](https://example.com/essay)\n')
    await page.getByText(/已下载 ZIP（6 个文件）/).first().waitFor()
    // 更多 names the two kinds apart: 导出 composes one document, 下载 hands over the files.
    await stage.getByRole('button', { name: '更多', exact: true }).click()
    const moreMenu = page.getByRole('menu', { name: '更多', exact: true })
    await moreMenu.getByText('导出 · 合成一份', { exact: true }).waitFor(); await moreMenu.getByText('下载 · 各自的原文件', { exact: true }).waitFor()
    await page.getByRole('menuitem', { name: '把选中的卡片导出为 Markdown', exact: true }).waitFor()
    await page.getByRole('menuitem', { name: '把选中的卡片下载为 ZIP', exact: true }).waitFor()
    await page.screenshot({ path: path.join(evidence, '13-more-menu-export-download.png') })
    await page.keyboard.press('Escape')
    // A sub-board downloads as a folder: collect the two pictures into one, then 下载为 ZIP on its card.
    await page.mouse.click(8, 8); at = await pointOn(dropped.id); await page.mouse.click(at.x, at.y)
    const other = await pointOn(pasted.id); await page.keyboard.down('Shift'); await page.mouse.click(other.x, other.y); await page.keyboard.up('Shift')
    await page.mouse.click(other.x, other.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '收进子画板', exact: true }).click()
    await poll(() => fs.existsSync(path.join(vault, '媒体', '子画板.canvas')) && read().nodes.some(node => node.ready.kind === 'subcanvas'), 'The pictures were not collected into a sub-board')
    const folderCard = read().nodes.find(node => node.ready.kind === 'subcanvas')
    await stage.locator(`[data-node-id="${folderCard.id}"] .canvas-subboard__count`, { hasText: '2 张卡片' }).waitFor()
    const folderZip = path.join(temporary, '子画板.zip')
    await answerSave(folderZip)
    await fit(); at = await pointOn(folderCard.id); await page.mouse.click(at.x, at.y, { button: 'right' })
    await page.getByRole('menuitem', { name: '下载为 ZIP', exact: true }).click()
    await poll(() => fs.existsSync(folderZip) && fs.statSync(folderZip).size > 0, 'The sub-board ZIP is missing')
    await page.waitForTimeout(300)
    const folder = await zipEntries(folderZip)
    assert.deepEqual(Object.keys(folder).sort(), ['子画板/', '子画板/image.png', '子画板/田野 photo.png'])
    assert.deepEqual(folder['子画板/田野 photo.png'], photo); assert.deepEqual(folder['子画板/image.png'], pastedBytes)
    // The whole board from 更多 (nothing picked): the sub-board is a folder beside the board's own files.
    const boardZip = path.join(temporary, '媒体.zip')
    await answerSave(boardZip)
    await page.mouse.click(8, 8); await stage.focus(); await page.keyboard.press('Escape')
    await stage.click({ position: { x: 12, y: Math.round(stageBox.height / 2) } })
    await stage.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '下载为 ZIP', exact: true }).click()
    await poll(() => fs.existsSync(boardZip) && fs.statSync(boardZip).size > 0, 'The board ZIP is missing')
    await page.waitForTimeout(300)
    assert.deepEqual(Object.keys(await zipEntries(boardZip)).sort(), ['links.md', 'memo.md', 'memo.wav', recordingName, '子画板/', '子画板/image.png', '子画板/田野 photo.png'].sort())
    await snapshot('13a-zip-download')
    console.log('PASS 13-zip: selection, sub-board folder and whole board; original bytes; nothing outside the throwaway directory')
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
    await mediaSteps()
    console.log(`PASS M4 window gate: ${evidence}`)
  } finally { if (app) await app.close(); console.log(`Evidence retained: ${temporary}`) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
