import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { sourceIndexGroup, type SourceIndexGroupDeps } from '../main/modules/search-engine/ipc/source-index-group'
import { watcherGroup, type WatcherGroupDeps } from '../main/modules/search-engine/ipc/watcher-group'
import type { FileWatcherChange, FileWatcherOptions } from '../main/modules/search-engine/file-watcher'
import type { DocumentIndexChangedEvent } from '../shared/document-index-events'

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

function registerHandlers(register: (ipc: IpcMain) => void): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  register({
    handle(channel: string, handler: Handler) { handlers.set(channel, handler) },
    removeHandler() {},
  } as unknown as IpcMain)
  return handlers
}

function eventCapture(): { event: IpcMainInvokeEvent; sent: DocumentIndexChangedEvent[] } {
  const sent: DocumentIndexChangedEvent[] = []
  const event = {
    sender: {
      isDestroyed: () => false,
      send(channel: string, payload: DocumentIndexChangedEvent) {
        if (channel === 'document:indexChanged') sent.push(payload)
      },
    },
  } as unknown as IpcMainInvokeEvent
  return { event, sent }
}

test('successful rebuild and single-document indexing publish index readback events', async () => {
  const engine = {
    indexDocument: async () => ({ ok: true, documentId: 7, skipped: false }),
  }
  const deps = {
    getSearchEngine: () => engine,
    getWorkerBridge: () => ({
      reindexWorkspace: async () => ({
        ok: true,
        root: '/workspace',
        workspaceId: 1,
        indexed: 3,
        skipped: 8,
        removed: 0,
        scanned: 11,
        elapsedMs: 15,
        degraded: false,
      }),
      reindexAllSources: async () => ({ ok: true, perSource: {}, elapsedMs: 15 }),
    }),
    validateWorkspaceRoot: () => ({ ok: true }),
    recordSearchWorkerFallback: () => undefined,
    noteSearchWorkerSuccess: () => undefined,
  } as unknown as SourceIndexGroupDeps
  const handlers = registerHandlers((ipc) => { sourceIndexGroup.register(ipc, deps) })
  const capture = eventCapture()

  await handlers.get('document:reindexWorkspace')!(capture.event, '/workspace' as never)
  await handlers.get('document:indexDocument')!(capture.event, {
    path: '/workspace/one.md',
    root: '/workspace',
  } as never)

  assert.equal(capture.sent.length, 2)
  assert.deepEqual(capture.sent.map((item) => item.reason), ['rebuild', 'incremental'])
  assert.deepEqual(capture.sent[0].changedPaths, [])
  assert.deepEqual(capture.sent[1].changedPaths, ['/workspace/one.md'])
  assert.ok(capture.sent.every((item) => item.workspaceRoot === '/workspace'))
  assert.ok(capture.sent.every((item) => Number.isFinite(item.completedAt) && item.completedAt > 0))
})

test('watcher publishes only after add/change/unlink has reached the index', async () => {
  let onChange: ((change: FileWatcherChange) => void | Promise<void>) | null = null
  const deleted: string[] = []
  const indexed: string[] = []
  const engine = {
    indexDocument: async (_root: string, path: string) => {
      indexed.push(path)
      return { ok: true, documentId: 9, skipped: false }
    },
    getRepository: () => ({
      ensureWorkspace: () => 1,
      deletePath: (_workspaceId: number, path: string) => {
        deleted.push(path)
        return 1
      },
    }),
  }
  const deps = {
    getSearchEngine: () => engine,
    createFileWatcher: async (options: FileWatcherOptions) => {
      onChange = options.onChange
      return { id: 'watch-1', workspaceRoot: options.workspaceRoot, close: async () => undefined }
    },
    getFileWatcherRegistry: () => ({ add: () => undefined, stop: async () => true }),
  } as unknown as WatcherGroupDeps
  const handlers = registerHandlers((ipc) => { watcherGroup.register(ipc, deps) })
  const capture = eventCapture()

  await handlers.get('document:startWatcher')!(capture.event, { workspaceRoot: '/workspace' } as never)
  assert.ok(onChange)
  await onChange!({ filePath: '/workspace/new.md', kind: 'add', workspaceRoot: '/workspace' })
  await onChange!({ filePath: '/workspace/gone.md', kind: 'unlink', workspaceRoot: '/workspace' })

  assert.deepEqual(indexed, ['/workspace/new.md'])
  assert.deepEqual(deleted, ['/workspace/gone.md'])
  assert.deepEqual(capture.sent.map((item) => item.changedPaths), [
    ['/workspace/new.md'],
    ['/workspace/gone.md'],
  ])
  assert.ok(capture.sent.every((item) => item.reason === 'incremental'))
})

