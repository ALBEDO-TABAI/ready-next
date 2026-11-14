import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMainInvokeEvent } from 'electron'
import { ATTACHMENT_LIMITS, attachmentName, sniffMedia, stagedAttachment } from '../main/modules/board-engine/attachment-staging'
import { registerCanvasMediaIPC, type CanvasMediaDependencies } from '../main/modules/board-engine/media-ipc'
import type { CanvasService } from '../main/modules/board-engine/canvas-service'
import { CanvasNodeSchema, type CanvasCommand, type ReadyCanvas } from '../shared/ready-canvas'
import { clipboardImageFiles, intakeFiles, intakeKind, transferFiles, type IntakeHost } from '../renderer/modules/canvas/media-intake'
import { createLinkPreviews } from '../renderer/modules/canvas/link-preview-cache'
import { peaksOf } from '../renderer/modules/canvas/waveform'
import { boardSlides } from '../renderer/components/canvas/surface/Slideshow'
import { cropStyle } from '../renderer/components/canvas/cards/ImageCard'
import { png } from './utils/media-fixture'

// Synthetic media only: a real PNG, and containers reduced to the header bytes Main inspects.
const withHeader = (hex: string, size = 64) => { const bytes = Buffer.alloc(size); Buffer.from(hex, 'hex').copy(bytes); return bytes }
const webm = () => withHeader('1a45dfa3')
const wav = () => { const bytes = Buffer.alloc(64); bytes.write('RIFF', 0, 'latin1'); bytes.write('WAVE', 8, 'latin1'); return bytes }
const mp4 = (brand = 'isom') => { const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'latin1'); bytes.write(brand, 8, 'latin1'); return bytes }

