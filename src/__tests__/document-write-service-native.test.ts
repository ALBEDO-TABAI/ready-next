import { createDraftFixture } from './helpers/ready-drafts-fixture'
import { configureDrafts } from '../renderer/modules/document/drafts/runtime'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { buildSearchIndexContentHash } from '../main/modules/search-engine/adapters'
import { applyDocumentOperation, documentVersion, type DocumentWriteDependencies } from '../main/modules/document-engine/document-write-service'
import { publishFileAtomically } from '../main/modules/document-engine/atomic-file-publish'
import { createDocumentOperationSync } from '../renderer/modules/document/documentOperationSync'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { saveDocumentTabSnapshot } from '../renderer/modules/document/documentSaveRuntime'
import { getDocumentSaveSerializationKey, runSerializedDocumentSave } from '../renderer/modules/document/documentSaveRegistry'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import type { DocumentOperation, DocumentSyncReply, DocumentSyncRequest } from '../shared/document-operations'

const require = createRequire(import.meta.url)
const append = (markdown: string): DocumentOperation => ({ type: 'appendBlock', markdown })
async function fixture(t: TestContext, dirty?: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ready-write-')))
  const path = join(root, 'note.md')
  const original = '# Note\n\noriginal\n'
  await writeFile(path, original)
  const DB = require('better-sqlite3') as new (path: string) => DatabaseConnection & MigrationDatabase
  const db = new DB(':memory:')
  runMigrations(db)
  const engine = new SearchEngine(db, { fts5Available: false })
  assert.equal((await engine.indexDocument(root, path, original)).ok, true)
  // This suite exercises the disk publisher; the separate C12 integration test uses real draft IPC/SQLite.
  const draftFixture = createDraftFixture()
  configureDrafts({ ...draftFixture.port, tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
  })
  useDocTabs.setState({ tabs: [], activeTabId: '' })
  let tabId = ''
  if (dirty !== undefined) {
    tabId = useDocTabs.getState().ensureTabForPath(path)!
    useDocTabs.getState().hydrateTabContentFromDisk(tabId, original)
    if (dirty) useDocTabs.getState().updateTabContent(tabId, original + 'unsaved\n')
  }
  const sync = createDocumentOperationSync({
    tabs: () => useDocTabs.getState().tabs.flatMap((tab) => tab.path ? [{ ...tab, path: tab.path }] : []),
    replace: (tab) => {
      if (tab.isDirty) useDocTabs.getState().updateTabContent(tab.id, tab.content)
      else useDocTabs.getState().hydrateTabContentFromDisk(tab.id, tab.content)
    },
  })
  const dependencies: DocumentWriteDependencies = {
    timeoutMs: 200,
    tabs: sync,
    index: async (_path, content) => { const result = await engine.indexDocument(root, path, content); assert.equal(result.ok, true, result.error) },
  }
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); useDocTabs.setState({ tabs: [] }) })
  return { root, path, original, db, engine, sync, dependencies, tabId,
    tab: () => useDocTabs.getState().tabs.find((tab) => tab.id === tabId)!,
    indexedHash: () => db.prepare('SELECT content_hash AS hash FROM documents WHERE path=?').get<{ hash: string }>(path)?.hash,
    apply: (operation: DocumentOperation, expectedVersion?: string) => applyDocumentOperation({ path, origin: 'test', operation, expectedVersion }, dependencies),
  }
}

test('unopened document publishes, reads back, indexes and checks the expected version', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t)
  const result = await f.apply(append('added'), documentVersion(f.original))
  assert.ok('tab' in result)
  assert.equal(result.tab, 'not_open')
  const disk = await readFile(f.path, 'utf8')
  assert.match(disk, /added/)
  assert.equal(result.beforeVersion, documentVersion(f.original))
  assert.equal(result.afterVersion, documentVersion(disk))
  assert.equal(f.indexedHash(), buildSearchIndexContentHash(disk))
  assert.ok(result.committedAt > 0)
  assert.equal((await f.apply(append('wrong'), result.beforeVersion) as { code: string }).code, 'version_conflict')
  assert.equal(await readFile(f.path, 'utf8'), disk)
})

