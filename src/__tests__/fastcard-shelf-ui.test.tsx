import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import type { FastCardItem } from '../shared/fastcard'

// W4 §6 / MS6 (renderer side): outside the browser the FastCard shelf is a drawer in the content area. Each card shows
// where it came from and when; choosing cards turns 清空 into 删除 for exactly those cards; 收起 closes the drawer.
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
const removed: string[] = []
let stored: FastCardItem[] = []
Object.assign(dom.window, { electronAPI: { browser: {
  listFastCardItems: async () => ({ success: true, data: stored }),
  removeFastCardItem: async (id: string) => { removed.push(id); stored = stored.filter(item => item.id !== id); return { success: true } },
  clearFastCardItems: async () => ({ success: true }),
  addFastCardItem: async (item: FastCardItem) => ({ success: true, data: item }),
} } })

const { createRoot } = await import('react-dom/client')
const { useFastCard } = await import('../renderer/stores/useFastCard')
const { FastCardShelf } = await import('../renderer/modules/fastcard/FastCardShelf')

const at = new Date(2026, 10, 12, 9, 30).getTime()
const item = (id: string, extra: Partial<FastCardItem>): FastCardItem => ({ id, kind: 'text', text: `正文 ${id}`, createdAt: at, tags: [], ...extra } as FastCardItem)
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)

test('the shelf is a drawer outside the browser; cards show their source and time; 删除 removes exactly the chosen cards', async () => {
  stored = [
    item('a', { title: '筛子的想法', source: { pageUrl: 'https://example.com/a', domain: 'example.com' } }),
    item('b', { title: '随手记' }),
    item('c', { title: '一段书摘', source: { pageUrl: 'https://example.com/report.pdf' } }),
  ]
  const root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<FastCardShelf visible={false} />))
  await act(async () => { await useFastCard.getState().open() }); await settle()
  assert.equal(document.querySelector('[data-fastcard-shelf]'), null, 'in the browser the overlay window shows it instead')
  await act(async () => root.render(<FastCardShelf visible />)); await settle()
  const metas = [...document.querySelectorAll('.fc-card__meta')].map(meta => meta.textContent)
  assert.ok(metas[0]!.startsWith('网页 · example.com · '), metas[0]!)
  assert.ok(metas[1]!.startsWith('快记 · '), metas[1]!)
  assert.ok(metas[2]!.startsWith('PDF · '), metas[2]!)
  assert.match(document.querySelector('.fc-shelf__count')!.textContent!, /^3 条$/)
  for (const title of ['筛子的想法', '一段书摘']) {
    const box = document.querySelector<HTMLInputElement>(`[aria-label="选择 ${title}"]`)!
    await act(async () => box.click())
  }
  assert.match(document.querySelector('.fc-shelf__count')!.textContent!, /已选 2 条/)
  assert.equal(button('清空'), undefined, 'with cards chosen the footer deletes them instead of clearing everything')
  await act(async () => button('删除')!.click()); await settle()
  assert.deepEqual(removed.sort(), ['a', 'c'])
  assert.deepEqual(useFastCard.getState().items.map(card => card.id), ['b'])
  await act(async () => button('收起')!.click()); await settle()
  assert.equal(document.querySelector('[data-fastcard-shelf]'), null)
  await act(async () => root.unmount())
})