test('Main decides the media type from the bytes; the declared type only settles sound-or-picture containers', () => {
  assert.deepEqual(sniffMedia(png(), 'text/plain'), { kind: 'image', mime: 'image/png', extension: 'png' })
  assert.equal(sniffMedia(withHeader('ffd8ffe0'), '')?.mime, 'image/jpeg')
  assert.equal(sniffMedia(wav(), 'image/png')?.mime, 'audio/wav')
  assert.equal(sniffMedia(withHeader('494433'), '')?.mime, 'audio/mpeg')
  assert.deepEqual(sniffMedia(webm(), 'audio/webm;codecs=opus'), { kind: 'audio', mime: 'audio/webm', extension: 'webm' })
  assert.equal(sniffMedia(webm(), 'video/webm')?.kind, 'video')
  assert.equal(sniffMedia(mp4('M4A '), 'video/mp4')?.mime, 'audio/mp4')
  assert.equal(sniffMedia(mp4(), 'video/mp4')?.mime, 'video/mp4')
  assert.equal(sniffMedia(mp4('qt  '), '')?.mime, 'video/quicktime')
  // A page, a script or an SVG named like a picture is not a picture.
  assert.equal(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/png'), null)
  assert.equal(sniffMedia(Buffer.from('#!/bin/sh\nrm -rf /tmp/x\n'), 'audio/webm'), null)
})

test('staging validates size and type, and names the attachment safely', () => {
  const staged = stagedAttachment({ name: '../../秘密/截图 2026:11:14?.exe', mime: 'image/png', bytes: new Uint8Array(png()) })
  assert.equal(staged.kind, 'image'); assert.equal(staged.name, '截图_2026_11_14.png'); assert.match(staged.sha256, /^[a-f0-9]{64}$/)
  assert.equal(attachmentName('....', 'png'), 'file.png')
  assert.throws(() => stagedAttachment({ name: 'a.png', mime: 'image/png', bytes: new Uint8Array(Buffer.from('not a picture at all')) }), /不支持的文件类型/)
  assert.throws(() => stagedAttachment({ name: 'a.png', mime: 'image/png', bytes: new Uint8Array(0) }), /空|上限/)
  const large = new Uint8Array(ATTACHMENT_LIMITS.image + 1); large.set(png())
  assert.throws(() => stagedAttachment({ name: 'big.png', mime: 'image/png', bytes: large }), /超过大小上限（图片 20 MB）/)
  assert.throws(() => stagedAttachment({ name: 'a.png', mime: 'image/png', bytes: new Uint8Array(png()), path: '/etc/passwd' }), /Unrecognized|unrecognized/)
  assert.throws(() => stagedAttachment({ name: 'a.png', mime: 'image/png', bytes: [...png()] }), /Invalid input/)
})

function mediaHarness(overrides: Partial<CanvasMediaDependencies> = {}, ready = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>>()
  const staged: Array<{ bytes: Buffer; name: string }> = [], downloads: string[] = []
  const canvas = { root: '/vault', stageAttachment(bytes: Buffer, name: string) { staged.push({ bytes, name }); return `token-${staged.length}` },
    open: async (id: string) => { if (id !== 'board') throw new Error('identity_conflict: canvas is unavailable'); return { objectId: id, handleId: 'h', path: '项目/X.canvas', version: '', canvas: {} } },
    release() {} } as unknown as CanvasService
  const cache = { download: async (url: string) => { downloads.push(url); return { status: 'missing' as const, error: '这个地址是内网地址，没有抓取预览' } } } as unknown as CanvasMediaDependencies['cache']
  registerCanvasMediaIPC({ handle: (name, handler) => { handlers.set(name, handler as never) } }, async () => { if (!ready) throw new Error('请先配置资料库'); return { canvas } },
    () => undefined, { cache, transcriptionAvailable: () => false, ...overrides })
  const call = (name: string, input?: unknown) => handlers.get(name)!({} as IpcMainInvokeEvent, input)
  return { call, staged, downloads }
}

test('canvasMedia:stage hands validated bytes to the board service and refuses everything else', async () => {
  const h = mediaHarness()
  const ok = await h.call('canvasMedia:stage', { name: '录音.webm', mime: 'audio/webm', bytes: new Uint8Array(webm()) })
  assert.deepEqual({ ...ok, value: { ...(ok.value as object), sha256: 'x' } }, { ok: true, value: { token: 'token-1', kind: 'audio', mime: 'audio/webm', sha256: 'x', size: 64 } })
  assert.equal(h.staged[0].name, '录音.webm')
  const refused = await h.call('canvasMedia:stage', { name: 'a.html', mime: 'text/html', bytes: new Uint8Array(Buffer.from('<html><body>hello world</body></html>')) })
  assert.equal(refused.ok, false); assert.match(refused.error!, /不支持的文件类型/)
  assert.equal(h.staged.length, 1)
  // No library, no staging.
  const closed = mediaHarness({}, false)
  assert.match((await closed.call('canvasMedia:stage', { name: 'a.png', mime: 'image/png', bytes: new Uint8Array(png()) })).error!, /资料库/)
  assert.equal(closed.staged.length, 0)
})

test('canvasMedia:linkPreview resolves the board by identity and keeps the text when the cover cannot be fetched', async () => {
  const preview = { url: 'https://example.com/a', title: '标题', description: '摘要', site: 'Example', imageUrl: 'https://example.com/cover.png', fetchedAt: '2026-11-14T06:00:00.000Z' }
  const h = mediaHarness({ preview: async () => preview })
  assert.deepEqual(await h.call('canvasMedia:linkPreview', { objectId: 'board', url: 'https://example.com/a' }),
    { ok: true, value: { title: '标题', description: '摘要', site: 'Example', fetchedAt: '2026-11-14T06:00:00.000Z' } })
  assert.deepEqual(h.downloads, ['https://example.com/cover.png'])
  assert.match((await h.call('canvasMedia:linkPreview', { objectId: 'other', url: 'https://example.com/a' })).error!, /identity_conflict/)
  assert.equal((await h.call('canvasMedia:linkPreview', { objectId: 'board', url: 'https://example.com/a', path: '/tmp/x.canvas' })).ok, false)
  const failing = mediaHarness({ preview: async () => { throw new Error('这个地址是内网地址，没有抓取预览') } })
  assert.match((await failing.call('canvasMedia:linkPreview', { objectId: 'board', url: 'http://192.168.1.1/' })).error!, /内网地址/)
  assert.deepEqual(await h.call('canvasMedia:transcription'), { ok: true, value: { available: false } })
})

function intakeHost(overrides: Partial<IntakeHost> = {}) {
  const staged: Array<{ name: string; mime: string; size: number }> = [], written: CanvasCommand[][] = []
  const host: IntakeHost = { boardPath: '项目/X.canvas',
    stage: async input => { const media = stagedAttachment(input); staged.push({ name: input.name, mime: input.mime, size: input.bytes.byteLength }); return { token: `token-${staged.length}`, kind: media.kind, mime: media.mime, sha256: media.sha256, size: media.bytes.length } },
    write: async commands => { written.push(commands) },
    measure: async kind => kind === 'image' ? { width: 1200, height: 600 } : kind === 'audio' ? { durationMs: 2500.4 } : {},
    now: () => new Date('2026-11-14T06:36:00.000Z'), ...overrides }
  return { host, staged, written }
}
const file = (bytes: Buffer | string, name: string, type: string, lastModified = Date.parse('2026-11-01T00:00:00.000Z')) => new File([bytes as BlobPart], name, { type, lastModified })

test('dropped files become media cards with attachments and text cards, in one board write', async () => {
  assert.equal(intakeKind({ name: 'a.PNG', type: '' }), 'image'); assert.equal(intakeKind({ name: 'a.svg', type: 'image/svg+xml' }), null)
  assert.equal(intakeKind({ name: 'notes.md', type: '' }), 'text'); assert.equal(intakeKind({ name: 'a.pdf', type: 'application/pdf' }), null)
  const h = intakeHost()
  const result = await intakeFiles([file(png(), '封面.png', 'image/png'), file(wav(), '采访.wav', 'audio/wav'), file('# 标题\r\n\r\n正文', '笔记.md', 'text/markdown'), file('%PDF-1.7', '合同.pdf', 'application/pdf'), file(mp4(), '片段.mp4', 'video/mp4')], { x: 100.4, y: 50 }, h.host)
  assert.deepEqual(result.skipped, ['合同.pdf']); assert.equal(result.nodeIds.length, 4)
  assert.equal(h.written.length, 1)
  const [image, audio, text, video] = h.written[0]
  assert.equal(image.type, 'importAttachment'); assert.equal(text.type, 'addNode')
  if (image.type !== 'importAttachment' || audio.type !== 'importAttachment' || video.type !== 'importAttachment' || text.type !== 'addNode') throw new Error('unexpected commands')
  for (const command of [image, audio, video, text]) assert.equal(CanvasNodeSchema.safeParse(command.node).success, true, JSON.stringify(CanvasNodeSchema.safeParse(command.node).error?.issues))
  assert.deepEqual({ x: image.node.x, y: image.node.y, width: image.node.width, height: image.node.height }, { x: 100, y: 50, width: 420, height: 210 })
  assert.equal(image.node.ready.kind, 'image'); assert.equal(image.node.ready.media?.originalName, '封面.png'); assert.equal(image.node.ready.preview?.title, '封面')
  assert.equal(image.sourceToken, 'token-1')
  assert.equal(audio.node.ready.media?.durationMs, 2500); assert.equal(audio.node.ready.preview?.fetchedAt, '2026-11-01T00:00:00.000Z')
  assert.equal(audio.node.x, 100 + 420 + 24)
  assert.equal(text.node.type === 'text' && text.node.text, '# 标题\n\n正文')
  assert.equal(video.node.ready.kind, 'video'); assert.equal(video.node.height, Math.round(360 * 9 / 16))
})

test('a recording carries its measured length and time; limits and unusable drops are reported, nothing is written', async () => {
  const h = intakeHost()
  await intakeFiles([file(webm(), '录音 2026-11-14 14.36.00.webm', 'audio/webm')], { x: 0, y: 0 }, h.host, { durationMs: 7312.6, capturedAt: new Date('2026-11-14T06:36:07.000Z'), title: '录音' })
  const command = h.written[0][0]
  if (command.type !== 'importAttachment') throw new Error('expected an attachment')
  assert.deepEqual(command.node.ready.media && { mime: command.node.ready.media.mime, durationMs: command.node.ready.media.durationMs }, { mime: 'audio/webm', durationMs: 7313 })
  assert.deepEqual(command.node.ready.preview, { title: '录音', fetchedAt: '2026-11-14T06:36:07.000Z' })
  const empty = intakeHost()
  await assert.rejects(intakeFiles([file('%PDF', 'a.pdf', 'application/pdf')], { x: 0, y: 0 }, empty.host), /画板接收图片、音频、视频/)
  await assert.rejects(intakeFiles([file(Buffer.alloc(1024 * 1024 + 1, 0x61), '长文.txt', 'text/plain')], { x: 0, y: 0 }, empty.host), /超过大小上限（文本 1 MB）/)
  // Main's refusal (a renamed file) stops the whole drop before any write.
  await assert.rejects(intakeFiles([file(png(), 'a.png', 'image/png'), file('plain text pretending', 'b.png', 'image/png')], { x: 0, y: 0 }, empty.host), /不支持的文件类型/)
  assert.equal(empty.written.length, 0)
})

test('clipboard and drop transfers yield only the files they carry', async () => {
  assert.deepEqual(transferFiles(null), [])
  const dropped = file(png(), 'a.png', 'image/png')
  assert.deepEqual(transferFiles({ files: [dropped] as unknown as FileList }), [dropped])
  const pasted = await clipboardImageFiles({ read: async () => [{ types: ['text/html', 'image/png'], getType: async () => new Blob([png() as BlobPart], { type: 'image/png' }) } as unknown as ClipboardItem] }, new Date(2026, 10, 14, 14, 36, 5))
  assert.equal(pasted.length, 1); assert.equal(pasted[0].name, '粘贴的图片 2026-11-14 14.36.05.png'); assert.equal(pasted[0].type, 'image/png')
  assert.deepEqual(await clipboardImageFiles({ read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['x']) } as unknown as ClipboardItem] }), [])
  assert.deepEqual(await clipboardImageFiles({ read: async () => { throw new Error('denied') } }), [])
})

