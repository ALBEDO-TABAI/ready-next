import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('wiki links open page-relative targets first, then vault-relative ones', async () => {
  const dom = new JSDOM('<div></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  try {
    const existing = new Set(['/vault/sub/target.md', '/vault/a/neighbor.md'])
    const resolved: string[] = []
    Object.defineProperty(dom.window, 'electronAPI', { value: {
      document: { stat: async (path: string) => existing.has(path) ? { success: true, data: {} } : { success: false, error: 'Not found' } },
      objects: { onMoved: () => () => undefined, resolvePath: async (path: string) => { resolved.push(path); throw new Error('stop after resolving') } },
    } })
    const { openInlineReference } = await import('../renderer/modules/document/block-editor/references')
    const { useWorkspace } = await import('../renderer/stores/useWorkspace')
    const { useDocTabs } = await import('../renderer/stores/useDocTabs')
    useWorkspace.setState({ workspaceRoot: '/vault', pinnedFolders: [] })
    useDocTabs.setState({ tabs: [{ id: 'page', title: 'page', path: '/vault/a/page.md', content: '', isDirty: false }], activeTabId: 'page', splitTabId: null })
    const open = (target: string) => openInlineReference({ kind: 'wiki', target }, 'page')
    await assert.rejects(open('sub/target#标题'), /stop after resolving/)
    await assert.rejects(open('neighbor'), /stop after resolving/)
    await assert.rejects(open('missing'), /找不到页面：missing/)
    assert.deepEqual(resolved, ['/vault/sub/target.md', '/vault/a/neighbor.md'])
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