test('clean open tab agrees with disk and search index', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, false)
  const result = await f.apply(append('external'))
  assert.ok('tab' in result)
  assert.equal(result.tab, 'synced_clean')
  assert.equal(f.tab().content, await readFile(f.path, 'utf8'))
  assert.equal(f.tab().isDirty, false)
  assert.equal(f.indexedHash(), buildSearchIndexContentHash(f.tab().content))
})

test('dirty buffer merges without writing disk and the ordinary save writes both edits', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, true)
  const before = f.tab().content
  const result = await f.apply(append('external'))
  assert.ok('tab' in result)
  assert.equal(result.tab, 'merged_dirty')
  assert.equal(result.beforeVersion, documentVersion(before))
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  assert.equal(f.indexedHash(), buildSearchIndexContentHash(f.original))
  assert.match(f.tab().content, /unsaved[\s\S]*external/)
  assert.equal(f.tab().isDirty, true)
  const save = await runSerializedDocumentSave(getDocumentSaveSerializationKey(f.tabId, f.path), () => saveDocumentTabSnapshot({
    tab: f.tab(), ...useDocTabs.getState(),
    api: {
      writeFile: async (path, content) => { await publishFileAtomically(path, content); return { success: true } },
      saveFileAs: async () => { throw new Error('Must save the existing path') },
    },
  }))
  assert.equal(save.status, 'saved')
  assert.equal(await readFile(f.path, 'utf8'), f.tab().content)
  assert.equal(f.tab().isDirty, false)
})

test('dirty replaceRange conflict and read-only publication leave both versions intact', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, true)
  const dirty = f.tab().content
  const conflict = await f.apply({ type: 'replaceRange', start: 0, end: 5, expectedText: 'wrong', replacement: 'new' })
  assert.ok('code' in conflict)
  assert.equal(conflict.code, 'dirty_conflict')
  assert.equal(f.tab().content, dirty)
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  // Start the publication case from a clean buffer; hydration cannot discard edits.
  useDocTabs.getState().markTabSaved(f.tabId)
  useDocTabs.getState().hydrateTabContentFromDisk(f.tabId, f.original)
  await chmod(f.path, 0o444)
  const failed = await f.apply(append('blocked'))
  assert.ok('code' in failed)
  assert.equal(failed.code, 'write_failed')
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  assert.equal(f.tab().content, f.original)
})

test('two concurrent operations on one path apply in order', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, false)
  const results = await Promise.all([f.apply(append('first')), f.apply(append('second'))])
  assert.ok(results.every((result) => 'tab' in result), JSON.stringify(results))
  assert.match(await readFile(f.path, 'utf8'), /original[\s\S]*first[\s\S]*second/)
  assert.equal(f.tab().content, await readFile(f.path, 'utf8'))
})

test('index failure rolls back disk, synchronized tab and index', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, false)
  const index = f.dependencies.index
  let first = true
  f.dependencies.index = async (path, content) => { await index(path, content); if (first) { first = false; throw new Error('index failure') } }
  const result = await f.apply(append('must roll back'))
  assert.ok('code' in result)
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  assert.equal(f.tab().content, f.original)
  assert.equal(f.tab().isDirty, false)
  assert.equal(f.indexedHash(), buildSearchIndexContentHash(f.original))
})

test('readback mismatch restores original file rather than leaving corrupt publication', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, false)
  f.dependencies.publish = async (path) => { await writeFile(path, 'corrupted') }
  const result = await f.apply(append('new'))
  assert.ok('code' in result)
  assert.equal(result.code, 'readback_mismatch')
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  assert.equal(f.tab().content, f.original)
})

test('late prepare and lost commit acknowledgement cannot apply after rollback', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, true)
  const before = f.tab().content
  let late: DocumentSyncRequest | undefined
  f.dependencies.timeoutMs = 20
  f.dependencies.tabs = (request) => {
    if (request.phase === 'prepare') { late = request; return new Promise<DocumentSyncReply>(() => {}) }
    return f.sync(request)
  }
  assert.ok('code' in await f.apply(append('late')))
  assert.ok(late)
  assert.equal((await f.sync(late)).ok, false)
  assert.equal(f.tab().content, before)
  f.dependencies.tabs = async (request) => {
    const result = await f.sync(request)
    return request.phase === 'commit' ? new Promise<DocumentSyncReply>(() => {}) : result
  }
  assert.ok('code' in await f.apply(append('unacknowledged')))
  assert.equal(f.tab().content, before)
  assert.equal(f.tab().isDirty, true)
  assert.equal(await readFile(f.path, 'utf8'), f.original)
})

