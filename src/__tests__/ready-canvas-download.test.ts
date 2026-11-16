import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import JSZip from 'jszip'
import { registerCanvasDownloadIPC, type CanvasDownloadDeps } from '../main/modules/board-engine/download'
import type { CanvasService } from '../main/modules/board-engine/canvas-service'
import { planBoardDownload, type CanvasDownloadResult, type CanvasNode, type DownloadBoard, type ReadyCanvas } from '../shared/ready-canvas'

const sha = 'a'.repeat(64)
const at = (index: number) => ({ x: index * 300, y: 0, width: 200, height: 150 })
const media = (id: string, index: number, file: string, kind: 'image' | 'audio' | 'video', mime: string, extra: object = {}, title?: string): CanvasNode => ({ id, type: 'file', file, ...at(index),
  ready: { kind, media: { mime, sha256: sha, ...extra }, ...(title ? { preview: { title } } : {}) } })
const text = (id: string, index: number, body: string, kind: 'text' | 'note' = 'text'): CanvasNode => ({ id, type: 'text', text: body, ...at(index), ready: { kind } })
const link = (id: string, index: number, url: string, title?: string): CanvasNode => ({ id, type: 'link', url, ...at(index), ready: { kind: 'link', ...(title ? { preview: { title } } : {}) } })
const sub = (id: string, index: number, file: string, objectId: string): CanvasNode => ({ id, type: 'file', file, ...at(index), ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: objectId } } })
const canvas = (id: string, title: string, nodes: CanvasNode[], edges: ReadyCanvas['edges'] = []): ReadyCanvas => ({ ready: { schemaVersion: 1, id, title }, nodes, edges })

const inner = canvas('inner', '更深', [text('i1', 0, '最里面的一句')])
const child = canvas('child', '素材', [
  media('c-pic', 0, '项目/X/素材.assets/h-shot.png', 'image', 'image/png', { originalName: '封面.png' }),
  link('c-link', 1, 'https://example.com/b'),
  sub('c-sub', 2, '项目/X/素材/更深.canvas', 'inner'),
])
const main = canvas('board', 'X', [
  media('pic', 0, '项目/X.assets/h1-封面.png', 'image', 'image/png', { originalName: '封面.png' }),
  media('pic2', 1, '项目/X.assets/h2-封面.png', 'image', 'image/png', { originalName: '封面.PNG' }),
  media('memo', 2, '项目/X.assets/h3-memo.webm', 'audio', 'audio/webm', { transcript: '明天把第三稿发给印厂。' }, '选题会录音'),
  media('clip', 3, '项目/X.assets/h4-clip.mp4', 'video', 'video/mp4', { originalName: 'take:1?.mov' }),
  text('t1', 4, '## 标题一行\n\n正文 **原样** 保留。  \n'),
  text('t2', 5, '- [ ] 待办：links', 'note'),
  text('empty', 6, '   '),
  link('l1', 7, 'https://example.com/a', '示例 [文章]'),
  link('l2', 8, 'https://example.org/'),
  { id: 'doc', type: 'file', file: '项目/来源.md', ...at(9), ready: { kind: 'document', ref: { kind: 'page', id: 'page-1' } } },
  { id: 'far', type: 'file', file: '别处.assets/x.png', ...at(10), ready: { kind: 'image' } },
  { id: 'shape', type: 'file', file: '项目/X.assets/s.svg', ...at(11), ready: { kind: 'graphic', graphic: { type: 'rect', fill: '#ffffff', stroke: '#000000', strokeWidth: 1 } } },
  { id: 'group', type: 'group', label: '一组', ...at(12), ready: { kind: 'group' } },
  { ...text('member', 13, '组里的卡'), ready: { kind: 'text', groupId: 'group' } },
  { ...text('gone', 14, '已回收'), ready: { kind: 'text', trash: { operationId: 'op', deletedAt: '2026-11-14T00:00:00.000Z' } } },
  sub('folder', 15, '项目/X/素材.canvas', 'child'),
  sub('lost', 16, '项目/X/不见了.canvas', 'missing'),
], [{ id: 'e1', fromNode: 't1', toNode: 't2' }])
const boards: Record<string, DownloadBoard> = { board: { path: '项目/X.canvas', canvas: main }, child: { path: '项目/X/素材.canvas', canvas: child }, inner: { path: '项目/X/素材/更深.canvas', canvas: inner } }
const childOf = (node: CanvasNode) => node.ready.ref?.kind === 'canvas' ? boards[node.ready.ref.id] : undefined

