import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../main/modules/document-database/service'
import { configureDocumentWriteService } from '../main/modules/document-engine/document-write-service'
import { CalendarLayersService } from '../main/modules/calendar-layers/service'
import { LibrarySessions } from '../main/modules/calendar-layers/reading'
import { FileReadingSessionRepository } from '../main/modules/repositories/file-reading-session-repository'
import { rebuildObjectIndex } from '../main/modules/search-engine/object-index-rebuild'
import { writeDatabase } from '../shared/document-database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const range = { from: '2026-10-30', to: '2026-11-03', timeZone: 'Asia/Tokyo' }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-layers-')))
  const db = new Database(':memory:'); runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  engine.getRepository().ensureWorkspace(root)
  const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
  const dependencies = { index }; configureDocumentWriteService(dependencies)
  const pages = new DocumentPageService(registry, dependencies)
  const database = new DocumentDatabaseService(root, registry, pages, dependencies)
  const service = new CalendarLayersService(root, registry, database, dependencies, pages)
  const add = (name: string, content: string) => { const path = join(root, name); writeFileSync(path, content); return registry.register(path) }
  return { root, db, registry, engine, service, database, pages, dependencies, add, close() { configureDocumentWriteService(null); engine.cancelPendingWorkspaceResolves(); db.close(); rmSync(root, { recursive: true, force: true }) } }

}

test('C8 complete date-range projection, only selected field changes, stale writes rejected, rebuild preserves results', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar layers')) return
  const f = fixture(); t.after(() => f.close())
  f.add('库.md', writeDatabase('# 库\n', { version: 1, source: '库', fields: { due: { id: 'due-field', name: '截止', type: 'date' }, other: { id: 'other-field', name: '开始', type: 'date' } }, views: [{ id: 'all', name: '全部', type: 'table' }] }))
  mkdirSync(join(f.root, '库'))
  for (let i = 0; i < 1005; i++) f.add(`库/${i}.md`, '---\ndue: 2026-10-31\nother: 2026-11-01\n---\n正文\n')
  const page = f.add('page.md', '---\r\ndate: 2026-10-31 # keep\r\nunknown: yes\r\n---\r\n正文\r\n')
  const queryBegan = performance.now()
  let entries = f.service.query(range)
  t.diagnostic(`C8 2011-entry cold query: ${(performance.now() - queryBegan).toFixed(1)}ms`)
  const hotBegan = performance.now(); f.service.query(range); t.diagnostic(`C8 2011-entry hot query: ${(performance.now() - hotBegan).toFixed(1)}ms`)
  assert.equal(entries.filter(e => e.layer === 'documents').length, 2011)
  assert.equal(f.service.query({ ...range, from: '2026-11-02' }).length, 0)
  const row = entries.find(e => e.edit?.kind === 'database')!
  const rowPath = f.registry.get(row.objectId!)!.current_path!, before = readFileSync(rowPath, 'utf8')
  await f.service.move({ range, id: row.id, expectedVersion: row.version!, date: '2026-11-02' })
  assert.equal(readFileSync(rowPath, 'utf8'), before.replace('due: 2026-10-31', 'due: 2026-11-02'))
  await assert.rejects(f.service.move({ range, id: row.id, expectedVersion: row.version!, date: '2026-11-01' }), /version_conflict/)
  const ordinary = entries.find(e => e.objectId === page.id)!
  await f.service.move({ range, id: ordinary.id, expectedVersion: ordinary.version!, date: '2026-11-01' })
  assert.equal(readFileSync(page.current_path!, 'utf8'), '---\r\ndate: 2026-11-01 # keep\r\nunknown: yes\r\n---\r\n正文\r\n')
  entries = f.service.query(range)
  await rebuildObjectIndex(f.engine, [f.root])
  assert.deepEqual(f.service.query(range), entries)
})

