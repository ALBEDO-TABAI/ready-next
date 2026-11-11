import { prepareFileDragRef } from '../renderer/modules/workbench/file-drag-ref'
import { beginWorkspaceDragSession } from '../renderer/components/layout/workspaceDragSession'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkspaceDragTransferPayload,
  getWorkspaceDragPaths,
  parseWorkspaceDragPayloads,
  writeWorkspaceDragData,
} from '../renderer/components/layout/fileTreeDragPayload'
import type { FileItem } from '../renderer/stores/useWorkspace'

class FakeDataTransfer {
  private readonly data = new Map<string, string>()
  effectAllowed: DataTransfer['effectAllowed'] = 'uninitialized'

  setData(format: string, value: string): void {
    this.data.set(format, value)
  }

  getData(format: string): string {
    return this.data.get(format) ?? ''
  }
}

const fileA: FileItem = {
  name: 'a.md',
  path: '/workspace/a.md',
  isDirectory: false,
  size: 10,
  modified: new Date('2026-01-01T00:00:00Z'),
}

const fileB: FileItem = {
  name: 'b.md',
  path: '/workspace/b.md',
  isDirectory: false,
  size: 12,
  modified: new Date('2026-01-01T00:00:00Z'),
}

const folder: FileItem = {
  name: 'archive',
  path: '/workspace/archive',
  isDirectory: true,
  size: 0,
  modified: new Date('2026-01-01T00:00:00Z'),
}

async function prepare() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { objects: { resolvePath: async (path: string) => ({ objectId: path.split('/').pop(), path }) } } } })
  try { await prepareFileDragRef(fileA.path); await prepareFileDragRef(fileB.path) }
  finally { Reflect.deleteProperty(globalThis, 'window') }
}

test('file tree drag writes a Ready payload for a single unselected file', async () => {
  await prepare()
  const payload = buildWorkspaceDragTransferPayload(fileA, true)
  const dataTransfer = new FakeDataTransfer()

  beginWorkspaceDragSession(payload.type === 'batch' ? payload.items : [payload])
  writeWorkspaceDragData(dataTransfer, payload)

  assert.deepEqual(getWorkspaceDragPaths(payload), ['/workspace/a.md'])
  assert.equal(dataTransfer.effectAllowed, 'copyMove')
  assert.equal(dataTransfer.getData('text/plain'), 'a.md')
  assert.equal(dataTransfer.getData('text/uri-list'), 'ready://doc/page/a.md')
  assert.deepEqual(parseWorkspaceDragPayloads(dataTransfer), [
    {
      type: 'file',
      path: '/workspace/a.md',
      name: 'a.md',
      ext: 'md',
      size: 10,
      isDirectory: false,
      movable: true,
    },
  ])
})

test('file tree drag keeps multi-selected files as a batch payload', async () => {
  await prepare()
  const payload = buildWorkspaceDragTransferPayload(fileA, true, [fileA, folder, fileB, fileA])
  const dataTransfer = new FakeDataTransfer()

  beginWorkspaceDragSession(payload.type === 'batch' ? payload.items : [payload])
  writeWorkspaceDragData(dataTransfer, payload)

  assert.deepEqual(getWorkspaceDragPaths(payload), ['/workspace/a.md', '/workspace/b.md'])
  assert.equal(dataTransfer.getData('text/plain'), 'a.md\nb.md')
  assert.deepEqual(
    parseWorkspaceDragPayloads(dataTransfer).map((item) => item.path),
    ['/workspace/a.md', '/workspace/b.md'],
  )
})
