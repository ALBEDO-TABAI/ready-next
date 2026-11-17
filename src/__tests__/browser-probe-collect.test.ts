import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import {
  buildBrowserPageMapProbeJs,
  buildBrowserTargetFocusJs,
  buildBrowserTargetProbeJs,
  buildBrowserTargetReadJs,
} from '../main/modules/tools/browser-probe'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-probe-collect declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-probe-collect transitive sqlite load')
})

class FakeElement {
  tagName: string
  attrs: Record<string, string>
  innerText: string
  textContent: string
  style = { display: 'block', visibility: 'visible', cursor: 'auto', opacity: '1' }
  rect: { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number }
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  shadowRoot: object | null = null
  isContentEditable = false
  isConnected = true
  hidden = false
  ownerDocument: Record<string, unknown> | null = null

  constructor(tagName: string, options: {
    text?: string
    attrs?: Record<string, string>
    cursor?: string
    x?: number
    y?: number
    width?: number
    height?: number
  } = {}) {
    this.tagName = tagName.toUpperCase()
    this.attrs = options.attrs ?? {}
    this.innerText = options.text ?? ''
    this.textContent = options.text ?? ''
    this.style.cursor = options.cursor ?? 'auto'
    const x = options.x ?? 10
    const y = options.y ?? 10
    const width = options.width ?? 120
    const height = options.height ?? 40
    this.rect = { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }
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

  /** Light-DOM stand-in: the root has no host and finds no labels, as a document without matching labels does. */
  getRootNode(): { host?: FakeElement; activeElement: unknown; querySelector(selector: string): null; getElementById(id: string): null } {
    return { activeElement: this.ownerDocument?.activeElement ?? null, querySelector: () => null, getElementById: () => null }
  }

  closest(selector: string): FakeElement | null {
    if (selector === 'form' && this.tagName === 'FORM') return this
    return this.parentElement?.closest(selector) ?? null
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }
}

class FakeInputElement extends FakeElement {
  type = 'text'
  value = ''
  readOnly = false
  disabled = false
  checked = false
  focusOptions: { preventScroll?: boolean } | null = null

  constructor(options: ConstructorParameters<typeof FakeElement>[1] = {}) {
    super('input', options)
    this.type = options.attrs?.type || 'text'
  }

