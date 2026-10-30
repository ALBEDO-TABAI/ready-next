import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('page anchors open the page and reveal the heading or block lines; a missing anchor still opens the page', async () => {
  const dom = new JSDOM('<div data-workbench-mode-panel="document"></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  try {
    const body = '# 标题\n\n第一段\n第二行 ^inline\n\n## 第二节\n\n独立块\n\n^standalone\n'
    Object.defineProperty(dom.window, 'electronAPI', { value: {
      objects: { locate: async () => ({ objectId: 'page', path: '/vault/页.md', revision: 1 }), onMoved: () => () => undefined, prepareMigration: async () => ({ migrationId: 'm', state: 'completed', resolved: [], unresolved: [] }) },
      document: { readFile: async () => ({ success: true, content: body }) },
    } })
    const { openReadyRef, anchorLines } = await import('../renderer/modules/workbench/open-ready-ref')
    const { useDocTabs } = await import('../renderer/stores/useDocTabs')
    assert.deepEqual(await anchorLines('/vault/页.md', '第二节'), { lineStart: 6, lineEnd: 6, sectionTitle: '第二节' })
    assert.deepEqual(await anchorLines('/vault/页.md', '^inline'), { lineStart: 3, lineEnd: 4 }, 'an inline id covers its paragraph')
    assert.deepEqual(await anchorLines('/vault/页.md', '^standalone'), { lineStart: 8, lineEnd: 8 }, 'a standalone id labels the block above')
    assert.equal(await anchorLines('/vault/页.md', '^missing'), null)
    await openReadyRef({ kind: 'page', id: 'page', anchor: '^inline' }, 'document')
    const reveal = useDocTabs.getState().pendingReveal
    assert.equal(reveal?.path, '/vault/页.md'); assert.equal(reveal?.lineStart, 3); assert.equal(reveal?.lineEnd, 4)
    useDocTabs.getState().setPendingReveal(null)
    await openReadyRef({ kind: 'page', id: 'page', anchor: '不存在' }, 'document')
    assert.ok(useDocTabs.getState().tabs.some(tab => tab.path === '/vault/页.md'))
    assert.equal(useDocTabs.getState().pendingReveal, null)
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
