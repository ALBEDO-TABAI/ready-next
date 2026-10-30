import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { PageSidebar } from '../renderer/modules/document/page-ui/PageSidebar'
import { PageHeader } from '../renderer/modules/document/page-ui/PageHeader'
import { SaveToPicker, type SaveToSelection } from '../renderer/modules/document/page-ui/SaveToPicker'
import { createPageTreeStore, pageRoots } from '../renderer/modules/document/page-ui/page-state'
import { mountPageUI, pageAPI, pageNode, success } from './utils/page-ui-harness'

function fixture() {
  const child = pageNode('child'); child.path = '/vault/A/child.md'
  const tree = { ...pageNode('vault', [pageNode('A', [child]), pageNode('B')], 'vault'), path: '/vault' }
  return { tree, ...pageAPI(tree) }
}

test('page operations: create child, rename, favorite, visit, move, recycle, restore conflict, permanent delete', async () => {
  const f = fixture(), ui = await mountPageUI(), saved: string[] = [], opened: string[] = []
  const row = (id: string) => { const result = ui.body.querySelector(`[data-page-id="${id}"]`); assert.ok(result); return result }
  try {
    await ui.render(<PageSidebar roots={[{ path: '/vault', kind: 'vault' }]} api={f.api} onOpen={node => { opened.push(node.objectId) }} onShowFiles={() => {}} beforeTrash={async node => { saved.push(node.objectId) }} />)
    await ui.click('新建子页面', row('A')); await ui.input('标题', '子页'); await ui.click('确认')
    const created = f.calls.at(-1)!; assert.equal(created.type, 'create'); assert.equal('parentObjectId' in created && created.parentObjectId, 'A')
    await ui.click('展开 A'); assert.match(row('A').textContent!, /子页/)
    await ui.click('改名', row('A')); await ui.input('页面名称', '新标题'); await ui.click('确认改名')
    assert.match(row('A').textContent!, /新标题/)
    await ui.click('收藏', row('A')); assert.match(ui.body.querySelector('[aria-label="收藏"]')!.textContent!, /新标题/)
    await ui.click('新标题', row('A')); assert.deepEqual(opened, ['A']); assert.match(ui.body.querySelector('[aria-label="最近"]')!.textContent!, /新标题/)
    await ui.click('移动到…', row('A')); await ui.click('B', ui.body.querySelector('[aria-label="保存位置"]')!); await ui.click('确认')
    assert.equal(f.calls.at(-1)?.type, 'move'); await ui.click('展开 B'); assert.ok(row('B').querySelector('[data-page-id="A"]'))
    await ui.click('移到回收站', row('A')); assert.deepEqual(saved, ['A']); assert.equal(ui.body.querySelector('[data-page-id="A"]'), null)
    await ui.click('回收站'); f.setRestoreConflict(); await ui.click('恢复')
    assert.match(ui.body.textContent!, /原位置不可用/)
    await ui.click('vault', ui.body.querySelector('[aria-label="保存位置"]')!); await ui.click('确认')
    assert.ok(row('A')); assert.equal(ui.body.querySelector('[aria-label="回收站内容"]')!.textContent, '回收站为空')
    await ui.click('移到回收站', row('A')); await ui.click('永久删除'); await ui.click('取消')
    assert.equal(f.calls.at(-1)?.type, 'trash')
    await ui.click('永久删除'); await ui.click('确认永久删除'); assert.equal(f.calls.at(-1)?.type, 'delete')
    assert.match(ui.body.querySelector('[aria-label="回收站内容"]')!.textContent!, /回收站为空/)
  } finally { await ui.close() }
})

