import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import type { BrowserTab } from '../renderer/stores/useBrowserTabs'
import type { TabGroup } from '../shared/tab-groups'
import { importWithoutStyles } from './utils/import-without-styles'

// The browser navigator in the shell sidebar (W2-T3): titled rows, the current tab marked, close,
// activate, groups that collapse, and the same drag payload the assistant accepts from a tab.

const { default: BrowserTabList } = await importWithoutStyles(() => import('../renderer/components/browser/BrowserTabList'))

const tab = (id: string, title: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id, title, url: `https://${id}.example.com/`, loading: false, canGoBack: false, canGoForward: false, ...extra,
})

async function mount(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  return { dom, root, body: dom.window.document.body }
}

function handlers(log: string[]) {
  return {
    onTabClick: (id: string, event: { shiftKey: boolean }) => { log.push(`click:${id}:${event.shiftKey}`) },
    onTabClose: (id: string) => { log.push(`close:${id}`) },
    onNewTab: () => { log.push('new') },
    onReorderToRank: (moved: string, rank: number, group: string | null) => { log.push(`reorder:${moved}:${rank}:${group}`) },
    onCreateGroup: (dragged: string, target: string) => { log.push(`group:${dragged}:${target}`) },
    onAddToGroup: (id: string, group: string) => { log.push(`add:${id}:${group}`) },
    onGroupTab: (id: string) => { log.push(`group-tab:${id}`); return null },
    onUngroupTab: (id: string) => { log.push(`ungroup:${id}`) },
    onRenameGroup: () => {}, onRecolorGroup: () => {},
    onSetGroupCollapsed: (id: string, collapsed: boolean) => { log.push(`collapse:${id}:${collapsed}`) },
    onDisbandGroup: () => {}, onDeleteGroup: () => {}, onNewTabInGroup: (id: string) => { log.push(`new-in:${id}`) },
  }
}

test('rows show titles and domains, mark the current tab and the split tab', async t => {
  const { root, body } = await mount(t)
  const tabs = [tab('a', 'Alpha'), tab('b', 'Beta'), tab('c', 'Gamma')]
  await act(async () => root.render(<BrowserTabList tabs={tabs} tabGroups={[]} activeTabId="b" splitTabId="c" {...handlers([])} />))
  const rows = [...body.querySelectorAll<HTMLElement>('.browser-tab-list__row[role="listitem"]')]
  assert.deepEqual(rows.map(row => row.querySelector('.browser-tab-list__label')?.textContent), ['Alpha', 'Beta', 'Gamma'])
  // The meta line is the site's registrable domain, as the old rail showed it.
  assert.equal(rows[0].querySelector('.browser-tab-list__meta')?.textContent, 'example.com')
  assert.deepEqual(rows.map(row => row.hasAttribute('data-current')), [false, true, true])
})

test('clicking a row activates it, the close button closes only that tab, + opens a new tab', async t => {
  const { root, body, dom } = await mount(t)
  const log: string[] = []
  await act(async () => root.render(<BrowserTabList tabs={[tab('a', 'Alpha'), tab('b', 'Beta')]} tabGroups={[]} activeTabId="a" splitTabId={null} {...handlers(log)} />))
  const rows = body.querySelectorAll<HTMLElement>('.browser-tab-list__row[role="listitem"]')
  await act(async () => { rows[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true })) })
  await act(async () => { rows[0].querySelector<HTMLButtonElement>('.browser-tab-list__close')!.click() })
  await act(async () => { body.querySelector<HTMLButtonElement>('.browser-tab-list__new')!.click() })
  assert.deepEqual(log, ['click:b:true', 'close:a', 'new'])
})

test('a collapsed group hides its members and keeps its header', async t => {
  const { root, body } = await mount(t)
  const log: string[] = []
  const groups: TabGroup[] = [{ id: 'g1', name: '调研', color: 'blue', collapsed: true }]
  const tabs = [tab('a', 'Alpha', { groupId: 'g1' }), tab('b', 'Beta', { groupId: 'g1' }), tab('c', 'Gamma')]
  // Neither member of the collapsed group is active, so both are hidden; the header stays.
  await act(async () => root.render(<BrowserTabList tabs={tabs} tabGroups={groups} activeTabId="c" splitTabId={null} {...handlers(log)} />))
  const labels = [...body.querySelectorAll('.browser-tab-list__row[role="listitem"] .browser-tab-list__label')].map(node => node.textContent)
  assert.deepEqual(labels, ['Gamma'])
  assert.ok(body.textContent?.includes('调研'), 'the group header stays visible')
})

test('a row carries the browser-tab resource payload when dragged (to the assistant or a page)', async t => {
  const { root, body, dom } = await mount(t)
  await act(async () => root.render(<BrowserTabList tabs={[tab('a', 'Alpha')]} tabGroups={[]} activeTabId="a" splitTabId={null} {...handlers([])} />))
  const data = new Map<string, string>()
  const event = new dom.window.Event('dragstart', { bubbles: true }) as unknown as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: '' } })
  await act(async () => { body.querySelector('.browser-tab-list__row[role="listitem"]')!.dispatchEvent(event) })
  const payload = JSON.parse(data.get('application/x-ready-ref') ?? '{}')
  assert.equal(payload.kind, 'web')
  assert.equal('tabId' in payload, false)
  assert.equal(payload.url, 'https://a.example.com/')
  assert.equal(data.get('text/plain'), 'Alpha')
})