test('a link preview is asked for once per address until it is refreshed', async () => {
  let calls = 0
  const previews = createLinkPreviews(async url => { calls++; if (url.includes('down')) throw new Error('离线'); return { title: `第 ${calls} 次` } })
  assert.deepEqual(await previews.read('https://a.example/'), { title: '第 1 次' })
  assert.deepEqual(await previews.read('https://a.example/'), { title: '第 1 次' })
  await assert.rejects(previews.read('https://down.example/'), /离线/); await assert.rejects(previews.read('https://down.example/'), /离线/)
  assert.equal(calls, 2)
  assert.deepEqual(await previews.refresh('https://a.example/'), { title: '第 3 次' })
  assert.deepEqual(await previews.read('https://a.example/'), { title: '第 3 次' })
})

test('waveform peaks, slideshow order and stored crops', () => {
  assert.deepEqual(peaksOf(Float32Array.from([0, .25, -.5, .1, 0, 0, -1, .2]), 4), [.25, .5, 0, 1])
  assert.deepEqual(peaksOf(new Float32Array(8), 4), [0, 0, 0, 0])
  const image = (id: string, x: number, y: number, extra: object = {}) => ({ id, type: 'file' as const, file: `X.assets/${id}.png`, x, y, width: 100, height: 100, ready: { kind: 'image' as const, preview: { title: id }, ...extra } })
  const canvas: ReadyCanvas = { ready: { schemaVersion: 1, id: 'board' }, edges: [], nodes: [image('low', 0, 420), image('right', 400, 30), image('left', 0, 60),
    image('gone', 0, 0, { trash: { operationId: 'op', deletedAt: '2026-11-14T00:00:00.000Z' } }), { id: 'note', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10, ready: { kind: 'text' } }] }
  assert.deepEqual(boardSlides(canvas, path => `local-file:///v/${path}`).map(slide => slide.id), ['left', 'right', 'low'])
  assert.deepEqual(boardSlides(canvas, () => undefined), [])
  assert.deepEqual(cropStyle({ mode: 'position', x: 20, y: 80 }), { objectPosition: '20% 80%' })
  assert.deepEqual(cropStyle({ mode: 'rect', x: .25, y: .5, w: .5, h: .25 }), { position: 'absolute', maxWidth: 'none', width: '200%', height: '400%', left: '-50%', top: '-200%', objectFit: 'fill' })
})
