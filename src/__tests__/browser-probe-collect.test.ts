import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { buildBrowserActOnTargetJs, buildBrowserPageMapProbeJs } from '../main/modules/tools/browser-probe'

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

  dispatchEvent(_event: unknown): boolean {
    return true
  }

  click(): void {
    // synthetic activation sink for the act-JS click branch
  }

  focus(): void {
    // focus sink for the act-JS fill branch
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

test('noise custom hosts are excluded: interactive ancestor, oversized', () => {
  const coveredHost = new FakeElement('xhs-inner-btn', { text: '确认', hasInteractiveAncestor: true })
  const giantHost = new FakeElement('xhs-layout-shell', { text: '发布', width: 1200, height: 900 })
  const targets = runProbe({
    semantic: [],
    pointer: [],
    all: [coveredHost, giantHost],
  })
  assert.deepStrictEqual(targets, [])
})

test('empty-text custom host is kept with tagName as its map name (closed shadow)', () => {
  const mute = new FakeElement('xhs-publish-btn')
  const targets = runProbe({ semantic: [], pointer: [], all: [mute] })
  assert.strictEqual(targets.length, 1)
  assert.strictEqual(targets[0]?.role, 'clickable')
  assert.strictEqual(targets[0]?.name, 'xhs-publish-btn')
})

test('custom host at the DOM tail of a huge page is still collected (D13 tail law)', () => {
  // D14-c 回归钉：首版 scanned>=6000 文档序配额让 publish 页前部烧光预算，
  // 尾部的发布按钮永远轮不到。7000 个非 custom 填充元素 + 尾部 host。
  const fillers = Array.from({ length: 7000 }, () => new FakeElement('div'))
  const publishHost = new FakeElement('xhs-publish-btn', { text: '发布' })
  const targets = runProbe({
    semantic: [],
    pointer: [],
    all: [...fillers, publishHost],
  })
  const publish = targets.find((t) => t.name === '发布')
  assert.ok(publish, 'tail custom host must survive any scan budget')
  assert.strictEqual(publish?.role, 'clickable')
})

test('over-16 custom hosts keep head 10 + tail 6 (primary CTA lives at the tail)', () => {
  const hosts = Array.from({ length: 20 }, (_, i) => new FakeElement('x-item', { text: `c${i + 1}` }))
  const targets = runProbe({ semantic: [], pointer: [], all: hosts })
  const names = targets.map((t) => t.name)
  assert.strictEqual(names.length, 16)
  assert.deepStrictEqual(names.slice(0, 10), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'])
  assert.deepStrictEqual(names.slice(10), ['c15', 'c16', 'c17', 'c18', 'c19', 'c20'])
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

// D18：act click 分支必须把点击坐标（视口 CSS px + 视口尺寸）交回工具层，
// 供 closed-shadow 无效果时升级可信指针点击。fill 等非 click 动作不带。
function runAct(nodeId: string, action: 'click' | 'fill', elements: {
  semantic: FakeElement[]
  pointer: FakeElement[]
  all: FakeElement[]
}): { ok: boolean; clickPoint: { x: number; y: number; vw: number; vh: number } | null } {
  const querySelectorAll = (selector: string): FakeElement[] => {
    if (selector === '*') return elements.all
    if (selector === 'div,span,li,p,img,svg') return elements.pointer
    if (selector.includes('a[href]') && selector.includes('h6')) return elements.semantic
    return []
  }
  const getComputedStyle = (el: FakeElement) => el.style
  class FakeEvent {
    constructor(public type: string, public opts?: unknown) {}
  }
  const sandbox = {
    document: {
      querySelectorAll,
      querySelector: () => null,
      getElementById: () => null,
      title: 'fake',
      body: { innerText: '' },
      // elementFromPoint 缺省：act JS 的穿透块 try/catch 吞掉后按原目标派发
    },
    window: { getComputedStyle, innerWidth: 1200, innerHeight: 900 },
    getComputedStyle,
    location: { href: 'https://fake.example/page', origin: 'https://fake.example' },
    Element: FakeElement,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLButtonElement: class {},
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    CSS: { escape: (s: string) => s },
    URL: class {
      origin = 'https://fake.example'
    },
  }
  return JSON.parse(JSON.stringify(vm.runInNewContext(buildBrowserActOnTargetJs(nodeId, action, 'v'), sandbox))) as {
    ok: boolean
    clickPoint: { x: number; y: number; vw: number; vh: number } | null
  }
}

test('act click returns the click point for trusted-pointer escalation', () => {
  const stashButton = new FakeElement('button', { text: '暂存离开' })
  const publishHost = new FakeElement('xhs-publish-btn', { text: '发布' })
  const result = runAct('2', 'click', {
    semantic: [stashButton],
    pointer: [],
    all: [stashButton, publishHost],
  })
  assert.strictEqual(result.ok, true)
  // rect: left 10 top 10, 120x40 → center (70, 30)；视口 1200x900
  assert.deepStrictEqual(result.clickPoint, { x: 70, y: 30, vw: 1200, vh: 900, hostShadow: 'closed_or_none' })
})

test('act fill carries no click point', () => {
  const editable = new FakeElement('div', { text: '' })
  editable.isContentEditable = true
  const stashButton = new FakeElement('button', { text: '暂存离开' })
  const result = runAct('2', 'fill', {
    semantic: [stashButton, editable],
    pointer: [],
    all: [stashButton, editable],
  })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.clickPoint, null)
})

test('act click reports hostShadow accessibility for custom hosts', () => {
  const stashButton = new FakeElement('button', { text: '暂存离开' })
  const publishHost = new FakeElement('xhs-publish-btn', { text: '发布' })
  const result = runAct('2', 'click', {
    semantic: [stashButton],
    pointer: [],
    all: [stashButton, publishHost],
  }) as unknown as { clickPoint: { hostShadow: string | null } }
  // FakeElement.shadowRoot === null → closed_or_none（closed shadow 与无 shadow 同判）
  assert.strictEqual(result.clickPoint.hostShadow, 'closed_or_none')

  const plain = runAct('1', 'click', {
    semantic: [stashButton],
    pointer: [],
    all: [stashButton],
  }) as unknown as { clickPoint: { hostShadow: string | null } }
  assert.strictEqual(plain.clickPoint.hostShadow, null)
})
