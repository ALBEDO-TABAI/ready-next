import assert from 'node:assert/strict'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { registerDocumentDraftIPC } from '../main/modules/document-drafts/ipc'
import type { IpcMain } from 'electron'
import type { DraftResult } from '../shared/document-drafts'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { configureDrafts, drafts } from '../renderer/modules/document/drafts/runtime'

// Real store, IPC handlers, SQLite and finalization; only the transport and index callback are supplied.
test('Renderer to Main: interrupted finalize retries one intent, retains later input and restores after reopening SQLite', async t => {
  if (skipIfSqliteUnavailable(t, 'Draft controller')) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-draft-renderer-native-')))
  const vault = join(directory, 'vault'); mkdirSync(vault)
  let db = new Database(join(directory, 'ready.db'))
  let fail = true
  let release!: () => void; let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const signal = new Promise<void>(resolve => { started = resolve })
  function connect() {
    runMigrations(db)
    const registry = new ObjectRegistry(db)
    const service = new DocumentDraftService(db, { registry, index: async () => {}, beforePublish: async () => {
      if (fail) throw new Error('injected interruption')
      started(); await gate
    } })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) } } as Pick<IpcMain, 'handle'>
    registerDocumentDraftIPC(ipc, service, () => ({ status: 'ready', root: vault, defaultSuggestion: vault }))
    const call = async <T,>(method: string, ...args: unknown[]): Promise<DraftResult<T>> => handlers.get(`documentDrafts:${method}`)!(null, ...args) as Promise<DraftResult<T>>
    configureDrafts({
      api: () => ({ create: input => call('create', input), save: (...args) => call('save', ...args), list: tabId => call('list', tabId), read: id => call('read', id),
        discard: (...args) => call('discard', ...args), finalize: (...args) => call('finalize', ...args), importLegacy: items => call('importLegacy', items) }),
      tabs: () => useDocTabs.getState().tabs,
      patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
      root: async () => vault, resolve: async path => registry.register(path).id,
      locate: async id => { const path = registry.get(id)?.current_path; if (!path) throw new Error('missing'); return path },
      read: async path => readFileSync(path, 'utf8'),
    })
    return service
  }
  try {
    let service = connect()
    useDocTabs.setState({ tabs: [{ id: 'native', path: null, title: 'native', content: '', isDirty: false }], activeTabId: 'native' })
    useDocTabs.getState().updateTabContent('native', 'published')
    await drafts.flush('native')
    const firstId = useDocTabs.getState().tabs[0].draftId!
    await assert.rejects(drafts.finalize('native', { parentPath: vault, title: 'one', operationId: 'same-operation' }), /injected/)
    assert.equal(service.read(firstId)?.content, 'published')
    // Recover an interrupted intent into a different tab without changing its operation/revision.
    const original = service.read(firstId)!
    useDocTabs.setState({ tabs: [{ id: 'recovered', path: null, title: 'recovered', content: '', isDirty: false }] })
    await drafts.attach('recovered', original)
    assert.equal(service.read(firstId)?.tabId, 'recovered')
    assert.equal(service.read(firstId)?.revision, original.revision)
    fail = false
    const pending = drafts.finalize('recovered', { parentPath: vault, title: 'must-not-create', operationId: 'different-ui-id' })
    await signal
    useDocTabs.getState().updateTabContent('recovered', 'later typing')
    release()
    const saved = await pending
    assert.equal(saved.path, join(vault, 'one.md'))
    assert.equal(readFileSync(saved.path, 'utf8'), 'published')
    assert.deepEqual(readdirSync(vault).filter(name => name.endsWith('.md')), ['one.md'])
    const tab = useDocTabs.getState().tabs[0]
    assert.equal(tab.content, 'later typing')
    assert.equal(service.read(tab.draftId!)?.state, 'editing')
    assert.notEqual(tab.draftId, firstId)
    db.close(); db = new Database(join(directory, 'ready.db')); service = connect()
    useDocTabs.setState({ tabs: [{ ...tab, content: '', draftId: undefined, isDirty: false }] })
    await drafts.restore()
    assert.equal(useDocTabs.getState().tabs[0].content, 'later typing')
    assert.equal(service.list(vault).length, 1)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
