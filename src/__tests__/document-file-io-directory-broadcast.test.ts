import assert from 'node:assert/strict'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  fileIoGroup,
  type FileIoGroupDeps,
} from '../main/modules/document-engine/ipc/file-io-group'
import { DOCUMENT_TEXT_READ_CAP_BYTES } from '../main/modules/document-engine/attachment-size-guards'
import {
  __setWebContentsProviderForTests,
  broadcastDirectoryChanged,
  flushDirectoryChangeBroadcastsForTests,
  queueDirectoryChanged,
  resetDirectoryChangeBroadcastsForTests,
} from '../main/modules/document-engine/ipc/directory-change-broadcast'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function registerHandlers(deps: FileIoGroupDeps): Map<string, HandlerFn> {
  const handlers = new Map<string, HandlerFn>()
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler() {},
  } as unknown as IpcMain
  fileIoGroup.register(ipc, deps)
  return handlers
}

function createDeps(overrides: Partial<FileIoGroupDeps> = {}): FileIoGroupDeps {
  return {
    useMock: false,
    getDocumentWriteIndexHook: () => null,
    writeDocumentEditableText: async () => ({ success: true }),
    saveDocumentWithDialog: async () => ({ success: true, path: '/tmp/ready-saved.md' }),
    resolveDialogWindow: () => null,
    getBrowserWindowFromWebContents: () => null,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showItemInFolder: async () => undefined,
    openShellPath: async () => '',
    validateWorkspaceRoot: () => ({ ok: true }),
    ...overrides,
  } as FileIoGroupDeps
}

test('document file writes broadcast directory changes for file tree refresh', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-doc-broadcast-'))
  const sent: Array<{ channel: string; payload: { paths: string[] } }> = []
  const sender = {
    id: 17,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload: payload as { paths: string[] } }),
  }
  __setWebContentsProviderForTests(() => [
    sender,
  ])
  try {
    const writePath = join(tmpRoot, 'written.md')
    const saveAsPath = join(tmpRoot, 'saved-as.md')
    const createPath = join(tmpRoot, 'created.md')
    const handlers = registerHandlers(createDeps({
      saveDocumentWithDialog: async () => ({ success: true, path: saveAsPath }),
    }))
    const event = { sender: {} } as IpcMainInvokeEvent

    await handlers.get('document:write')?.(event, { path: writePath, content: '# Written\n' })
    await handlers.get('document:saveAs')?.(event, { content: '# Saved\n', suggestedName: 'saved-as.md' })
    await handlers.get('document:createFile')?.(event, createPath)
    assert.equal(sent.length, 0, 'broadcasts are coalesced until the shared emitter flushes')
    assert.equal(flushDirectoryChangeBroadcastsForTests(), 1)

    assert.deepEqual(
      sent.map((item) => [item.channel, item.payload.paths]),
      [
        ['document:directoryChanged', [dirname(writePath)]],
      ],
    )
  } finally {
    resetDirectoryChangeBroadcastsForTests()
    __setWebContentsProviderForTests(null)
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('document text read refuses 20 MiB + 1 before allocating content and accepts the boundary', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-doc-text-guard-'))
  try {
    const oversizedPath = join(tmpRoot, 'oversized.txt')
    await writeFile(oversizedPath, '')
    await truncate(oversizedPath, DOCUMENT_TEXT_READ_CAP_BYTES + 1)

    const handlers = registerHandlers(createDeps())
    const event = { sender: {} } as IpcMainInvokeEvent
    const oversized = await handlers.get('document:read')?.(event, oversizedPath) as {
      success: boolean
      errorCode?: string
      bytes?: number
      limitBytes?: number
      content?: string
    }
    assert.equal(oversized.success, false)
    assert.equal(oversized.errorCode, 'TEXT_FILE_TOO_LARGE')
    assert.equal(oversized.bytes, DOCUMENT_TEXT_READ_CAP_BYTES + 1)
    assert.equal(oversized.limitBytes, DOCUMENT_TEXT_READ_CAP_BYTES)
    assert.equal(oversized.content, undefined)

    const boundaryPath = join(tmpRoot, 'boundary.txt')
    await writeFile(boundaryPath, Buffer.alloc(DOCUMENT_TEXT_READ_CAP_BYTES, 0x61))
    const boundary = await handlers.get('document:read')?.(event, boundaryPath) as {
      success: boolean
      content?: string
    }
    assert.equal(boundary.success, true)
    assert.equal(boundary.content?.length, DOCUMENT_TEXT_READ_CAP_BYTES)
    assert.equal(boundary.content?.charCodeAt(0), 0x61)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('destroyed renderers cancel their pending coalesced directory push', () => {
  let destroyedListener: (() => void) | null = null
  const sent: unknown[] = []
  const sender = {
    id: 91,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => sent.push(payload),
    once: (_event: 'destroyed', listener: () => void) => { destroyedListener = listener },
  }
  try {
    assert.equal(queueDirectoryChanged(sender, ['/tmp/workspace']), true)
    assert.ok(destroyedListener)
    destroyedListener?.()
    assert.equal(flushDirectoryChangeBroadcastsForTests(), 0)
    assert.deepEqual(sent, [])
  } finally {
    resetDirectoryChangeBroadcastsForTests()
  }
})

test('direct mutation and watcher notifications merge into one sender event', () => {
  const sent: Array<{ paths: string[]; timestamp: number }> = []
  const sender = {
    id: 103,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => sent.push(payload as { paths: string[]; timestamp: number }),
  }
  __setWebContentsProviderForTests(() => [sender])
  try {
    assert.equal(broadcastDirectoryChanged(['/tmp/a', '/tmp/a']), 1)
    assert.equal(queueDirectoryChanged(sender, ['/tmp/a', '/tmp/b']), true)
    assert.equal(flushDirectoryChangeBroadcastsForTests(), 1)
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].paths, ['/tmp/a', '/tmp/b'])
    assert.ok(Number.isFinite(sent[0].timestamp))
  } finally {
    resetDirectoryChangeBroadcastsForTests()
    __setWebContentsProviderForTests(null)
  }
})

test('direct directory broadcasts target the workbench renderer and exclude overlay windows', () => {
  const mainSent: unknown[] = []
  const overlaySent: unknown[] = []
  const mainRenderer = {
    id: 201,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => mainSent.push(payload),
  }
  const overlayRenderer = {
    id: 202,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => overlaySent.push(payload),
  }
  const allWindows = [mainRenderer, overlayRenderer]
  __setWebContentsProviderForTests(() => [allWindows[0]])
  try {
    assert.equal(broadcastDirectoryChanged(['/tmp/workbench-only']), 1)
    assert.equal(flushDirectoryChangeBroadcastsForTests(), 1)
    assert.equal(mainSent.length, 1)
    assert.equal(overlaySent.length, 0)
  } finally {
    resetDirectoryChangeBroadcastsForTests()
    __setWebContentsProviderForTests(null)
  }
})