  override focus(options?: { preventScroll?: boolean }): void {
    this.focusOptions = options || null
    super.focus()
  }
}

interface ProbeTarget {
  role: string
  name: string
  stableNodeToken: string
  parentStableNodeToken?: string
  ancestorStableNodeTokens: string[]
  frameDocumentToken: string
  rendered: boolean
  visible: boolean
  enabled: boolean
}

function createProbeRuntime(semantic: FakeElement[]) {
  const body = new FakeElement('body')
  const documentElement = new FakeElement('html')
  const documentState: Record<string, unknown> = {
    activeElement: body,
    title: 'fake',
    readyState: 'complete',
    body,
    documentElement,
    querySelectorAll: (selector: string) => {
      if (selector.includes('a[href]') && selector.includes('h6')) return semantic
      if (selector === 'a[href]') return semantic.filter((element) => element.tagName === 'A' && element.hasAttribute('href'))
      if (selector === 'iframe,frame' || selector === 'iframe') return []
      if (selector === 'input[type="file"]') return semantic.filter((element) => element.getAttribute('type') === 'file')
      if (selector === 'input[type="password"]') return semantic.filter((element) => element.getAttribute('type') === 'password')
      if (selector.includes('[hidden]')) return []
      return []
    },
    querySelector: () => null,
    getElementById: () => null,
  }
  for (const element of [body, documentElement, ...semantic]) element.ownerDocument = documentState
  const getComputedStyle = (element: FakeElement) => element.style
  const sandbox = {
    document: documentState,
    window: { getComputedStyle, innerWidth: 1200, innerHeight: 900 },
    getComputedStyle,
    location: { href: 'https://fake.example/page', origin: 'https://fake.example', protocol: 'https:' },
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLAnchorElement: class extends FakeElement {},
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: class extends FakeElement { value = ''; readOnly = false; disabled = false },
    HTMLSelectElement: class extends FakeElement { value = ''; disabled = false },
    HTMLButtonElement: class extends FakeElement { disabled = false },
    HTMLFormElement: class extends FakeElement {},
    CSS: { escape: (value: string) => value },
    URL,
  }
  const context = vm.createContext(sandbox)
  const run = <T>(source: string): T => JSON.parse(JSON.stringify(vm.runInContext(source, context))) as T
  const pageMap = run<{
    identity: { frameDocumentToken: string }
    rawRoots: Array<{ children: ProbeTarget[] }>
  }>(buildBrowserPageMapProbeJs())
  return {
    documentState,
    pageMap,
    targets: pageMap.rawRoots[0]?.children || [],
    run,
  }
}

test('DOM fallback exposes semantic targets and ignores visual click guesses', () => {
  const button = new FakeElement('button', { text: '一键排版' })
  const pointerDiv = new FakeElement('div', { text: '写长文', cursor: 'pointer' })
  const unmarkedCustomHost = new FakeElement('xhs-publish-btn', { text: '发布' })
  const runtime = createProbeRuntime([button])

  assert.deepEqual(runtime.targets.map((target) => ({ role: target.role, name: target.name })), [
    { role: 'button', name: '一键排版' },
  ])
  assert.match(runtime.targets[0]!.stableNodeToken, /^h[0-9a-z]+$/)
  assert.equal('backendDOMNodeId' in runtime.targets[0]!, false)
  assert.equal(runtime.targets.some((target) => target.name === pointerDiv.innerText), false)
  assert.equal(runtime.targets.some((target) => target.name === unmarkedCustomHost.innerText), false)
})

test('custom hosts remain available when the page gives them an explicit role', () => {
  const publishHost = new FakeElement('xhs-publish-btn', {
    attrs: { role: 'button', 'aria-label': '发布' },
  })
  const runtime = createProbeRuntime([publishHost])

  assert.deepEqual(runtime.targets.map((target) => ({ role: target.role, name: target.name })), [
    { role: 'button', name: '发布' },
  ])
})

test('flat DOM targets keep stable ancestry and availability', () => {
  const listbox = new FakeElement('div', { text: '城市', attrs: { role: 'listbox' } })
  const option = new FakeElement('div', { text: '新加坡', attrs: { role: 'option' } })
  option.parentElement = listbox
  listbox.children.push(option)
  const runtime = createProbeRuntime([listbox, option])
  const [parent, child] = runtime.targets

  assert.equal(parent?.rendered, true)
  assert.equal(parent?.visible, true)
  assert.equal(parent?.enabled, true)
  assert.equal(child?.parentStableNodeToken, parent?.stableNodeToken)
  assert.deepEqual(child?.ancestorStableNodeTokens, [parent?.stableNodeToken])
})

test('laid-out targets outside the viewport stay rendered but are not advertised as visible', () => {
  const onScreen = new FakeInputElement({ attrs: { placeholder: '当前搜索框' }, y: 120 })
  const belowViewport = new FakeInputElement({ attrs: { placeholder: '屏幕外搜索框' }, y: 920 })
  const runtime = createProbeRuntime([onScreen, belowViewport])

  assert.equal(runtime.targets.find((target) => target.name === '当前搜索框')?.visible, true)
  assert.equal(runtime.targets.find((target) => target.name === '屏幕外搜索框')?.rendered, true)
  assert.equal(runtime.targets.find((target) => target.name === '屏幕外搜索框')?.visible, false)
})

test('target probe resolves the exact stable token and reports its geometry', () => {
  const publishHost = new FakeElement('xhs-publish-btn', {
    attrs: { role: 'button', 'aria-label': '发布' },
  })
  const runtime = createProbeRuntime([publishHost])
  const target = runtime.targets[0]!
  const result = runtime.run<{
    matchCount: number
    clickPoint: { x: number; y: number; vw: number; vh: number; hostShadow: string | null }
  }>(buildBrowserTargetProbeJs(target.stableNodeToken, target.frameDocumentToken))

  assert.equal(result.matchCount, 1)
  assert.deepEqual(result.clickPoint, {
    x: 70,
    y: 30,
    vw: 1200,
    vh: 900,
    hostShadow: 'closed_or_none',
    rect: { left: 10, top: 10, width: 120, height: 40 },
  })
})

test('numeric, wrong-document, and detached target identities are rejected', () => {
  const button = new FakeElement('button', { text: '保存' })
  const runtime = createProbeRuntime([button])
  const target = runtime.targets[0]!

  assert.equal(runtime.run<{ matchCount: number }>(buildBrowserTargetProbeJs('1')).matchCount, 0)
  assert.equal(runtime.run<{ matchCount: number }>(
    buildBrowserTargetProbeJs(target.stableNodeToken, 'wrong-document'),
  ).matchCount, 0)
  button.isConnected = false
  assert.equal(runtime.run<{ matchCount: number }>(
    buildBrowserTargetProbeJs(target.stableNodeToken, target.frameDocumentToken),
  ).matchCount, 0)
})

test('target focus resolves and focuses the exact editable without scrolling', () => {
  const input = new FakeInputElement({ attrs: { placeholder: '查询' } })
  const runtime = createProbeRuntime([input])
  const target = runtime.targets[0]!
  const result = runtime.run<{ ok: boolean; reason: string | null; kind: string; tag: string; label: string }>(
    buildBrowserTargetFocusJs(target.stableNodeToken, false, target.frameDocumentToken),
  )

  assert.deepEqual(result, { ok: true, reason: null, kind: 'editable', tag: 'input', label: '查询' })
  assert.equal(input.focusOptions?.preventScroll, true)
  assert.equal(runtime.documentState.activeElement, input)
})

test('empty contenteditable is named from its structural placeholder', () => {
  const editor = new FakeElement('div', {
    attrs: { contenteditable: 'true', 'data-placeholder': '输入文字，内容将自动保存' },
  })
  editor.isContentEditable = true
  const runtime = createProbeRuntime([editor])

  assert.equal(runtime.targets[0]?.role, 'textbox')
  assert.equal(runtime.targets[0]?.name, '输入文字，内容将自动保存')
})

test('a password field is listed as a target but what was typed into it never leaves the page', () => {
  const account = new FakeInputElement({ attrs: { type: 'text', 'aria-label': '账号' } })
  account.value = 'someone@example.com'
  const password = new FakeInputElement({ attrs: { type: 'password', 'aria-label': '密码' } })
  password.value = 'hunter2-secret'
  const runtime = createProbeRuntime([account, password])
  const [accountTarget, passwordTarget] = runtime.targets as Array<ProbeTarget & {
    value?: string
    states?: { password?: boolean }
  }>

  assert.equal(accountTarget.value, 'someone@example.com')
  assert.equal(passwordTarget.states?.password, true)
  assert.equal('value' in passwordTarget, false)
  assert.doesNotMatch(JSON.stringify(runtime.pageMap), /hunter2-secret/)

  const read = runtime.run<{ matchCount: number }>(
    buildBrowserTargetReadJs(passwordTarget.stableNodeToken, passwordTarget.frameDocumentToken),
  )
  assert.equal(read.matchCount, 1)
  assert.doesNotMatch(JSON.stringify(read), /hunter2-secret/)
})
