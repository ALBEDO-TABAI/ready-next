import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

test('preview shows a live quote card, follows source changes/deletion and opens both card and original link', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent,
    HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  let content = '---\nready_id: bk-one\n作者: 白\n---\n## 标注\n\n> [!quote|green] 第一章 · [原文](ready://read/book/bk-one#c0:1+2)\n> 乙丙\n>\n> 批注一\n\n^hl-one\n'
  let deleted = false
  const changes = new Set<() => void>()
  const subscribe = (cb: () => void) => { changes.add(cb); return () => changes.delete(cb) }
  Object.defineProperty(dom.window, 'electronAPI', { value: { navigationHistory: memoryNavigationAPI(),
    library: { get: async () => ({ success: true, data: { status: 'ready', books: deleted ? [] : [{ id: 'bk-one', title: '山海', format: 'txt', notePath: '/vault/阅读/山海.md' }] } }), onChanged: subscribe },
    document: { readFile: async () => ({ success: !deleted, content }), onDirectoryChange: subscribe, onIndexChanged: subscribe },
  } })
  const { createRoot } = await import('react-dom/client')
  const { default: NotePreview } = await import('../renderer/components/document/NotePreview')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useLibraryRequest } = await import('../renderer/modules/library/reader/navigation-state')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const beforeWorkspace = useWorkspace.getState(), beforeRequest = useLibraryRequest.getState()
  const before = useDocTabs.getState()
  const root = createRoot(dom.window.document.getElementById('root')!)
  const raw = '![[山海#^hl-one]]'
  try {
    await act(async () => root.render(<NotePreview content={`${raw}\n\n${raw}`} notePath="/vault/引用.md" />))
    const cards = dom.window.document.querySelectorAll('[data-library-quote]')
    assert.equal(cards.length, 2, 'repeated references are not suppressed')
    // 出处 is a book capsule: the title and chapter, opening the passage in 书房 (W6 §2.1).
    assert.match(cards[0].textContent!, /山海白乙丙批注一山海 · 第一章/)
    assert.equal(dom.window.document.querySelector('iframe'), null)
    assert.equal(dom.window.document.querySelector('table'), null)
    content = content.replace('批注一', '批注二')
    await act(async () => changes.forEach(cb => cb()))
    assert.match(cards[0].textContent!, /批注二/)
    await act(async () => cards[0].querySelector<HTMLElement>('[data-ready-ref-capsule]')!.click())
    assert.equal(useLibraryRequest.getState().target?.book, 'bk-one')
    await act(async () => root.render(<NotePreview content={content} notePath="/vault/阅读/山海.md" />))
    const original = [...dom.window.document.querySelectorAll('a')].find(a => a.textContent?.includes('原文'))!
    const { parseReadyUri } = await import('../shared/ready-ref')
    assert.deepEqual(parseReadyUri(original.getAttribute('href')!), parseReadyUri('ready://read/book/bk-one#c0:1+2'))
    const sequence = useLibraryRequest.getState().sequence
    await act(async () => original.click())
    assert.equal(useLibraryRequest.getState().sequence, sequence + 1)
    await act(async () => root.render(<NotePreview content={raw} notePath="/vault/引用.md" />))
    deleted = true
    await act(async () => changes.forEach(cb => cb()))
    assert.match(dom.window.document.body.textContent!, /引用已失效/)
    assert.ok(dom.window.document.body.textContent!.includes(raw))
    assert.equal(dom.window.document.querySelector('[data-library-quote] button, [data-library-quote] [data-ready-ref-capsule]'), null)
  } finally {
    await act(async () => root.unmount()); useDocTabs.setState(before, true); useWorkspace.setState(beforeWorkspace, true); useLibraryRequest.setState(beforeRequest, true)
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})

export const __breaksInvariants = ['renderer.navigation-stores-restored-after-isolated-quote-preview-test'] as const