test('C8 tasks use actual date links, distinguish identical tasks and preserve CRLF and identity', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar layers')) return
  const f = fixture(); t.after(() => f.close())
  const line = '- [ ] 同名 [日期](ready://calendar/day/2026-10-31?at=09:00)\r\n'
  const content = line + line + '```md\n' + line + '```\n- [ ] `ready://calendar/day/2026-10-31`\n'
  const object = f.add('tasks.md', content), tasks = f.service.query(range)
  assert.equal(tasks.length, 2)
  await f.service.move({ range, id: tasks[1].id, expectedVersion: tasks[1].version!, date: '2026-11-01' })
  assert.equal(readFileSync(object.current_path!, 'utf8'), line + line.replace('2026-10-31', '2026-11-01') + content.slice(line.length * 2))
  renameSync(object.current_path!, join(f.root, 'renamed.md')); f.registry.reconcile([object.current_path!, join(f.root, 'renamed.md')])
  assert.equal(f.service.query(range).filter(e => e.objectId === object.id).length, 2)
})

test('C8 reading sessions are durable, idempotent, read-only and split at local midnight', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar reading')) return
  const f = fixture(); t.after(() => f.close())
  const object = f.add('book.md', '# book\n'), start = Date.parse('2026-10-31T23:50:00+09:00'), end = Date.parse('2026-11-01T00:10:00+09:00')
  const reader = new LibrarySessions(f.root, f.registry)
  const request = { id: 'session-1', objectId: object.id, bookId: 'book-1', loc: 'c0:0+1', startedAt: start }
  reader.begin(request); reader.begin(request)
  reader.end({ id: request.id, endedAt: end }); reader.end({ id: request.id, endedAt: end })
  assert.throws(() => reader.begin({ ...request, bookId: 'other' }), /conflict/)
  new FileReadingSessionRepository(f.db).recordSession({ path: object.current_path!, workspaceRoot: f.root, source: 'document_mode', startedAt: start, endedAt: end, activeMs: end - start })
  const entries = f.service.query(range)
  assert.equal(entries.length, 4)
  assert.deepEqual(entries.map(e => e.date).sort(), ['2026-10-31', '2026-10-31', '2026-11-01', '2026-11-01'])
  assert.ok(entries.every(e => e.layer === 'footprints' && !e.edit))
  assert.equal(entries.reduce((sum, e) => sum + (e.end! - e.start!), 0), 2 * (end - start))
  await assert.rejects(f.service.move({ range, id: entries[0].id, expectedVersion: 'fake', date: '2026-11-02' }), /read.only/)
  assert.deepEqual(f.service.query(range), entries)
})

test('C8 external writes reach the subscribed layer through real watcher, identity and index within one second, including restart/move', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar watcher')) return
  const f = fixture()
  const { watcherGroup } = await import('../main/modules/search-engine/ipc/watcher-group')
  const { createFileWatcher, FileWatcherRegistry } = await import('../main/modules/search-engine/file-watcher')
  const object = f.add('watched.md', '---\ndate: 2026-10-31\n---\nhello\n')
  await f.engine.indexDocument(f.root, object.current_path!)
  type Handler = (event: import('electron').IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
  const handlers = new Map<string, Handler>(), watchers = new FileWatcherRegistry()
  const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) }
  const group = watcherGroup.register(ipc as unknown as import('electron').IpcMain, { getSearchEngine: () => f.engine, createFileWatcher: async options => {
    if (process.env.READY_LAYER_TEST_POLLING !== '1') return createFileWatcher(options)
    // Sandbox-only alternate backend: real chokidar watches real disk, with all production queues/index/push intact.
    const { watch } = await import('chokidar')
    return createFileWatcher({ ...options, chokidarFactory: (paths, opts) => watch(paths, { ...opts, usePolling: true, interval: 25 }) })
  }, getFileWatcherRegistry: () => watchers })
  t.after(async () => { await watchers.stopAll(); group.dispose(); f.close() })
  let changed: (() => void) | undefined
  const event = { sender: { isDestroyed: () => false, send: (channel: string) => { if (channel === 'document:indexChanged') changed?.() } } } as unknown as import('electron').IpcMainInvokeEvent
  const start = async () => { const result = await handlers.get('document:startWatcher')!(event, { workspaceRoot: f.root }); assert.ok(result && typeof result === 'object' && 'success' in result && result.success, JSON.stringify(result)) }
  await start()
  if (process.env.READY_LAYER_TEST_POLLING === '1') { t.diagnostic('Alternate real polling backend; macOS FSEvents acceptance remains required'); await new Promise(resolve => setTimeout(resolve, 200)) }
  async function external(write: () => void, expected: string) {
    let elapsed = 0
    const delivered = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No layer push within 1000ms')), 1000)
      changed = () => {
        try {
          if (!f.service.query(range).some(e => e.objectId === object.id && e.date === expected)) return
          elapsed = performance.now() - began; clearTimeout(timeout); resolve()
        } catch (error) { clearTimeout(timeout); reject(error) }
      }
    })
    write(); const began = performance.now()
    await delivered
    assert.ok(elapsed < 900, `C8 latency ${elapsed.toFixed(1)}ms; 100ms reserve below 1000ms ceiling`)
    t.diagnostic(`C8 external write → index push → layer read: ${elapsed.toFixed(1)}ms (ceiling 900ms + 100ms reserve)`)
    changed = undefined
  }
  await external(() => writeFileSync(object.current_path!, '---\ndate: 2026-11-01\n---\nhello\n'), '2026-11-01')
  await watchers.stopAll(); await start(); await new Promise(resolve => setTimeout(resolve, 200))
  const moved = join(f.root, 'moved.md')
  await external(() => { renameSync(object.current_path!, moved); writeFileSync(moved, '---\ndate: 2026-11-02\n---\nhello\n') }, '2026-11-02')
  assert.equal(f.registry.get(object.id)?.current_path, moved)
  await watchers.stopAll()
})