test('closed or newly edited tabs are rejected and the disk rolls back', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, false)
  f.dependencies.publish = async (path, content) => {
    await publishFileAtomically(path, content)
    useDocTabs.getState().updateTabContent(f.tabId, f.original + 'new typing')
  }
  const result = await f.apply(append('external'))
  assert.ok('code' in result)
  assert.equal(result.code, 'dirty_conflict')
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  assert.equal(f.tab().content, f.original + 'new typing')
  f.dependencies.publish = async (path, content) => { await publishFileAtomically(path, content); useDocTabs.getState().closeTab(f.tabId) }
  // Reset this fixture explicitly before testing closure of a clean tab.
  useDocTabs.getState().markTabSaved(f.tabId)
  useDocTabs.getState().hydrateTabContentFromDisk(f.tabId, f.original)
  assert.ok('code' in await f.apply(append('closed')))
  assert.equal(await readFile(f.path, 'utf8'), f.original)
})

test('lost release acknowledgement compensates an already applied dirty buffer', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, true)
  const original = f.tab().content
  f.dependencies.timeoutMs = 20
  f.dependencies.tabs = async (request) => {
    const reply = await f.sync(request)
    return request.phase === 'release' ? new Promise<DocumentSyncReply>(() => {}) : reply
  }
  assert.ok('code' in await f.apply(append('lost reply')))
  assert.equal(f.tab().content, original)
  assert.equal(f.tab().isDirty, true)
  assert.equal(await readFile(f.path, 'utf8'), f.original)
})

test('synchronization retries do not duplicate an append and ordinary saves wait for release', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, true)
  const base = { id: 'same-operation', path: f.path, deadline: Date.now() + 1000 }
  const prepare = { ...base, phase: 'prepare' as const, operation: append('once'), diskContent: f.original }
  assert.equal((await f.sync(prepare)).ok, true)
  let saved = false
  const queuedSave = runSerializedDocumentSave(getDocumentSaveSerializationKey(f.tabId, f.path), async () => { saved = true })
  assert.equal((await f.sync(prepare)).ok, true)
  assert.equal((await f.sync({ ...base, phase: 'commit' })).ok, true)
  assert.equal((await f.sync({ ...base, phase: 'commit' })).ok, true)
  assert.equal(saved, false)
  assert.equal(f.tab().content.split('once').length - 1, 1)
  assert.equal((await f.sync({ ...base, phase: 'release' })).ok, true)
  await queuedSave
  assert.equal(saved, true)
})

test('publisher failure after replacement restores the file', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const f = await fixture(t, false)
  f.dependencies.publish = async (path, content) => { await publishFileAtomically(path, content); throw new Error('post-publish cleanup failed') }
  const result = await f.apply(append('must not remain'))
  assert.ok('code' in result)
  assert.equal(result.code, 'write_failed')
  assert.equal(await readFile(f.path, 'utf8'), f.original)
  assert.equal(f.tab().content, f.original)
})

test('closing a window after prepare cannot acknowledge a lost dirty buffer', async (t) => {
  if (skipIfSqliteUnavailable(t, 'document write service')) return
  const { createDocumentTabTransport } = await import('../main/modules/document-engine/document-write-transport')
  let present = true
  const endpoint = { id: 1, request: async (): Promise<DocumentSyncReply> => ({ ok: true, tabs: [{ id: 'tab', path: '/note.md', content: 'draft', isDirty: true }], content: 'draft\n\nnew\n' }) }
  const transport = createDocumentTabTransport(() => present ? [endpoint] : [])
  const base = { id: 'closed-window', path: '/note.md', deadline: Date.now() + 1000 }
  assert.equal((await transport({ ...base, phase: 'prepare', diskContent: 'disk', operation: append('new') })).ok, true)
  present = false
  const result = await transport({ ...base, phase: 'commit' })
  assert.equal(result.ok, false)
})