test('the plan: attachments under their real names, text as .md, links in links.md, sub-boards as folders, names made unique', () => {
  const plan = planBoardDownload(boards.board, undefined, childOf)
  assert.deepEqual(plan.entries.map(entry => entry.kind === 'asset' ? `${entry.path} ← ${entry.file}` : entry.path), [
    '封面.png ← 项目/X.assets/h1-封面.png',
    '封面 (2).png ← 项目/X.assets/h2-封面.png',
    '选题会录音.webm ← 项目/X.assets/h3-memo.webm',
    '选题会录音.md',
    'take_1_.mp4 ← 项目/X.assets/h4-clip.mp4',
    '标题一行.md', '待办：links.md', '组里的卡.md',
    '素材/封面.png ← 项目/X/素材.assets/h-shot.png',
    '素材/更深/最里面的一句.md',
    '素材/links.md',
    'links.md',
  ])
  const read = (path: string) => { const entry = plan.entries.find(item => item.path === path); return entry?.kind === 'text' ? entry.text : undefined }
  assert.equal(read('标题一行.md'), '## 标题一行\n\n正文 **原样** 保留。\n', 'Markdown as stored')
  assert.equal(read('选题会录音.md'), '# 选题会录音\n\n明天把第三稿发给印厂。\n', 'a transcript that came with the card travels with it')
  assert.equal(read('links.md'), '# 链接\n\n- [示例  文章 ](https://example.com/a)\n- [https://example.org/](https://example.org/)\n')
  assert.equal(read('素材/links.md'), '# 链接\n\n- [https://example.com/b](https://example.com/b)\n')
  assert.deepEqual(plan.folders, ['素材/', '素材/更深/'])
  // Not files of this board: a document card, a picture kept in another board's attachments, an unreadable sub-board.
  assert.deepEqual(plan.skipped, [{ nodeId: 'doc', reason: 'reference' }, { nodeId: 'far', reason: 'reference' }, { nodeId: 'lost', reason: 'unavailable' }])
})

test('a selection takes only the chosen cards; a group brings its members, a sub-board card its whole board', () => {
  assert.deepEqual(planBoardDownload(boards.board, new Set(['pic2', 'l2', 'group']), childOf).entries.map(entry => entry.path), ['封面.png', '组里的卡.md', 'links.md'])
  const folder = planBoardDownload(boards.board, new Set(['folder']), childOf)
  assert.deepEqual(folder.entries.map(entry => entry.path), ['素材/封面.png', '素材/更深/最里面的一句.md', '素材/links.md'])
  assert.deepEqual(planBoardDownload(boards.board, new Set(['gone', 'shape', 'empty']), childOf), { entries: [], folders: [], skipped: [] })
  // A sub-board that leads back to a board already being read is not followed.
  const loop: DownloadBoard = { path: 'A.canvas', canvas: canvas('a', 'A', [sub('back', 0, 'A/A.canvas', 'a'), text('x', 1, '一句')]) }
  assert.deepEqual(planBoardDownload(loop, undefined, () => loop), { entries: [{ kind: 'text', path: '一句.md', text: '一句\n' }], folders: [], skipped: [{ nodeId: 'back', reason: 'unavailable' }] })
})

