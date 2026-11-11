import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { registerHooks } from 'node:module'
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { subscribeObjectMoves } from '../main/modules/object-service/events'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { configureDocumentWriteService } from '../main/modules/document-engine/document-write-service'
import { writeDocumentEditableText } from '../main/modules/document-engine/document-editable-text'
import { refreshCleanDocumentTabsFromDisk } from '../renderer/modules/document/documentExternalRefresh'
import { createDocumentOperationSync } from '../renderer/modules/document/documentOperationSync'
import type { DocumentPagesAPI } from '../shared/document-pages'
import type { ObjectPresentationAPI } from '../shared/object-identity'

// Real components, stores, page/draft services, SQLite and disposable files.
// IPC, indexing and browser geometry are the only adapters; no production data.
test('M3: create, header edit, shared block/source history, save, child draft and object navigation', async t => {
  if (skipIfSqliteUnavailable(t, 'M3 integration (Electron)')) return
  const f = await editorFixture(t, '正文')
  const previousResize = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} disconnect() {} }, configurable: true })
  t.after(() => { if (previousResize) Object.defineProperty(globalThis, 'ResizeObserver', previousResize); else Reflect.deleteProperty(globalThis, 'ResizeObserver') })
  const previousEvent = globalThis.CustomEvent
  Object.defineProperty(globalThis, 'CustomEvent', { value: f.dom.window.CustomEvent, configurable: true, writable: true })
  t.after(() => { globalThis.CustomEvent = previousEvent })
  const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) } })
  t.after(() => css.deregister())
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-m3-integration-')))
  const db = new Database(':memory:'); runMigrations(db)
  const registry = new ObjectRegistry(db)
  const pages = new DocumentPageService(registry, { index: async () => {} })
  const service = new DocumentDraftService(db, { registry, index: async () => {} })
  const runtime = await import('../renderer/modules/document/drafts/runtime')
  const { useDocTabs, settleDocTabObjects } = await import('../renderer/stores/useDocTabs')
  const { useVault } = await import('../renderer/stores/useVault')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { PageDocumentEditor } = await import('../renderer/modules/document/page-ui/PageDocumentEditor')
  const { InkSidebar } = await import('../renderer/modules/document/ink/InkSidebar')
  const { OverlayHost } = await import('../renderer/modules/document/ink/overlay')
  const { DraftControls } = await import('../renderer/modules/document/drafts/DraftControls')
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  const { runRegisteredDocumentSave } = await import('../renderer/modules/document/documentSaveRegistry')
  const { MemoryRouter } = await import('react-router-dom')
  const ok = <T,>(value: T) => ({ ok: true as const, value })
  const api: DocumentPagesAPI = {
    tree: async root => ok(pages.tree(root)), properties: async id => ok(pages.properties(id)),
    patchProperties: async (...args) => ok(await pages.patchProperties(...args)), operate: async input => ok(await pages.operate(input)),
    operation: async id => ok(pages.operation(id)), trash: async root => ok(pages.trash(root)),
    order: async (...args) => ok(pages.order(...args)), favorite: async (...args) => ok(pages.favorite(...args)),
    visit: async id => ok(pages.visit(id)), states: async () => ok(pages.states()), save: async input => ok(await pages.save(input)),
    onChanged: listener => pages.subscribe(listener),
  }
  const locate = (id: string) => { const row = registry.get(id); return row?.current_path ? { objectId: id, path: row.current_path, revision: row.revision } : null }
  const objects: ObjectPresentationAPI = {
    resolvePath: async path => locate(registry.register(path).id)!, locate: async id => locate(id),
    onMoved: listener => subscribeObjectMoves(db, listener),
    prepareMigration: async request => ({ migrationId: request.migrationId, state: 'prepared', resolved: [], unresolved: [] }),
    completeMigration: async migrationId => ({ migrationId, state: 'completed', resolved: [], unresolved: [] }),
  }
  runtime.configureDrafts({
    api: () => ({ create: async input => ok(service.create(input)), save: async (...args) => ok(service.save(...args)),
      read: async id => ok(service.read(id)), list: async id => ok(service.list(directory, id)), discard: async (...args) => ok(service.discard(...args)),
      finalize: async (...args) => ok(await service.finalize(...args)), importLegacy: async items => ok(service.importLegacy(directory, items)) }),
    tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
    root: async () => directory, locate: async id => registry.get(id)!.current_path!, resolve: async path => registry.register(path).id,
    read: async path => readFileSync(path, 'utf8'),
  })
  configureDocumentWriteService({ index: async () => {}, tabs: createDocumentOperationSync({
    tabs: () => useDocTabs.getState().tabs.flatMap(tab => tab.path ? [{ ...tab, path: tab.path }] : []),
    replace: tab => { useDocTabs.getState().hydrateTabContentFromDisk(tab.id, tab.content) },
  }) })
  Object.assign(window, { electronAPI: { navigationHistory: memoryNavigationAPI(), documentPages: api, objects, vault: {
    get: async () => ({ status: 'ready', root: directory, defaultSuggestion: directory }), onChanged: () => () => {},
  }, document: { listFiles: async () => ({ success: true, items: [] }), readFile: async (path: string) => ({ success: true, content: readFileSync(path, 'utf8') }), writeFile: writeDocumentEditableText } } })
  t.after(async () => { configureDocumentWriteService(null); db.close(); rmSync(directory, { recursive: true, force: true }) })
  await act(async () => {
    useDocTabs.setState({ tabs: [], activeTabId: '', focusedPaneTabId: null, splitTabId: null })
    useWorkspace.setState({ workspaceRoot: null, pinnedFolders: [] })
    await useVault.getState().load()
    runtime.useDraftUI.setState({ boot: 'ready' })
  })
  const roots = [{ path: directory, kind: 'vault' as const }]
  function Surface({ mode = 'preview', book = false }: { mode?: 'edit' | 'preview'; book?: boolean }) {
    const tab = useDocTabs(state => state.tabs.find(item => item.id === state.activeTabId))
    return <><InkSidebar visible roots={roots} /><OverlayHost />
      <DraftControls />{tab && <PageDocumentEditor key={tab.id} tab={tab} viewMode={mode} previewEditable isSceneVisible bookReading={book} />}</>
  }
  const render = async (mode: 'edit' | 'preview' = 'preview', book = false) => { await act(async () => f.root.render(<MemoryRouter><Surface mode={mode} book={book} /></MemoryRouter>)) }
  const input = async (label: string, value: string) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(element, label)
    await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? f.dom.window.HTMLTextAreaElement.prototype : f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })) })
  }
  const click = async (label: string, scope: ParentNode = document) => {
    const element = [...scope.querySelectorAll<HTMLElement>('button, [role=menuitem]')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
    assert.ok(element, label); await act(async () => { element.click(); await new Promise(resolve => setTimeout(resolve, 120)) })
  }
  const eventually = async (check: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!check() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    assert.ok(check(), document.body.textContent || 'UI did not settle')
  }
  // The component surface does not mount DocumentMode's directory watcher. Bridge page
  // notifications to the same real disk refresh owner instead of leaving a stale buffer after rename.
  const refreshes: Promise<Set<string>>[] = []
  const inFlight = new Map<string, import('../renderer/modules/document/documentExternalRefresh').ExternalRefreshInFlightRequest>()
  const stopRefresh = pages.subscribe(() => {
    refreshes.push(refreshCleanDocumentTabsFromDisk(useDocTabs.getState().tabs, {
      readFile: async path => ({ success: true, content: readFileSync(path, 'utf8') }),
      getCurrentTab: id => useDocTabs.getState().tabs.find(tab => tab.id === id) ?? null,
      hydrateTab: useDocTabs.getState().hydrateTabContentFromDisk, inFlight,
    }))
  })
  t.after(async () => { stopRefresh(); await Promise.all(refreshes) })
  await render()
  await click(`在 ${directory.split('/').pop()} 中新建`)
  await click('页面')
  await act(async () => settleDocTabObjects())
  await render()
  const parent = useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)!
  assert.ok(document.querySelector('[aria-label="页面头部"]'))
  await click('添加图标'); await input('自定义图标', '🌱'); await click('使用')
  await input('页面标题', '改名页')
  await act(async () => { const title = document.querySelector<HTMLTextAreaElement>('[aria-label="页面标题"]')!; title.focus(); title.blur(); await new Promise(resolve => setTimeout(resolve, 120)) })
  await eventually(() => useDocTabs.getState().tabs.find(tab => tab.id === parent.id)?.path === join(directory, '改名页.md'))
  await eventually(() => { const title = document.querySelector<HTMLTextAreaElement>('[aria-label="页面标题"]'); return !!title && !title.disabled && useDocTabs.getState().tabs.find(tab => tab.id === parent.id)?.content === readFileSync(join(directory, '改名页.md'), 'utf8') })
  assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === parent.id)?.path, join(directory, '改名页.md'))
  assert.equal(pages.properties(parent.objectId!).properties.icon, '🌱')
  await eventually(() => document.querySelector('[aria-label="页面侧栏"]')!.textContent!.includes('改名页'))
  // Empty page uses the editor's real editable paragraph.
  await click('添加文字')
  const rich = document.querySelector<HTMLElement>('[contenteditable="true"]'); assert.ok(rich)
  await f.caret(rich, 0); await f.input(rich, '中文正文'); await f.blur(rich)
  const beforeSource = useDocTabs.getState().tabs.find(tab => tab.id === parent.id)!.content
  await render('edit'); assert.equal(document.querySelector('[aria-label="页面头部"]'), null)
  await input('Markdown source editor', beforeSource + '\n\n源码追加')
  await render(); assert.ok(f.rich('源码追加'))
  await f.key(f.rich('源码追加'), 'z', { metaKey: true })
  assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === parent.id)!.content, beforeSource)
  await act(async () => { assert.equal(await runRegisteredDocumentSave(parent.id), true); await runtime.drafts.flush(parent.id) })
  assert.equal(readFileSync(join(directory, '改名页.md'), 'utf8'), beforeSource)
  // Header changes first save a dirty body through the registered editor owner.
  await f.input(f.rich('中文正文'), '继续输入'); await f.blur(f.rich('继续输入'))
  await click('更换图标'); await input('自定义图标', '📚'); await click('使用')
  await eventually(() => pages.properties(parent.objectId!).properties.icon === '📚')
  assert.match(readFileSync(join(directory, '改名页.md'), 'utf8'), /继续输入/)
  assert.equal(pages.properties(parent.objectId!).properties.icon, '📚')
  await act(async () => useVault.setState({ view: { phase: 'loaded', data: { status: 'ready', root: join(directory, '别的资料库'), defaultSuggestion: directory } } }))
  assert.equal(document.querySelector('[aria-label="页面头部"]'), null, 'an external file has no page header')
  await act(async () => useVault.setState({ view: { phase: 'loaded', data: { status: 'ready', root: directory, defaultSuggestion: directory } } }))
  await render('preview', true); assert.equal(document.querySelector('[aria-label="页面头部"]'), null)
  await render(); assert.ok(document.querySelector('[aria-label="页面头部"]'))
  await act(async () => { useDocTabs.getState().openTab(join(directory, '改名页.md')); await settleDocTabObjects(); await openReadyRef({ kind: 'page', id: parent.objectId! }); await settleDocTabObjects() })
  assert.equal(useDocTabs.getState().tabs.filter(tab => tab.objectId === parent.objectId).length, 1)
  assert.equal(useDocTabs.getState().activeTabId, parent.id)
  let draftId = ''
  await act(async () => {
    draftId = useDocTabs.getState().createBackgroundTab({ title: '子稿' }); useDocTabs.getState().setActiveTab(draftId)
    useDocTabs.getState().updateTabContent(draftId, '子页正文'); await runtime.drafts.flush(draftId)
    void runtime.requestDraftSave(draftId)
  })
  const picker = document.querySelector('[aria-label="保存到…"]'); assert.ok(picker)
  await input('标题', '子稿定稿')
  await act(async () => { pages.favorite(parent.objectId!, true); await new Promise(resolve => setTimeout(resolve, 100)) })
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="标题"]')?.value, '子稿定稿', 'tree notifications preserve the open picker input')
  await click('改名页', picker.querySelector('[aria-label="保存位置"]')!); await click('确认', picker)
  const saved = useDocTabs.getState().tabs.find(tab => tab.id === draftId)!
  assert.equal(saved.path, join(directory, '改名页', '子稿定稿.md'))
  assert.match(readFileSync(saved.path!, 'utf8'), /子页正文/)
  assert.equal(pages.tree({ path: directory, kind: 'vault' }).children.find(node => node.objectId === parent.objectId)?.children[0].objectId, saved.objectId)
  assert.equal(runtime.useDraftUI.getState().saveTabId, null)
  await act(async () => { await runtime.drafts.flush(draftId); await pages.operate({ type: 'create', root: directory, parentPath: directory, operationId: 'target-page', title: '目标页' }) })
  await eventually(() => document.querySelector('[aria-label="页面侧栏"]')!.textContent!.includes('目标页'))
  const parentRow = document.querySelector(`[data-page-id="${parent.objectId}"]`); assert.ok(parentRow)
  await click('改名页 操作', parentRow); await click('移动到…', document.querySelector('[role="menu"]')!)
  const move = document.querySelector('[aria-label="移动到…"]'); assert.ok(move)
  await click('目标页', move.querySelector('[aria-label="保存位置"]')!); await click('确认', move)
  await eventually(() => useDocTabs.getState().tabs.find(tab => tab.id === parent.id)?.path === join(directory, '目标页', '改名页.md'))
  assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === draftId)?.path, join(directory, '目标页', '改名页', '子稿定稿.md'))
  await act(async () => { await openReadyRef({ kind: 'page', id: parent.objectId! }); await settleDocTabObjects() })
  await eventually(() => document.querySelector<HTMLInputElement>('[aria-label="页面标题"]')?.value === '改名页')
  assert.equal(useDocTabs.getState().activeTabId, parent.id)
  assert.equal(useDocTabs.getState().tabs.filter(tab => tab.objectId === parent.objectId).length, 1)
})
