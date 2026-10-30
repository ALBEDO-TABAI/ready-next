import assert from 'node:assert/strict'
import test from 'node:test'
import { useRSSSession } from '../renderer/stores/useRSSSession'

test('search panel clicks open four exact targets and show unavailable conversations without switching', async () => {
  const { JSDOM } = await import('jsdom')
  const { createElement, act } = await import('react')
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const { default: GlobalSearchPanel } = await import('../renderer/components/layout/GlobalSearchPanel')
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const beforeAgent = useAgent.getState()
  const beforeWorkspace = useWorkspace.getState()
  const calls: string[] = []
  let visible = true
  let readable = true
  const scope = { id: 'wanted', agent: 'butler', title: 'Wanted', sourceKind: 'local' as const,
    sourceId: 'app', threadKey: 'wanted', meta: {}, createdAt: '2026-10-30', updatedAt: '2026-10-30', messageVisibilityEpoch: 0 }
  const results = [
    { sourceType: 'rss', path: 'ready://rss/item/article', name: 'RSS target', sourceMeta: { link: 'https://example.com/original' } },
    { sourceType: 'calendar', path: 'ready://calendar/event/series#occurrence=1800000000000', name: 'Calendar target' },
    { sourceType: 'calendar', path: 'ready://calendar/event/day#occurrence=2026-10-30', name: 'All-day target' },
    { sourceType: 'agent', path: 'ready://agent/conversation/wanted', name: 'Agent target' },
    { sourceType: 'bookmark', path: 'ready://web?url=https%3A%2F%2Fexample.com', name: 'Bookmark target' },
  ].map(item => ({ ...item, snippet: '', tagsHit: [], linksHit: [], nameMatch: false }))
  Object.defineProperty(dom.window, 'electronAPI', { value: {
    document: { searchIndex: async () => ({ success: true, data: { items: results, stats: { returned: results.length, elapsedMs: 1 } } }) },
    rss: { readArticle: async ({ itemId }: {itemId:string}) => { calls.push(`rss:${itemId}`); return { success: true, data: { article: { revision: 'r1' } } } } },
    calendar: { revealEvent: async (id: string) => { calls.push(`calendar:${id}`); return { success: true } } },
    browser: { createTab: async (url: string) => { calls.push(`web:${url}`); return { success: true, tabId: 'bookmark-tab' } } },
    agent: {
      listConversationScopes: async () => ({ success: true, data: visible ? [{ ...scope, id: 'other', threadKey: 'other' }, scope] : [{ ...scope, id: 'other', threadKey: 'other' }] }),
      getConversationScopeMessages: async (id: string) => {
        calls.push(`agent:${id}`)
        return { success: readable, data: readable ? [{ id: 'message', role: 'user', content: 'Exact transcript', timestamp: '2026-10-30', meta: {} }] : undefined }
      },
    },
  } })
  dom.window.open = (url) => { calls.push(`original:${url}`); return null }
  useWorkspace.setState({ workspaceRoot: '/private/tmp/ready-r2/workspace', pinnedFolders: [], chatPanelVisible: false })
  useAgent.setState({ scopes: [], currentScopeId: null, currentScope: null, sessions: {}, retiredScopeIds: {} })
  dom.window.localStorage.setItem('ready-search-index-status:/private/tmp/ready-r2/workspace', JSON.stringify({ workspaceRoot: '/private/tmp/ready-r2/workspace', docCount: 4, lastIndexedAt: '2026-10-30' }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent?.includes(label))
    assert.ok(button, `missing button ${label}`)
    await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  }
  try {
    await act(async () => root.render(createElement(GlobalSearchPanel)))
    const input = dom.window.document.querySelector('input')
    assert.ok(input, dom.window.document.body.textContent || '')
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'target')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    await click('RSS target')
    assert.equal(useRSSSession.getState().pendingReveal?.reference.kind, 'article')
    await click('打开原文')
    await click('Calendar target')
    await click('All-day target')
    await click('Bookmark target')
    await click('Agent target')
    assert.equal(useAgent.getState().currentScopeId, 'wanted')
    assert.equal(useAgent.getState().messages[0]?.content, 'Exact transcript')
    assert.equal(useWorkspace.getState().chatPanelVisible, true)
    assert.deepEqual(calls, ['rss:article', 'original:https://example.com/original', 'calendar:series#1800000000', 'calendar:day#1793318400', 'web:https://example.com', 'agent:wanted'])
    visible = false
    await click('Agent target')
    assert.match(dom.window.document.body.textContent || '', /会话已关闭、已删除或不可见/)
    assert.equal(useAgent.getState().currentScopeId, 'wanted')
    assert.equal(calls.length, 6)
    visible = true; readable = false
    await click('Agent target')
    assert.match(dom.window.document.body.textContent || '', /会话无法打开/)
    assert.equal(useAgent.getState().messages[0]?.content, 'Exact transcript')
  } finally {
    await act(async () => root.unmount())
    useAgent.setState(beforeAgent, true)
    useWorkspace.setState(beforeWorkspace, true)
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})

export const __breaksInvariants = ['renderer.agent-store-and-workspace-restored-after-isolated-navigation-test'] as const