function harness(overrides: Partial<CanvasDownloadDeps> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-canvas-download-'))), vault = join(root, 'vault'), out = join(root, 'out')
  mkdirSync(join(vault, '项目/X.assets'), { recursive: true }); mkdirSync(join(vault, '项目/X/素材.assets'), { recursive: true }); mkdirSync(out)
  const bytes = { one: Buffer.from('PNG one \u0000\u0001'), two: Buffer.from('PNG two'), memo: Buffer.alloc(4096, 7), clip: Buffer.from('MP4'), shot: Buffer.from('PNG shot') }
  writeFileSync(join(vault, '项目/X.assets/h1-封面.png'), bytes.one); writeFileSync(join(vault, '项目/X.assets/h2-封面.png'), bytes.two)
  writeFileSync(join(vault, '项目/X.assets/h3-memo.webm'), bytes.memo); writeFileSync(join(vault, '项目/X.assets/h4-clip.mp4'), bytes.clip)
  writeFileSync(join(vault, '项目/X/素材.assets/h-shot.png'), bytes.shot)
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<CanvasDownloadResult>>(), dialogs: Array<{ title: string; defaultPath: string }> = [], opened: string[] = [], released: string[] = []
  const service = { root: vault,
    open: async (id: string) => { const board = boards[id]; if (!board) throw new Error('identity_conflict: canvas is unavailable'); opened.push(id); return { objectId: id, handleId: `h-${opened.length}`, path: board.path, version: sha, canvas: board.canvas } },
    release: (handle: string) => { released.push(handle) } } as unknown as CanvasService
  const sender = {} as WebContents, target = join(out, '下载.zip')
  let authorized = ''
  registerCanvasDownloadIPC({ handle: (name, handler) => { handlers.set(name, handler as never) } }, async () => ({ canvas: service }), (_event, path) => { authorized = path }, {
    showSaveDialog: async (actual, request) => { assert.equal(actual, sender); dialogs.push({ title: request.title, defaultPath: request.defaultPath }); return { canceled: false, filePath: target } },
    getDefaultDir: () => '/downloads', ...overrides })
  return { vault, target, bytes, dialogs, opened, released, authorized: () => authorized, routes: () => [...handlers.keys()],
    call: (input: unknown) => handlers.get('canvas:downloadZip')!({ sender } as IpcMainInvokeEvent, input),
    async archive() { const zip = await JSZip.loadAsync(readFileSync(target)); return { zip, names: Object.keys(zip.files).sort() } },
    close: () => rmSync(root, { recursive: true, force: true }) }
}

test('canvas:downloadZip writes the archive where the person chose: original bytes, Markdown, links, a sub-board folder', async () => {
  const h = harness()
  try {
    assert.deepEqual(h.routes(), ['canvas:downloadZip'])
    const before = readFileSync(join(h.vault, '项目/X.assets/h1-封面.png'))
    const result = await h.call({ objectId: 'board', suggestedName: 'X' })
    assert.deepEqual(result, { success: true, path: h.target, fileCount: 12, skipped: 3, missing: 0 })
    assert.equal(h.authorized(), h.vault)
    assert.deepEqual(h.dialogs, [{ title: '下载为 ZIP', defaultPath: '/downloads/X.zip' }])
    assert.deepEqual(h.opened.sort(), ['board', 'child', 'inner']); assert.equal(h.released.length, 3, 'no board handle is left open')
    const { zip, names } = await h.archive()
    assert.deepEqual(names, ['links.md', 'take_1_.mp4', '封面 (2).png', '封面.png', '待办：links.md', '标题一行.md', '素材/', '素材/links.md', '素材/封面.png', '素材/更深/', '素材/更深/最里面的一句.md', '组里的卡.md', '选题会录音.md', '选题会录音.webm'])
    assert.deepEqual(await zip.file('封面.png')!.async('nodebuffer'), h.bytes.one); assert.deepEqual(await zip.file('封面 (2).png')!.async('nodebuffer'), h.bytes.two)
    assert.deepEqual(await zip.file('选题会录音.webm')!.async('nodebuffer'), h.bytes.memo); assert.deepEqual(await zip.file('素材/封面.png')!.async('nodebuffer'), h.bytes.shot)
    assert.equal(await zip.file('标题一行.md')!.async('string'), '## 标题一行\n\n正文 **原样** 保留。\n')
    assert.match(await zip.file('links.md')!.async('string'), /\(https:\/\/example\.com\/a\)/)
    assert.deepEqual(readFileSync(join(h.vault, '项目/X.assets/h1-封面.png')), before, 'the library is only read')
    // A selection: just those cards, named after the selection.
    assert.deepEqual(await h.call({ objectId: 'board', nodeIds: ['pic', 'folder'], suggestedName: 'X 选区.zip' }), { success: true, path: h.target, fileCount: 4, skipped: 0, missing: 0 })
    assert.equal(h.dialogs[1].defaultPath, '/downloads/X 选区.zip')
    assert.deepEqual((await h.archive()).names, ['封面.png', '素材/', '素材/links.md', '素材/封面.png', '素材/更深/', '素材/更深/最里面的一句.md'])
  } finally { h.close() }
})

