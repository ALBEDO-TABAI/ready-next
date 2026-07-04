import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { buildBrowserPageMapProbeJs } from '../main/modules/tools/browser-probe'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-probe-collect declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-probe-collect transitive sqlite load')
})

// D14（2026-07-04 R1 真机实锚，XHS <xhs-publish-btn>）：Web Component host
// 的真实控件藏在 shadow root 里，语义选择器/pointer 标签清单/cursor 信号
// 三层全盲，「发布」永远进不了 map。本文件在 node:vm 里执行真实注入 JS
// （buildBrowserPageMapProbeJs 产物），用假 DOM 断言采集合同：
//   1. 可见、带短文本的自定义元素 host 进 targets，role=clickable；
//   2. 空文本 / 交互祖先覆盖 / 超大面积的 host 不进（防噪声）；
//   3. 既有语义与 pointer 收集级不回归。

class FakeElement {
  tagName: string
  attrs: Record<string, string>
  innerText: string
  textContent: string
  style: { display: string; visibility: string; cursor: string; opacity: string }
  rect: { x: number; y: number; left: number; top: number; width: number; height: number }
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  shadowRoot: null = null
  isContentEditable = false
  hasInteractiveAncestor = false

  constructor(tagName: string, options: {
    text?: string
    attrs?: Record<string, string>
    cursor?: string
    width?: number
    height?: number
    hasInteractiveAncestor?: boolean
  } = {}) {
    this.tagName = tagName.toUpperCase()
    this.attrs = options.attrs ?? {}
    this.innerText = options.text ?? ''
    this.textContent = options.text ?? ''
    this.style = { display: 'block', visibility: 'visible', cursor: options.cursor ?? 'auto', opacity: '1' }
    this.rect = { x: 10, y: 10, left: 10, top: 10, width: options.width ?? 120, height: options.height ?? 40 }
    this.hasInteractiveAncestor = options.hasInteractiveAncestor ?? false
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attrs, name)
  }

  getBoundingClientRect() {
    return this.rect
  }

  closest(_selector: string): FakeElement | null {
    return this.hasInteractiveAncestor ? new FakeElement('button') : null
  }
}

function runProbe(elements: {
  semantic: FakeElement[]
  pointer: FakeElement[]
  all: FakeElement[]
}): { role: string; name: string; backendDOMNodeId: number }[] {
  const querySelectorAll = (selector: string): FakeElement[] => {
    if (selector === '*') return elements.all
    if (selector === 'div,span,li,p,img,svg') return elements.pointer
    if (selector.includes('a[href]') && selector.includes('h6')) return elements.semantic
    return []
  }
  const getComputedStyle = (el: FakeElement) => el.style
  const sandbox = {
    document: {
      querySelectorAll,
      querySelector: () => null,
      getElementById: () => null,
      title: 'fake',
      body: { innerText: '' },
    },
    window: { getComputedStyle, innerWidth: 1200, innerHeight: 900 },
    getComputedStyle,
    location: { href: 'https://fake.example/page', origin: 'https://fake.example' },
    Element: FakeElement,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLButtonElement: class {},
    CSS: { escape: (s: string) => s },
    URL: class {
      origin = 'https://fake.example'
    },
  }
  const payload = JSON.parse(JSON.stringify(vm.runInNewContext(buildBrowserPageMapProbeJs(), sandbox))) as {
    rawRoots: { children: { role: string; name: string; backendDOMNodeId: number }[] }[]
  }
  return payload.rawRoots[0].children
}

test('custom-element host with rendered text enters targets as clickable', () => {
  const stashButton = new FakeElement('button', { text: '暂存离开' })
  const publishHost = new FakeElement('xhs-publish-btn', { text: '发布' })
  const targets = runProbe({
    semantic: [stashButton],
    pointer: [],
    all: [stashButton, publishHost],
  })
  const publish = targets.find((t) => t.name === '发布')
  assert.ok(publish, 'publish host must be collected')
  assert.strictEqual(publish?.role, 'clickable')
  const stash = targets.find((t) => t.name === '暂存离开')
  assert.strictEqual(stash?.role, 'button')
})

test('noise custom hosts are excluded: empty text, interactive ancestor, oversized', () => {
  const emptyHost = new FakeElement('xhs-empty-widget')
  const coveredHost = new FakeElement('xhs-inner-btn', { text: '确认', hasInteractiveAncestor: true })
  const giantHost = new FakeElement('xhs-layout-shell', { text: '发布', width: 1200, height: 900 })
  const targets = runProbe({
    semantic: [],
    pointer: [],
    all: [emptyHost, coveredHost, giantHost],
  })
  assert.deepStrictEqual(targets, [])
})

test('pointer-cursor collection still works alongside custom hosts, order deterministic', () => {
  const semanticButton = new FakeElement('button', { text: '一键排版' })
  const pointerDiv = new FakeElement('div', { text: '写长文', cursor: 'pointer' })
  const publishHost = new FakeElement('xhs-publish-btn', { text: '发布' })
  const targets = runProbe({
    semantic: [semanticButton],
    pointer: [pointerDiv],
    all: [semanticButton, pointerDiv, publishHost],
  })
  assert.deepStrictEqual(
    targets.map((t) => ({ role: t.role, name: t.name, id: t.backendDOMNodeId })),
    [
      { role: 'button', name: '一键排版', id: 1 },
      { role: 'clickable', name: '写长文', id: 2 },
      { role: 'clickable', name: '发布', id: 3 },
    ],
  )
})