test('page drag sorts siblings and moves into a page; failed pre-trash save does not recycle', async () => {
  const f = fixture(), ui = await mountPageUI()
  const drag = async (source: string, target: string) => {
    await act(async () => {
      const start = new ui.dom.window.Event('dragstart', { bubbles: true })
      Object.defineProperty(start, 'dataTransfer', { value: { setData() {} } })
      ui.body.querySelector(`[data-page-id="${source}"] [draggable="true"]`)!.dispatchEvent(start)
      ui.body.querySelector(target)!.dispatchEvent(new ui.dom.window.Event('drop', { bubbles: true, cancelable: true }))
    })
  }
  try {
    await ui.render(<PageSidebar roots={[{ path: '/vault', kind: 'vault' }]} api={f.api} onOpen={() => {}} onShowFiles={() => {}} beforeTrash={async () => { throw new Error('保存失败') }} />)
    await drag('B', '[aria-label="排在 A 之前"]')
    assert.deepEqual(f.orders, [{ parent: 'vault', ids: ['B', 'A'] }])
    await drag('B', '[data-page-id="A"] [draggable="true"]')
    assert.equal(f.calls.at(-1)?.type, 'move')
    await ui.click('展开 A'); assert.ok(ui.body.querySelector('[data-page-id="A"] [data-page-id="B"]'))
    await ui.click('移到回收站', ui.body.querySelector('[data-page-id="A"]')!)
    assert.match(ui.body.querySelector('[role="alert"]')!.textContent!, /保存失败/)
    assert.equal(f.calls.some(call => call.type === 'trash'), false)
  } finally { await ui.close() }
})

test('SaveToPicker search, breadcrumbs, preview, Main collision candidates, saved default, canvas and cancellation', async () => {
  const f = fixture(), ui = await mountPageUI(), submitted: SaveToSelection[] = []
  let cancelled = 0, dialogs = 0
  Object.defineProperty(ui.dom.window, 'electronAPI', { value: { document: { openFolder: async () => { dialogs++; return { success: true, path: '/other' } } } } })
  try {
    const props = { trees: [f.tree], initialTitle: 'A', onCancel: () => { cancelled++ }, onConfirm: async (selection: SaveToSelection) => {
      submitted.push(selection)
      return submitted.length === 1 ? { ok: false as const, code: 'name_collision', message: '重名', candidateNames: ['A (2)'] } : success(null)
    } }
    await ui.render(<SaveToPicker {...props} />)
    assert.match(ui.body.querySelector('[aria-label="最终路径"]')!.textContent!, /\/vault\/A.md/)
    assert.match(ui.body.textContent!, /同名文件/)
    await ui.input('搜索位置', 'child'); assert.equal(ui.body.querySelectorAll('[role="treeitem"]').length, 1)
    await ui.click('child'); assert.match(ui.body.querySelector('[aria-label="当前位置"]')!.textContent!, /vault.*A.*child/)
    assert.match(ui.body.querySelector('[aria-label="最终路径"]')!.textContent!, /\/vault\/A\/child\/A.md/)
    await ui.click('取消'); assert.equal(submitted.length, 0); assert.equal(dialogs, 0)
    await ui.click('确认'); assert.match(ui.body.textContent!, /重名候选/)
    await ui.click('A (2)'); await ui.click('确认')
    assert.equal(submitted[1].title, 'A (2)'); assert.equal(submitted[1].parentObjectId, 'child')
    assert.notEqual(submitted[0].operationId, submitted[1].operationId)
    await ui.render(<SaveToPicker key="reopen" {...props} initialTitle="再次保存" />)
    assert.match(ui.body.querySelector('[aria-label="最终路径"]')!.textContent!, /\/vault\/A\/child\/再次保存.md/)
    await ui.click('其他位置…'); assert.equal(dialogs, 1); assert.match(ui.body.textContent!, /\/other/)
    await ui.render(<SaveToPicker key="canvas" {...props} sourceCanvas={{ title: '画板', path: '/vault/画板.canvas' }} />)
    assert.match(ui.body.textContent!, /来源画板：画板/); assert.match(ui.body.querySelector('[aria-label="最终路径"]')!.textContent!, /\/vault\/画板\/A.md/)
    await ui.click('确认'); assert.equal(submitted.at(-1)?.parentPath, '/vault/画板'); assert.equal(submitted.at(-1)?.keepDocumentCard, true)
    assert.equal(cancelled, 3)
  } finally { await ui.close() }
})