test('canvas:downloadZip refuses before asking for a destination: too large, too many, nothing to download, unknown board, extra input', async () => {
  const h = harness({ limits: { files: 2000, bytes: 4000 } })
  try {
    const large = await h.call({ objectId: 'board' })
    assert.equal(large.success, false); assert.match((large as { error: string }).error, /共 4 KB，超过一次 4 KB 的上限；请分批选择后再下载/)
    assert.deepEqual(await h.call({ objectId: 'board', nodeIds: ['pic'] }), { success: true, path: h.target, fileCount: 1, skipped: 0, missing: 0 }, 'a smaller selection still downloads')
    const nothing = await h.call({ objectId: 'board', nodeIds: ['doc', 'shape'] })
    assert.match((nothing as { error: string }).error, /没有可下载的文件/)
    assert.match((await h.call({ objectId: 'nowhere' }) as { error: string }).error, /^下载失败：identity_conflict/)
    assert.match((await h.call({ objectId: 'board', path: '/etc/passwd' }) as { error: string }).error, /^下载失败/)
    assert.equal(h.dialogs.length, 1, 'only the download that could proceed asked where to save')
  } finally { h.close() }
  const many = harness({ limits: { files: 3, bytes: 1e9 } })
  try { assert.match((await many.call({ objectId: 'board' }) as { error: string }).error, /有 12 个，超过一次 3 个的上限/); assert.equal(existsSync(many.target), false) } finally { many.close() }
})

test('canvas:downloadZip reports cancelling, and counts attachments that are gone or are links out of the library instead of reading them', async () => {
  const cancelled = harness({ showSaveDialog: async () => ({ canceled: true }) })
  try { assert.deepEqual(await cancelled.call({ objectId: 'board' }), { success: false, canceled: true }); assert.equal(existsSync(cancelled.target), false) } finally { cancelled.close() }
  const h = harness()
  try {
    rmSync(join(h.vault, '项目/X.assets/h2-封面.png'))
    writeFileSync(join(h.vault, 'outside.txt'), 'not an attachment'); rmSync(join(h.vault, '项目/X.assets/h4-clip.mp4')); symlinkSync(join(h.vault, 'outside.txt'), join(h.vault, '项目/X.assets/h4-clip.mp4'))
    assert.deepEqual(await h.call({ objectId: 'board', nodeIds: ['pic', 'pic2', 'clip'] }), { success: true, path: h.target, fileCount: 1, skipped: 0, missing: 2 })
    assert.deepEqual((await h.archive()).names, ['封面.png'])
    const none = await h.call({ objectId: 'board', nodeIds: ['pic2'] })
    assert.match((none as { error: string }).error, /附件文件已不在资料库里/)
  } finally { h.close() }
})
