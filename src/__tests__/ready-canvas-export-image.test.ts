import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent, Rectangle, WebContents } from 'electron'
import { registerCanvasImageExportIPC, type CanvasImageExportDeps } from '../main/modules/board-engine/export-image'
import type { CanvasExportImageResult } from '../shared/ready-canvas/export-image'

function harness(overrides: Partial<CanvasImageExportDeps> = {}) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const captures: Rectangle[] = [], dialogs: string[] = []
  const sender = { capturePage: async (rect: Rectangle) => {
    captures.push(rect)
    return { isEmpty: () => false, toPNG: () => Buffer.from('PNG screenshot') }
  } } as unknown as WebContents
  registerCanvasImageExportIPC({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    contentSize: actual => { assert.equal(actual, sender); return [800, 600] },
    showSaveDialog: async (actual, request) => { assert.equal(actual, sender); dialogs.push(request.defaultPath); return { canceled: true } },
    getFallbackExportDir: () => '/export-home', ...overrides,
  })
  return { captures, dialogs, handlers, sender,
    call: (input: unknown, source = sender) => handlers.get('canvas:exportImage')!({ sender: source } as IpcMainInvokeEvent, input) as Promise<CanvasExportImageResult> }
}
const rect = { x: 10, y: 20, width: 100, height: 50 }

test('PNG IPC clips and rounds the rectangle, snapshots the sender before the dialog, and reports cancellation', async () => {
  const h = harness()
  assert.deepEqual([...h.handlers.keys()], ['canvas:exportImage'])
  assert.deepEqual(await h.call({ rect: { x: -10.5, y: 550.4, width: 900, height: 100 }, suggestedName: '我的画板.png' }), { success: false, canceled: true })
  assert.deepEqual(h.captures, [{ x: 0, y: 550, width: 800, height: 50 }])
  assert.deepEqual(h.dialogs, ['/export-home/我的画板.png'])
  const order: string[] = []
  const other = { capturePage: async () => { order.push('capture'); return { isEmpty: () => false, toPNG: () => Buffer.from('other') } } } as unknown as WebContents
  const multi = harness({ contentSize: actual => { assert.equal(actual, other); return [300, 200] },
    showSaveDialog: async actual => { assert.equal(actual, other); order.push('dialog'); return { canceled: true } } })
  await multi.call({ rect }, other)
  assert.deepEqual(order, ['capture', 'dialog'])
  assert.deepEqual(multi.captures, [], 'another sender is never captured')
})

test('invalid or non-intersecting rectangles never capture or open the dialog', async () => {
  const h = harness()
  for (const invalid of [null, {}, { rect: { ...rect, x: NaN } }, { rect: { ...rect, y: Infinity } },
    { rect: { ...rect, width: 0 } }, { rect: { ...rect, height: -1 } }, { rect: { ...rect, width: Infinity } },
    { rect: { ...rect, x: 800 } }, { rect: { ...rect, y: -1000 } }]) {
    const result = await h.call(invalid)
    assert.equal(result.success, false)
    assert.ok('error' in result); assert.match(result.error, /截图区域/)
  }
  assert.deepEqual(h.captures, []); assert.deepEqual(h.dialogs, [])
})

test('PNG writes the snapshot to the selected file and reports write failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-export-'))
  try {
    const path = join(root, 'out.png')
    const h = harness({ showSaveDialog: async () => ({ canceled: false, filePath: path }) })
    assert.deepEqual(await h.call({ rect }), { success: true, path })
    assert.equal(readFileSync(path, 'utf8'), 'PNG screenshot')
    const failing = harness({ showSaveDialog: async () => ({ canceled: false, filePath: join(root, 'missing', 'out.png') }) })
    const result = await failing.call({ rect })
    assert.equal(result.success, false)
    assert.ok('error' in result); assert.match(result.error, /画板导出失败.*ENOENT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unavailable window and capture failures return errors without opening the dialog', async () => {
  const closed = harness({ contentSize: () => { throw new Error('发起导出的窗口已不可用') } })
  assert.deepEqual(await closed.call({ rect }), { success: false, error: '画板导出失败：发起导出的窗口已不可用' })
  const failed = { capturePage: async () => { throw new Error('capture failed') } } as unknown as WebContents
  const capturing = harness({ contentSize: () => [800, 600] })
  assert.deepEqual(await capturing.call({ rect }, failed), { success: false, error: '画板导出失败：capture failed' })
  assert.deepEqual(capturing.dialogs, []); assert.deepEqual(closed.dialogs, [])
})