test('PageHeader changes icon, cover, title, cover position and display options through versioned Main API', async () => {
  const f = fixture(), ui = await mountPageUI()
  try {
    await ui.render(<PageHeader objectId="A" root="/vault" title="A" api={f.api} />)
    await ui.input('图标', 'lucide:star'); await ui.input('封面', 'https://example.test/cover.png')
    await ui.input('页面标题', '改名标题'); await ui.input('字体', 'serif'); await ui.input('封面位置', '0.25')
    await act(async () => { for (const box of ui.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) box.click() })
    await ui.click('保存页面属性')
    assert.equal(f.calls[0].type, 'rename'); assert.equal(f.patches.length, 1)
    assert.deepEqual(f.patches[0], { icon: 'lucide:star', cover: 'https://example.test/cover.png', ready_page: { font: 'serif', small_text: true, full_width: true, cover_y: 0.25 } })
    assert.equal(ui.body.querySelector<HTMLImageElement>('img')!.style.objectPosition, 'center 25%')
    await ui.click('保存页面属性'); assert.equal(f.patches.length, 1)
    await ui.input('封面', ''); await ui.click('保存页面属性'); assert.equal(ui.body.querySelector('img'), null)
  } finally { await ui.close() }
})

test('real workspace and view switch keep selection; missing vault is visible and not queried', async () => {
  const ui = await mountPageUI(), f = fixture()
  let reads = 0
  Object.defineProperty(ui.dom.window, 'electronAPI', { value: { documentPages: f.api, document: { listFiles: async () => { reads++; return { success: true, items: [] } } }, vault: {
    get: async () => ({ status: 'missing', root: '/lost', defaultSuggestion: '/default' }), onChanged: () => () => {},
  } } })
  const { PageViewSwitch, PageRootNotice } = await import('../renderer/modules/document/page-ui/PagePanel')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { useVault } = await import('../renderer/stores/useVault')
  const { usePagePanel } = await import('../renderer/modules/document/page-ui/page-panel-state')
  function Panel() { const panel = usePagePanel(); return <><PageViewSwitch view={panel.view} onChange={panel.setView} /><PageRootNotice hasRoots={panel.roots.length > 0} />{panel.roots.length > 0 && <PageSidebar roots={panel.roots} api={f.api} onOpen={() => {}} onShowFiles={() => {}} beforeTrash={async () => {}} />}</> }
  try {
    useWorkspace.getState().clearWorkspace()
    await ui.render(<Panel />)
    assert.match(ui.body.textContent!, /找不到资料库：\/lost/); assert.match(ui.body.textContent!, /重新选择资料库/)
    await ui.click('文件'); assert.equal(ui.body.querySelector('[aria-pressed="true"]')!.textContent, '文件')
    await ui.render(<Panel key="remount" />); assert.equal(ui.body.querySelector('[aria-pressed="true"]')!.textContent, '文件')
    await useWorkspace.getState().refreshFiles(); assert.equal(reads, 0); assert.equal(f.treeCalls, 0)
    await act(async () => useVault.setState({ view: { phase: 'loaded', data: { status: 'unconfigured', defaultSuggestion: '/default' } } }))
    assert.match(ui.body.textContent!, /设置资料库 \/ 打开文件夹/)
    assert.deepEqual(pageRoots({ status: 'missing', root: '/lost', defaultSuggestion: '' }, '/lost', ['/lost', '/external']), [{ path: '/external', kind: 'external' }])
  } finally { await ui.close() }
})

test('late page-tree responses never replace a new empty root', async () => {
  const f = fixture()
  let resolve: ((result: Awaited<ReturnType<typeof f.api.tree>>) => void) | undefined
  f.api.tree = () => new Promise(done => { resolve = done })
  const store = createPageTreeStore(f.api)
  const pending = store.getState().load([{ path: '/vault', kind: 'vault' }])
  await store.getState().load([])
  resolve!(success(f.tree)); await pending
  assert.deepEqual(store.getState().trees, []); assert.equal(store.getState().loading, false)
})

