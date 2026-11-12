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
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
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