test('failed rebuild and document indexing do not publish completion events', async () => {
  const engine = {
    indexDocument: async () => ({ ok: false, error: 'parse failed' }),
  }
  const deps = {
    getSearchEngine: () => engine,
    getWorkerBridge: () => ({
      reindexWorkspace: async () => ({
        ok: false,
        root: '/workspace',
        workspaceId: 1,
        indexed: 0,
        skipped: 0,
        removed: 0,
        scanned: 1,
        elapsedMs: 2,
        degraded: false,
        error: 'failed',
      }),
      reindexAllSources: async () => ({ ok: false, perSource: {}, elapsedMs: 2 }),
    }),
    validateWorkspaceRoot: () => ({ ok: true }),
    recordSearchWorkerFallback: () => undefined,
    noteSearchWorkerSuccess: () => undefined,
  } as unknown as SourceIndexGroupDeps
  const handlers = registerHandlers((ipc) => { sourceIndexGroup.register(ipc, deps) })
  const capture = eventCapture()

  await handlers.get('document:reindexWorkspace')!(capture.event, '/workspace' as never)
  await handlers.get('document:reindexAllSources')!(capture.event, '/workspace' as never)
  await handlers.get('document:indexDocument')!(capture.event, {
    path: '/workspace/broken.md',
    root: '/workspace',
  } as never)

  assert.deepEqual(capture.sent, [])
})

test('watcher does not publish when incremental indexing reports failure', async () => {
  let onChange: ((change: FileWatcherChange) => void | Promise<void>) | null = null
  const deps = {
    getSearchEngine: () => ({
      indexDocument: async () => ({ ok: false, error: 'not indexed' }),
    }),
    createFileWatcher: async (options: FileWatcherOptions) => {
      onChange = options.onChange
      return { id: 'watch-2', workspaceRoot: options.workspaceRoot, close: async () => undefined }
    },
    getFileWatcherRegistry: () => ({ add: () => undefined, stop: async () => true }),
  } as unknown as WatcherGroupDeps
  const handlers = registerHandlers((ipc) => { watcherGroup.register(ipc, deps) })
  const capture = eventCapture()

  await handlers.get('document:startWatcher')!(capture.event, { workspaceRoot: '/workspace' } as never)
  assert.ok(onChange)
  await onChange!({ filePath: '/workspace/broken.md', kind: 'change', workspaceRoot: '/workspace' })

  assert.deepEqual(capture.sent, [])
})

test('no-change rebuild, skipped indexing, and missing unlink do not invalidate the graph', async () => {
  const sourceEngine = {
    indexDocument: async () => ({ ok: true, documentId: 7, skipped: true }),
  }
  const sourceDeps = {
    getSearchEngine: () => sourceEngine,
    getWorkerBridge: () => ({
      reindexWorkspace: async () => ({
        ok: true,
        root: '/workspace',
        workspaceId: 1,
        indexed: 0,
        skipped: 12,
        removed: 0,
        scanned: 12,
        elapsedMs: 4,
        degraded: false,
      }),
      reindexAllSources: async () => ({ ok: true, perSource: {}, elapsedMs: 4 }),
    }),
    validateWorkspaceRoot: () => ({ ok: true }),
    recordSearchWorkerFallback: () => undefined,
    noteSearchWorkerSuccess: () => undefined,
  } as unknown as SourceIndexGroupDeps
  const sourceHandlers = registerHandlers((ipc) => { sourceIndexGroup.register(ipc, sourceDeps) })
  const sourceCapture = eventCapture()

  await sourceHandlers.get('document:reindexWorkspace')!(sourceCapture.event, '/workspace' as never)
  await sourceHandlers.get('document:indexDocument')!(sourceCapture.event, {
    path: '/workspace/same.md',
    root: '/workspace',
  } as never)
  assert.deepEqual(sourceCapture.sent, [])

  let onChange: ((change: FileWatcherChange) => void | Promise<void>) | null = null
  const watcherDeps = {
    getSearchEngine: () => ({
      indexDocument: async () => ({ ok: true, documentId: 7, skipped: true }),
      getRepository: () => ({
        ensureWorkspace: () => 1,
        deletePath: () => 0,
      }),
    }),
    createFileWatcher: async (options: FileWatcherOptions) => {
      onChange = options.onChange
      return { id: 'watch-no-change', workspaceRoot: options.workspaceRoot, close: async () => undefined }
    },
    getFileWatcherRegistry: () => ({ add: () => undefined, stop: async () => true }),
  } as unknown as WatcherGroupDeps
  const watcherHandlers = registerHandlers((ipc) => { watcherGroup.register(ipc, watcherDeps) })
  const watcherCapture = eventCapture()
  await watcherHandlers.get('document:startWatcher')!(watcherCapture.event, { workspaceRoot: '/workspace' } as never)
  await onChange!({ filePath: '/workspace/same.md', kind: 'change', workspaceRoot: '/workspace' })
  await onChange!({ filePath: '/workspace/missing.md', kind: 'unlink', workspaceRoot: '/workspace' })
  assert.deepEqual(watcherCapture.sent, [])
})