// The tab's right-click menu is the shared float menu (rendered by the app's one FloatHost).
const menuLabels = (body: HTMLElement) => [...body.querySelectorAll('[role="menu"] .rn-menu__label, [role="menu"] .rn-menu__group')].map(node => node.textContent)
async function rightClick(dom: JSDOM, row: Element) {
  await act(async () => { row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })) })
}
async function choose(body: HTMLElement, label: string) {
  const item = [...body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.querySelector('.rn-menu__label')?.textContent === label)
  assert.ok(item, `menu item ${label}`)
  await act(async () => item.click())
}

test('right-click offers a new group, the other groups, and leaving the group; the choices reach the handlers', async t => {
  const { root, body, dom } = await mount(t)
  const { FloatHost, closeAllFloats } = await import('../renderer/components/ui')
  t.after(() => closeAllFloats())
  const log: string[] = []
  const groups: TabGroup[] = [{ id: 'g1', name: '调研', color: 'blue', collapsed: false }, { id: 'g2', name: '', color: 'green', collapsed: false }]
  const tabs = [tab('a', 'Alpha', { groupId: 'g1' }), tab('b', 'Beta', { groupId: 'g2' }), tab('c', 'Gamma')]
  await act(async () => root.render(<><BrowserTabList tabs={tabs} tabGroups={groups} activeTabId="c" splitTabId={null} {...handlers(log)} /><FloatHost /></>))
  const rows = () => [...body.querySelectorAll<HTMLElement>('.browser-tab-list__row[role="listitem"]')]

  // An ungrouped tab: both groups are offered, there is nothing to leave.
  await rightClick(dom, rows()[2])
  assert.deepEqual(menuLabels(body), ['引用到输入框', '添加到新分组', '添加到分组', '调研', '未命名分组', '关闭标签页'])
  await choose(body, '调研')
  assert.equal(body.querySelector('[role="menu"]'), null, 'the menu closes on a choice')

  // A grouped tab: its own group is not offered again, 移出分组 is.
  await rightClick(dom, rows()[0])
  assert.deepEqual(menuLabels(body), ['引用到输入框', '添加到新分组', '添加到分组', '未命名分组', '移出分组', '关闭标签页'])
  await choose(body, '移出分组')
  await rightClick(dom, rows()[1])
  await choose(body, '添加到新分组')
  await rightClick(dom, rows()[1])
  await choose(body, '关闭标签页')
  assert.deepEqual(log, ['add:c:g1', 'ungroup:a', 'group-tab:b', 'close:b'])
})

test('添加到新分组 on the real store: the group appears with its name field focused; typing names it; 移出分组 dissolves it', async t => {
  const { root, body, dom } = await mount(t)
  const { FloatHost, closeAllFloats } = await import('../renderer/components/ui')
  const { useBrowserTabs } = await import('../renderer/stores/useBrowserTabs')
  t.after(() => { closeAllFloats(); useBrowserTabs.getState().setTabs([]) })
  const store = () => useBrowserTabs.getState()
  store().setTabs([tab('a', 'Alpha'), tab('b', 'Beta')])
  store().setActiveTabId('a')
  function Host() {
    const tabs = useBrowserTabs(state => state.tabs)
    const tabGroups = useBrowserTabs(state => state.tabGroups)
    return (
      <BrowserTabList
        {...handlers([])}
        tabs={tabs} tabGroups={tabGroups} activeTabId="a" splitTabId={null}
        onGroupTab={id => store().createTabGroupWithTab(id)}
        onUngroupTab={id => store().removeTabFromGroup(id)}
        onRenameGroup={(id, name) => store().renameTabGroup(id, name)}
        onSetGroupCollapsed={(id, collapsed) => store().setTabGroupCollapsed(id, collapsed)}
      />
    )
  }
  await act(async () => root.render(<><Host /><FloatHost /></>))
  const row = (title: string) => [...body.querySelectorAll<HTMLElement>('.browser-tab-list__row[role="listitem"]')].find(node => node.textContent?.includes(title))!

  await rightClick(dom, row('Beta'))
  await choose(body, '添加到新分组')
  const [group] = store().tabGroups
  assert.ok(group, 'the store has the new group')
  assert.equal(store().tabs.find(item => item.id === 'b')?.groupId, group.id)
  assert.ok(body.querySelector(`[data-tab-group-header="${group.id}"]`), 'its header is in the list')
  const input = body.querySelector<HTMLInputElement>('input[placeholder="分组名称"]')
  assert.ok(input, 'the name field is open')
  assert.equal(dom.window.document.activeElement, input, 'and focused')

  // Type a name and press Enter: the group is renamed and the editor closes.
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '资料')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })) })
  assert.equal(store().tabGroups[0].name, '资料')
  assert.equal(body.querySelector('input[placeholder="分组名称"]'), null)

  // Collapse through the header: the member row leaves the list, the group stays.
  await act(async () => body.querySelector<HTMLButtonElement>(`[data-tab-group-header="${group.id}"] button`)!.click())
  assert.equal(store().tabGroups[0].collapsed, true)
  assert.equal(row('Beta'), undefined)
  await act(async () => body.querySelector<HTMLButtonElement>(`[data-tab-group-header="${group.id}"] button`)!.click())

  await rightClick(dom, row('Beta'))
  await choose(body, '移出分组')
  assert.deepEqual(store().tabGroups, [])
  assert.equal(body.querySelector('[data-tab-group-header]'), null)
})
