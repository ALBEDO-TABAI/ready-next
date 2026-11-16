import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canvasFixture } from './utils/canvas-fixture'
import { png } from './utils/media-fixture'
import { STAGING_TTL_MS } from '../main/modules/board-engine/attachment-staging'
import { registerCanvasMediaIPC, type StagedAttachmentReceipt } from '../main/modules/board-engine/media-ipc'
import { FastCardMediaCache } from '../main/modules/fastcard/media-cache'
import type { CanvasNode, NodeReady } from '../shared/ready-canvas'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
function mediaIPC(f: ReturnType<typeof canvasFixture>, cache: FastCardMediaCache) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  registerCanvasMediaIPC({ handle: (name, handler) => { handlers.set(name, handler as never) } }, async () => ({ canvas: f.service }), () => undefined, {
    cache,
    preview: async url => ({ url, title: '示例文章', description: '一句摘要', site: 'Example', imageUrl: 'https://example.com/cover.png', fetchedAt: '2026-11-14T06:00:00.000Z' }),
  })
  return <T,>(name: string, input?: unknown) => handlers.get(name)!({} as IpcMainInvokeEvent, input) as Promise<Reply<T>>
}
const mediaNode = (id: string, staged: StagedAttachmentReceipt, extra: object = {}): CanvasNode => ({ id, type: 'file', file: 'Media.assets/pending', x: 0, y: 0, width: 300, height: 132,
  ready: { kind: staged.kind, media: { mime: staged.mime, sha256: staged.sha256, originalName: 'memo', ...extra }, preview: { title: '录音', fetchedAt: '2026-11-14T06:36:00.000Z' } } })

test('staged bytes become a board attachment in the vault through the board handle; a token is used once and expires', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas media attachments')) return
  const f = canvasFixture(), userData = mkdtempSync(join(tmpdir(), 'ready-canvas-media-'))
  try {
    const call = mediaIPC(f, new FastCardMediaCache(userData))
    const h = await f.service.create({ path: 'Media.canvas', operationId: 'create' })
    const sound = Buffer.alloc(4096, 7); Buffer.from('1a45dfa3', 'hex').copy(sound)
    const staged = await call<StagedAttachmentReceipt>('canvasMedia:stage', { name: '录音 2026-11-14 14.36.00.webm', mime: 'audio/webm;codecs=opus', bytes: new Uint8Array(sound) })
    assert.ok(staged.ok); if (!staged.ok) return
    assert.deepEqual({ kind: staged.value.kind, mime: staged.value.mime, size: staged.value.size }, { kind: 'audio', mime: 'audio/webm', size: 4096 })
    const receipt = await f.service.write({ ...h, expectedVersion: h.version, operationId: 'voice', commands: [{ type: 'importAttachment', sourceToken: staged.value.token, node: mediaNode('voice', staged.value, { durationMs: 7300 }) }] })
    assert.equal(receipt.state, 'completed')
    const saved = JSON.parse(readFileSync(join(f.root, 'Media.canvas'), 'utf8')).nodes[0]
    assert.equal(saved.file, `Media.assets/${staged.value.sha256}-录音_2026-11-14_14_36_00.webm`)
    assert.deepEqual(readFileSync(join(f.root, saved.file)), sound)
    assert.deepEqual(saved.ready.media, { mime: 'audio/webm', sha256: staged.value.sha256, originalName: 'memo', durationMs: 7300 })
    assert.deepEqual(receipt.state === 'completed' && receipt.attachments, [{ path: saved.file, sha256: staged.value.sha256, verified: true }])
    // The same token cannot place a second card: staged bytes leave memory with their write.
    const again = await f.service.read(h.handleId)
    await assert.rejects(f.service.write({ ...again, expectedVersion: again.version, operationId: 'reuse', commands: [{ type: 'importAttachment', sourceToken: staged.value.token, node: mediaNode('twice', staged.value) }] }), /Attachment token unavailable/)
    // A card whose declared hash is not the staged file's is refused; the board file stays as it was.
    const other = await call<StagedAttachmentReceipt>('canvasMedia:stage', { name: 'a.png', mime: 'image/png', bytes: new Uint8Array(png()) })
    assert.ok(other.ok); if (!other.ok) return
    const forged = await f.service.write({ ...again, expectedVersion: again.version, operationId: 'forged', commands: [{ type: 'importAttachment', sourceToken: other.value.token, node: mediaNode('forged', { ...other.value, sha256: 'f'.repeat(64) }) }] })
    assert.notEqual(forged.state, 'completed')
    assert.equal(JSON.parse(readFileSync(join(f.root, 'Media.canvas'), 'utf8')).nodes.length, 1)
    // Bytes nobody wrote within ten minutes are dropped; waiting bytes are capped in total.
    const stale = f.service.stageAttachment(png(), 'stale.png'), realNow = Date.now
    try {
      Date.now = () => realNow() + STAGING_TTL_MS + 1000
      const fresh = f.service.stageAttachment(png(), 'fresh.png')
      const latest = await f.service.read(h.handleId), node = (id: string): CanvasNode => ({ id, type: 'file', file: 'Media.assets/pending', x: 0, y: 0, width: 10, height: 10, ready: { kind: 'image' } })
      await assert.rejects(f.service.write({ ...latest, expectedVersion: latest.version, operationId: 'stale', commands: [{ type: 'importAttachment', sourceToken: stale, node: node('stale') }] }), /Attachment token unavailable/)
      assert.equal((await f.service.write({ ...latest, expectedVersion: latest.version, operationId: 'fresh', commands: [{ type: 'importAttachment', sourceToken: fresh, node: node('fresh') }] })).state, 'completed')
    } finally { Date.now = realNow }
    const big = Buffer.alloc(50 * 1024 * 1024)
    for (let i = 0; i < 5; i++) f.service.stageAttachment(big, `big-${i}.mp4`)
    assert.throws(() => f.service.stageAttachment(big, 'big-5.mp4'), /等待写入画板的文件过多/)
  } finally { f.close(); rmSync(userData, { recursive: true, force: true }) }
})