test('C3 layer move merges a dirty editor without claiming a disk save; range dates preserve duration across DST', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar dirty dates')) return
  const f = fixture(); t.after(() => f.close())
  const { createDocumentOperationSync } = await import('../renderer/modules/document/documentOperationSync')
  const original = '---\ndate: 2026-10-31\n---\nbody\n', object = f.add('dirty.md', original)
  let tab = { id: 'tab', path: object.current_path!, content: original + 'unsaved\n', isDirty: true }
  const tabs = createDocumentOperationSync({ tabs: () => [tab], replace: next => { tab = next } })
  const writer = { tabs, index: async (path: string) => { assert.ok((await f.engine.indexDocument(f.root, path)).ok) } }
  const service = new CalendarLayersService(f.root, f.registry, f.database, writer, f.pages)
  const entry = service.query(range)[0]
  assert.deepEqual(await service.move({ range, id: entry.id, expectedVersion: entry.version!, date: '2026-11-01' }), { state: 'unsaved' })
  assert.equal(readFileSync(object.current_path!, 'utf8'), original)
  assert.equal(tab.content, original.replace('2026-10-31', '2026-11-01') + 'unsaved\n')
  assert.equal(service.query(range)[0].date, '2026-10-31')
  const timed = f.add('range.md', '---\ndate: { start: "2026-10-31T09:00:00-04:00", end: "2026-10-31T10:00:00-04:00" }\n---\n')
  const localRange = { ...range, timeZone: 'America/New_York' }
  const duration = f.service.query(localRange).find(e => e.objectId === timed.id)!
  await f.service.move({ range: localRange, id: duration.id, expectedVersion: duration.version!, date: '2026-11-01' })
  assert.match(readFileSync(timed.current_path!, 'utf8'), /2026-11-01T09:00:00-05:00/)
  assert.match(readFileSync(timed.current_path!, 'utf8'), /2026-11-01T10:00:00-05:00/)
})

test('C8 shortened identity window still deduplicates paths and merges a burst before indexing', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar coalescing')) return
  const f = fixture(); t.after(() => f.close())
  const { ObjectEventWindow } = await import('../main/modules/object-service/event-window')
  const a = f.add('a.md', '---\ndate: 2026-10-31\n---\n'), b = f.add('b.md', '---\ndate: 2026-11-01\n---\n')
  const batches: string[][] = []
  const window = new ObjectEventWindow(f.registry, async paths => {
    batches.push(paths)
    for (const path of paths) assert.ok((await f.engine.indexDocument(f.root, path)).ok)
  })
  await Promise.all([window.add(a.current_path!), window.add(a.current_path!), window.add(b.current_path!)])
  assert.deepEqual(batches, [[a.current_path, b.current_path]])
  assert.equal(f.service.query(range).length, 2)
})