test('favorite and recent updates do not rescan the page tree', async () => {
  const f = fixture(), ui = await mountPageUI()
  try {
    await ui.render(<PageSidebar roots={[{ path: '/vault', kind: 'vault' }]} api={f.api} onOpen={() => {}} onShowFiles={() => {}} beforeTrash={async () => {}} />)
    const initialReads = f.treeCalls
    await ui.click('收藏', ui.body.querySelector('[data-page-id="A"]')!)
    await ui.click('A', ui.body.querySelector('[data-page-id="A"]')!)
    assert.equal(f.treeCalls, initialReads)
    assert.match(ui.body.querySelector('[aria-label="收藏"]')!.textContent!, /A/)
    assert.match(ui.body.querySelector('[aria-label="最近"]')!.textContent!, /A/)
  } finally { await ui.close() }
})

test('connected page sidebar and file opening share one object-bound tab', async () => {
  const ui = await mountPageUI(), f = fixture()
  const location = { objectId: 'sidebar-object-a', path: '/vault/A.md', revision: 1 }
  const objects: import('../shared/object-identity').ObjectPresentationAPI = {
    resolvePath: async () => location, locate: async () => location, onMoved: () => () => {},
    prepareMigration: async request => ({ migrationId: request.migrationId, state: 'prepared', resolved: [], unresolved: [] }),
    completeMigration: async migrationId => ({ migrationId, state: 'completed', resolved: [], unresolved: [] }),
  }
  Object.defineProperty(ui.dom.window, 'electronAPI', { value: { documentPages: f.api, objects } })
  const { ConnectedPageSidebar } = await import('../renderer/modules/document/page-ui/PagePanel')
  const { useDocTabs, settleDocTabObjects } = await import('../renderer/stores/useDocTabs')
  try {
    useDocTabs.getState().openTab('/vault/A.md') // Same entry as FileTree.
    await settleDocTabObjects()
    const original = useDocTabs.getState().tabs.find(tab => tab.objectId === location.objectId)!
    assert.ok(original)
    useDocTabs.getState().openTab('')
    assert.notEqual(useDocTabs.getState().activeTabId, original.id)
    await ui.render(<ConnectedPageSidebar roots={[{ path: '/vault', kind: 'vault' }]} onFiles={() => {}} />)
    await ui.click('A', ui.body.querySelector('[data-page-id="A"]')!)
    await settleDocTabObjects()
    assert.equal(ui.body.querySelector('[role="alert"]'), null)
    assert.equal(useDocTabs.getState().activeTabId, original.id)
    assert.equal(useDocTabs.getState().tabs.filter(tab => tab.objectId === location.objectId).length, 1)
  } finally { await ui.close() }
})

test('recycling a page saves dirty descendants and hidden attachments, and refuses missing save owners', async () => {
  const ui = await mountPageUI()
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { saveBeforePageTrash } = await import('../renderer/modules/document/page-ui/page-panel-state')
  const { registerDocumentSaveHandler } = await import('../renderer/modules/document/documentSaveRegistry')
  const previous = useDocTabs.getState().tabs
  const saved: string[] = []
  const files = ['/vault/A/child.md', '/vault/A.assets/note.md', '/vault/AB.md']
  useDocTabs.setState({ tabs: files.map((path, index) => ({ id: `dirty-${index}`, path, title: path, content: 'unsaved', isDirty: true })) })
  const releases = files.slice(0, 2).map((_path, index) => registerDocumentSaveHandler(`dirty-${index}`, () => {
    saved.push(`dirty-${index}`)
    useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === `dirty-${index}` ? { ...tab, isDirty: false } : tab) }))
  }))
  try {
    await saveBeforePageTrash(pageNode('A'))
    assert.deepEqual(saved, ['dirty-0', 'dirty-1'])
    assert.equal(useDocTabs.getState().tabs[2].isDirty, true)
    releases.forEach(release => release())
    useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, isDirty: true })) }))
    await assert.rejects(saveBeforePageTrash(pageNode('A')), /未保存内容/)
  } finally { releases.forEach(release => release()); useDocTabs.setState({ tabs: previous }); await ui.close() }
})