test('a link preview is kept on the card with its cover copied into the board attachments', async t => {
  if (skipIfSqliteUnavailable(t, 'canvas link previews')) return
  const f = canvasFixture(), userData = mkdtempSync(join(tmpdir(), 'ready-canvas-media-'))
  try {
    const cover = png(8, 4), requested: string[] = []
    const call = mediaIPC(f, new FastCardMediaCache(userData, async url => { requested.push(url); return { url, type: 'image/png', body: cover } }))
    const link: CanvasNode = { id: 'link', type: 'link', url: 'https://example.com/post', x: 0, y: 0, width: 260, height: 195, ready: { kind: 'link' } }
    const h = await f.service.create({ path: '项目/Links.canvas', operationId: 'create', canvas: { nodes: [link], edges: [], ready: { schemaVersion: 1, id: 'links' } } })
    const preview = await call<NonNullable<NodeReady['preview']>>('canvasMedia:linkPreview', { objectId: 'links', url: link.url })
    assert.ok(preview.ok); if (!preview.ok) return
    assert.deepEqual(requested, ['https://example.com/cover.png'])
    assert.deepEqual({ ...preview.value, image: undefined }, { title: '示例文章', description: '一句摘要', site: 'Example', fetchedAt: '2026-11-14T06:00:00.000Z', image: undefined })
    assert.match(preview.value.image ?? '', /^项目\/Links\.assets\/[a-f0-9]{64}\.png$/)
    assert.deepEqual(readFileSync(join(f.root, preview.value.image!)), cover)
    // The renderer stores it with an ordinary board write; the attachment is verified at its final place.
    const receipt = await f.service.write({ ...h, expectedVersion: h.version, operationId: 'keep-preview', commands: [{ type: 'replaceNode', node: { ...link, ready: { kind: 'link', preview: preview.value } } }] })
    assert.equal(receipt.state, 'completed')
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, '项目/Links.canvas'), 'utf8')).nodes[0].ready.preview, preview.value)
    // A cover that cannot be had costs only the cover; a board that is not this library's gets nothing.
    const blocked = mediaIPC(f, new FastCardMediaCache(userData, async () => { throw new Error('这个地址是内网地址，没有抓取预览') }))
    assert.deepEqual(await blocked('canvasMedia:linkPreview', { objectId: 'links', url: link.url }), { ok: true, value: { title: '示例文章', description: '一句摘要', site: 'Example', fetchedAt: '2026-11-14T06:00:00.000Z' } })
    assert.equal((await call('canvasMedia:linkPreview', { objectId: 'missing', url: link.url })).ok, false)
    assert.equal(readdirSync(join(f.root, '项目/Links.assets')).length, 1)
    assert.equal(existsSync(join(f.root, 'missing.assets')), false)
  } finally { f.close(); rmSync(userData, { recursive: true, force: true }) }
})