test('C8 diary drag renames through the page owner, preserves identity and rejects stale versions', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar diary rename')) return
  const f = fixture(); t.after(() => f.close())
  const diary = f.add('2026-10-31.md', '# 日记\n')
  const entry = f.service.query(range).find(e => e.objectId === diary.id)!
  await f.service.move({ range, id: entry.id, expectedVersion: entry.version!, date: '2026-11-01' })
  assert.equal(f.registry.get(diary.id)?.current_path, join(f.root, '2026-11-01.md'))
  assert.equal(f.service.query(range).find(e => e.objectId === diary.id)?.date, '2026-11-01')
  const saved = readFileSync(join(f.root, '2026-11-01.md'), 'utf8')
  await assert.rejects(f.service.move({ range, id: entry.id, expectedVersion: entry.version!, date: '2026-11-02' }), /version_conflict/)
  assert.equal(readFileSync(join(f.root, '2026-11-01.md'), 'utf8'), saved)
})

// M6-B-finish: exercise the registered handlers with the production active-vault resolver.
test('C8 registered layer handlers follow vault switches and reject old-vault moves', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar layer startup')) return
  const f = fixture(); t.after(() => f.close())
  const { createCalendarLayersResolver } = await import('../main/modules/calendar-layers/runtime')
  const { registerCalendarLayersIPC } = await import('../main/modules/calendar-layers/ipc')
  const old = f.add('old.md', '---\ndate: 2026-10-31\n---\n')
  const other = join(f.root, 'other'); mkdirSync(other)
  writeFileSync(join(other, 'new.md'), '---\ndate: 2026-11-01\n---\n')
  const newer = f.registry.register(join(other, 'new.md'))
  let activeRoot = f.root
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const resolve = createCalendarLayersResolver({ pages: f.pages, ready,
    vault: { get: () => ({ status: 'ready', root: activeRoot, defaultSuggestion: other }) }, writer: () => f.dependencies })
  const handlers = new Map<string, (event: import('electron').IpcMainInvokeEvent, input: unknown) => unknown>()
  const dispose = registerCalendarLayersIPC({ handle: (name, handler) => { handlers.set(name, handler) }, removeHandler: name => { handlers.delete(name) } }, resolve)
  t.after(dispose)
  const event = { sender: { send() {} } } as unknown as import('electron').IpcMainInvokeEvent
  const query = () => handlers.get('calendarLayers:query')!(event, range) as Promise<import('../shared/calendar-layers').LayerReply<import('../shared/calendar-layers').LayerEntry[]>>
  release()
  const before = await query(); assert.ok(before.ok)
  const entry = before.value.find(e => e.objectId === old.id)!
  activeRoot = other
  const after = await query(); assert.ok(after.ok)
  assert.deepEqual(after.value.map(e => e.objectId), [newer.id])
  const rejected = await handlers.get('calendarLayers:move')!(event, { range, id: entry.id, expectedVersion: entry.version, date: '2026-11-02' })
  assert.ok(rejected && typeof rejected === 'object' && 'ok' in rejected && !rejected.ok)
  assert.equal(readFileSync(old.current_path!, 'utf8'), '---\ndate: 2026-10-31\n---\n')
  // A request waiting on startup must resolve the vault after the barrier.
  activeRoot = f.root
  let resume!: () => void
  const pending = createCalendarLayersResolver({ pages: f.pages, ready: new Promise<void>(r => { resume = r }),
    vault: { get: () => ({ status: 'ready', root: activeRoot, defaultSuggestion: other }) }, writer: () => f.dependencies })()
  activeRoot = other; resume()
  assert.deepEqual((await pending).layers.query(range).map(e => e.objectId), [newer.id])
})
