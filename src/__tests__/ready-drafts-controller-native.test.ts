import assert from 'node:assert/strict'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { saveDocumentTabSnapshot } from '../renderer/modules/document/documentSaveRuntime'

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

// W3 M4: a mounted folder lives outside the vault. Editing a file there must autosave a draft and save back to the file.
test('Renderer to Main: a document in a mounted folder keeps its draft, restores after reopening SQLite and saves back to its own file', async t => {
  if (skipIfSqliteUnavailable(t, 'Draft controller')) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-draft-mounted-native-')))
  const vault = join(directory, 'vault'); mkdirSync(vault)
  const mounted = join(directory, 'mounted'); mkdirSync(mounted)
  const path = join(mounted, '01-style-and-craft-guide.md'); writeFileSync(path, '# Guide\n')
  let db = new Database(join(directory, 'ready.db'))
  function connect() {
    runMigrations(db)
    const registry = new ObjectRegistry(db)
    const service = new DocumentDraftService(db, { registry, index: async () => {} })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) } } as Pick<IpcMain, 'handle'>
    registerDocumentDraftIPC(ipc, service, () => ({ status: 'ready', root: vault, defaultSuggestion: vault }))
    const call = async <T,>(method: string, ...args: unknown[]): Promise<DraftResult<T>> => handlers.get(`documentDrafts:${method}`)!(null, ...args) as Promise<DraftResult<T>>
    configureDrafts({
      api: () => ({ create: input => call('create', input), save: (...args) => call('save', ...args), list: tabId => call('list', tabId), read: id => call('read', id),
        discard: (...args) => call('discard', ...args), finalize: (...args) => call('finalize', ...args), importLegacy: items => call('importLegacy', items) }),
      tabs: () => useDocTabs.getState().tabs,
      patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
      root: async () => vault, resolve: async file => registry.register(file).id,
      locate: async id => { const file = registry.get(id)?.current_path; if (!file) throw new Error('missing'); return file },
      read: async file => readFileSync(file, 'utf8'),
    })
    return service
  }
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(check())
  }
  const opened = { id: 'mounted', path, title: '01-style-and-craft-guide.md', content: '# Guide\n', isDirty: false }
  try {
    let service = connect()
    useDocTabs.setState({ tabs: [opened], activeTabId: 'mounted' })
    useDocTabs.getState().updateTabContent('mounted', '# Guide\n\nedited')
    await drafts.flush('mounted')
    assert.deepEqual(drafts.status('mounted'), { status: 'confirmed', conflict: false })
    const draftId = useDocTabs.getState().tabs[0].draftId!
    assert.equal(service.read(draftId)?.origin, 'document')
    assert.equal(readFileSync(path, 'utf8'), '# Guide\n')
    // Reopen as after a restart: the tab comes back with the disk text, the draft brings the edit back.
    db.close(); db = new Database(join(directory, 'ready.db')); service = connect()
    useDocTabs.setState({ tabs: [opened], activeTabId: 'mounted' })
    await drafts.restore()
    const tab = useDocTabs.getState().tabs[0]
    assert.equal(tab.content, '# Guide\n\nedited')
    assert.equal(drafts.status('mounted')?.conflict, false)
    // ⌘S writes the mounted file itself, then the draft is let go.
    const outcome = await saveDocumentTabSnapshot({
      tab: { id: tab.id, path, title: tab.title, content: tab.content },
      api: { writeFile: async (file, content) => { writeFileSync(file, content); return { success: true } }, saveFileAs: async () => ({ success: false }) },
      setTabPath: () => {}, renameTab: () => {},
      commitTabSaveSnapshot: (...args) => useDocTabs.getState().commitTabSaveSnapshot(...args),
    })
    assert.deepEqual(outcome, { status: 'saved', path })
    assert.equal(readFileSync(path, 'utf8'), '# Guide\n\nedited')
    await until(() => drafts.status('mounted') === undefined)
    assert.equal(service.read(draftId)?.state, 'discarded')
    assert.equal(service.list(vault).length, 0)
    assert.equal(useDocTabs.getState().tabs[0].isDirty, false)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
