import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { sourceIndexGroup, type SourceIndexGroupDeps } from '../main/modules/search-engine/ipc/source-index-group'
import { watcherGroup, type WatcherGroupDeps } from '../main/modules/search-engine/ipc/watcher-group'
import {
  FileWatcherRegistry,
  type FileWatcherChange,
  type FileWatcherOptions,
} from '../main/modules/search-engine/file-watcher'
import type {
  DocumentIndexChangedEvent,
  DocumentWatcherFailedEvent,
} from '../shared/document-index-events'

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

function registerHandlers(register: (ipc: IpcMain) => void): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  register({
    handle(channel: string, handler: Handler) { handlers.set(channel, handler) },
    removeHandler() {},
  } as unknown as IpcMain)
  return handlers
}

function eventCapture(): {
  event: IpcMainInvokeEvent
  sent: DocumentIndexChangedEvent[]
  watcherFailures: DocumentWatcherFailedEvent[]
} {
  const sent: DocumentIndexChangedEvent[] = []
  const watcherFailures: DocumentWatcherFailedEvent[] = []
  const event = {
    sender: {
      isDestroyed: () => false,
      send(channel: string, payload: DocumentIndexChangedEvent | DocumentWatcherFailedEvent) {
        if (channel === 'document:indexChanged') sent.push(payload as DocumentIndexChangedEvent)
        if (channel === 'document:watcherFailed') watcherFailures.push(payload as DocumentWatcherFailedEvent)
      },
    },
  } as unknown as IpcMainInvokeEvent
  return { event, sent, watcherFailures }
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

test('watcher publishes only after add/change/unlink has reached the index', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Watcher object settlement')) return
  const f = fixture()
  t.after(() => f.close())
  let onChange: FileWatcherOptions['onChange'] | undefined
  const deps = {
    getSearchEngine: () => f.engine,
    createFileWatcher: async (options: FileWatcherOptions) => {
      onChange = options.onChange
      return { id: 'watch-1', workspaceRoot: options.workspaceRoot, isClosed: () => false, onFatalError: () => () => {}, close: async () => undefined }
    },
    getFileWatcherRegistry: () => new FileWatcherRegistry(),
  } satisfies WatcherGroupDeps
  const handlers = registerHandlers((ipc) => { watcherGroup.register(ipc, deps) })
  const capture = eventCapture()
  const path = join(f.root, 'new.md')
  const readBody = () => f.db.prepare('SELECT f.body FROM documents d JOIN documents_fts f ON f.rowid=d.id WHERE d.path=?').get<{ body: string }>(path)?.body
  const publishedBodies: Array<string | undefined> = []
  const send = capture.event.sender.send.bind(capture.event.sender)
  capture.event.sender.send = (channel, payload) => {
    publishedBodies.push(readBody())
    send(channel, payload)
  }
  await handlers.get('document:startWatcher')!(capture.event, { workspaceRoot: f.root } as never)
  assert.ok(onChange)
  writeFileSync(path, '# Added')
  const added = onChange({ filePath: path, kind: 'add', workspaceRoot: f.root })
  assert.deepEqual(capture.sent, [], 'no publication while the event window is pending')
  await added
  writeFileSync(path, '# Changed')
  await onChange({ filePath: path, kind: 'change', workspaceRoot: f.root })
  unlinkSync(path)
  await onChange({ filePath: path, kind: 'unlink', workspaceRoot: f.root })

  assert.deepEqual(publishedBodies, ['# Added', '# Changed', undefined])
  assert.deepEqual(capture.sent.map((item) => item.changedPaths), [[path], [path], [path]])
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

test('watcher does not publish when incremental indexing reports failure', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Watcher object settlement')) return
  const f = fixture()
  t.after(() => f.close())
  const path = join(f.root, 'broken.md')
  writeFileSync(path, '# Broken')
  t.mock.method(f.engine, 'indexDocument', async () => ({ ok: false, error: 'not indexed' }))
  let onChange: ((change: FileWatcherChange) => void | Promise<void>) | null = null
  const deps = {
    getSearchEngine: () => f.engine,
    createFileWatcher: async (options: FileWatcherOptions) => {
      onChange = options.onChange
      return { id: 'watch-2', workspaceRoot: options.workspaceRoot, close: async () => undefined }
    },
    getFileWatcherRegistry: () => ({ add: () => true, stop: async () => true }),
  } as unknown as WatcherGroupDeps
  const handlers = registerHandlers((ipc) => { watcherGroup.register(ipc, deps) })
  const capture = eventCapture()

  await handlers.get('document:startWatcher')!(capture.event, { workspaceRoot: f.root } as never)
  assert.ok(onChange)
  await assert.rejects(async () => onChange!({ filePath: path, kind: 'change', workspaceRoot: f.root }), /not indexed/)

  assert.deepEqual(capture.sent, [])
})

test('watcher runtime failure removes the registry entry and notifies the renderer', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Watcher object settlement')) return
  const f = fixture()
  t.after(() => f.close())
  let fatalCallback: ((event: DocumentWatcherFailedEvent) => void) | null = null
  let closed = false
  const registry = new FileWatcherRegistry()
  const deps = {
    getSearchEngine: () => f.engine,
    createFileWatcher: async (options: FileWatcherOptions) => ({
      id: 'watch-runtime-failure',
      workspaceRoot: options.workspaceRoot,
      isClosed: () => closed,
      onFatalError: (callback: (event: DocumentWatcherFailedEvent) => void) => {
        fatalCallback = callback
        return () => { fatalCallback = null }
      },
      close: async () => { closed = true },
    }),
    getFileWatcherRegistry: () => registry,
  } as unknown as WatcherGroupDeps
  const handlers = registerHandlers((ipc) => { watcherGroup.register(ipc, deps) })
  const capture = eventCapture()

  const response = await handlers.get('document:startWatcher')!(
    capture.event,
    { workspaceRoot: '/workspace' } as never,
  ) as { success: boolean; data?: { watcherId: string } }
  assert.equal(response.success, true)
  assert.equal(registry.has('watch-runtime-failure'), true)
  assert.ok(fatalCallback)

  closed = true
  fatalCallback!({
    watcherId: 'watch-runtime-failure',
    workspaceRoot: '/workspace',
    kind: 'failed',
    message: 'native watcher stopped',
    failedAt: 123,
  })

  assert.equal(registry.has('watch-runtime-failure'), false)
  assert.deepEqual(capture.watcherFailures, [{
    watcherId: 'watch-runtime-failure',
    workspaceRoot: '/workspace',
    kind: 'failed',
    message: 'native watcher stopped',
    failedAt: 123,
  }])
})

test('no-change rebuild, skipped indexing, and missing unlink do not invalidate the graph', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Watcher object settlement')) return
  const f = fixture()
  t.after(() => f.close())
  const path = join(f.root, 'same.md')
  writeFileSync(path, '# Same')
  assert.equal((await f.engine.indexDocument(f.root, path)).ok, true)
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
    getSearchEngine: () => f.engine,
    createFileWatcher: async (options: FileWatcherOptions) => {
      onChange = options.onChange
      return { id: 'watch-no-change', workspaceRoot: options.workspaceRoot, close: async () => undefined }
    },
    getFileWatcherRegistry: () => ({ add: () => true, stop: async () => true }),
  } as unknown as WatcherGroupDeps
  const watcherHandlers = registerHandlers((ipc) => { watcherGroup.register(ipc, watcherDeps) })
  const watcherCapture = eventCapture()
  await watcherHandlers.get('document:startWatcher')!(watcherCapture.event, { workspaceRoot: f.root } as never)
  await onChange!({ filePath: path, kind: 'change', workspaceRoot: f.root })
  await onChange!({ filePath: join(f.root, 'missing.md'), kind: 'unlink', workspaceRoot: f.root })
  assert.deepEqual(watcherCapture.sent, [])
})
