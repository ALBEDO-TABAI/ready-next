import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { ThirdPartyNotice, ThirdPartyNoticesResult } from '../shared/ipc-contracts/third-party-notices'

const notice = (name: string, license: string | null, extra: Partial<ThirdPartyNotice> = {}): ThirdPartyNotice => ({
  name, version: '1.0.0', license, repository: null, texts: [{ path: `node_modules/${name}/LICENSE`, content: `${name} license text` }],
  notes: [], textMissing: false, kind: 'npm', ...extra,
})

async function mount(getThirdPartyNotices: () => Promise<ThirdPartyNoticesResult>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let calls = 0
  Object.assign(dom.window, { electronAPI: { app: { getThirdPartyNotices: () => { calls++; return getThirdPartyNotices() } } } })
  // react-dom decides which events the page supports when it loads, so it loads after the DOM globals exist.
  const { createRoot } = await import('react-dom/client')
  const { ThirdPartyNoticesPanel } = await import('../renderer/pages/settings/ThirdPartyNoticesPanel')
  const container = dom.window.document.getElementById('root')!
  let root: Root
  await act(async () => { root = createRoot(container); root.render(createElement(ThirdPartyNoticesPanel)) })
  const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === name)
  return {
    container, calls: () => calls, button,
    click: async (element: Element | undefined) => { assert.ok(element); await act(async () => { (element as HTMLElement).click() }) },
    type: async (value: string) => {
      const input = container.querySelector<HTMLInputElement>('input[type=search]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    rows: () => [...container.querySelectorAll('[aria-label="第三方声明列表"] > li > button')].map(b => b.textContent ?? ''),
    close: async () => {
      await act(async () => root.unmount())
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as Record<string, unknown>)[key]
      }
      dom.window.close()
    },
  }
}

test('开源许可 loads only when opened, summarizes licenses, filters, and shows a package’s text on demand', async () => {
  const notices = [notice('react', 'MIT'), notice('rsshub', 'AGPL-3.0'), notice('lucide-react', 'ISC'), notice('Inter Tight', 'OFL-1.1', { kind: 'manual' }),
    notice('date-fns', 'MIT', { texts: [{ path: 'node_modules/date-fns/LICENSE.md', content: 'date-fns MIT text' }] }),
    notice('mystery', null, { texts: [], textMissing: true, notes: ['上游只声明 MIT'] })]
  const h = await mount(async () => ({ ok: true, notices }))
  try {
    assert.equal(h.calls(), 0, 'nothing is read before the panel is opened')
    assert.equal(h.container.querySelector('[aria-label="第三方声明列表"]'), null)
    await h.click(h.button('查看'))
    assert.equal(h.calls(), 1)
    assert.match(h.container.textContent ?? '', /共 6 项：MIT 2 · AGPL-3\.0 1 · ISC 1 · OFL-1\.1 1 · 其他 1/)
    assert.equal(h.rows().length, 6)
    assert.ok(h.rows().some(row => row.includes('mystery') && row.includes('未声明 · 缺全文')))

    await h.type('agpl')
    assert.deepEqual(h.rows().map(row => row.split('1.0.0')[0]), ['rsshub'], 'filters by license as well as name')
    await h.type('date')
    assert.equal(h.container.querySelector('pre'), null, 'license texts stay hidden until a row is opened')
    await h.click(h.container.querySelector('[aria-label="第三方声明列表"] > li > button') ?? undefined)
    assert.equal(h.container.querySelector('pre[aria-label="node_modules/date-fns/LICENSE.md"]')?.textContent, 'date-fns MIT text')

    await h.type('zzz')
    assert.match(h.container.textContent ?? '', /没有匹配的项/)
    await h.click(h.button('收起'))
    await h.click(h.button('查看'))
    assert.equal(h.calls(), 1, 'reopening reuses what was read')
  } finally { await h.close() }
})

test('开源许可 says when the notices were not generated, and shows a read failure', async () => {
  const missing = await mount(async () => ({ ok: false, reason: 'not_generated' }))
  try {
    await missing.click(missing.button('查看'))
    assert.match(missing.container.textContent ?? '', /在打包时生成/)
  } finally { await missing.close() }
  const broken = await mount(async () => { throw new Error('磁盘读不出') })
  try {
    await broken.click(broken.button('查看'))
    assert.match(broken.container.querySelector('[role=alert]')?.textContent ?? '', /读不出声明：磁盘读不出/)
  } finally { await broken.close() }
})
