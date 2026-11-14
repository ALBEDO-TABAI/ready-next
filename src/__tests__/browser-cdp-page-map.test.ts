import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { buildPageMap } from '../main/modules/browser-engine/agent-browser-page-map'
import { captureBrowserCdpPageMap } from '../main/modules/browser-engine/browser-cdp-page-map-capture'
import { browserSnapshotService } from '../main/modules/browser-engine/browser-snapshot-service'
import { buildFocusedEditableProbeJs, buildTypedIntoProbeJs, callBrowserBackendTarget } from '../main/modules/tools/browser-probe'
import { captureAgentPageMap, currentBrowserPageMapAmbiguity } from '../main/modules/tools/browser-observe-tools'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function backendPage(html: string) {
  const dom = new JSDOM(html, { url: 'https://example.test/form', runScripts: 'outside-only' })
  const nodes = new Map<number, Element>()
  let sequence = 0
  const controller = {
    callFunctionOnBackendNode: async (_tabId: string, id: number, code: string, args: unknown[]) =>
      dom.window.eval(`(${code})`).apply(nodes.get(id), args),
    executeJS: async (_tabId: string, code: string) => dom.window.eval(code),
    getPhysicalTargetToken: () => 'physical-backend',
    getActiveTab: () => ({ id: 'tab-a', url: dom.window.location.href, title: 'Form', active: true }),
    getTabList: () => [{ id: 'tab-a', url: dom.window.location.href, title: 'Form', active: true }],
    getBrowserInputEnvironment: () => ({ mainWindowForeground: false, hostPresentation: 'hidden', tabActive: false }),
    getViewportMetrics: async () => ({ width: 1024, height: 768 }),
    normalizedToCss: async (_tabId: string, x: number, y: number) => ({ x: x * 1024 / 999, y: y * 768 / 999, width: 1024, height: 768 }),
    typeTextDirectly: async (_tabId: string, text: string) => {
      let el = dom.window.document.activeElement
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
      assert.ok(el instanceof dom.window.HTMLInputElement || el instanceof dom.window.HTMLTextAreaElement)
      el.setRangeText(text, el.selectionStart!, el.selectionEnd!, 'end')
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true, composed: true }))
    },
    sendCdpCommand: async (_tabId: string, method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Accessibility.getFullAXTree') {
        const parentId = (el: Element) => {
          let parent = el.parentElement
          while (parent) {
            const found = Array.from(nodes).find(([, node]) => node === parent)
            if (found) return String(found[0])
            parent = parent.parentElement
          }
          return undefined
        }
        return { nodes: Array.from(nodes, ([id, el]) => ({
          nodeId: String(id), backendDOMNodeId: id, frameId: 'main', parentId: parentId(el), childIds: Array.from(nodes).filter(([, node]) => parentId(node) === String(id)).map(([child]) => String(child)), role: { value: el.tagName === 'FORM' ? 'form' : 'generic' }, properties: [{ name: 'focusable', value: { value: true } }],
        })) }
      }
      if (method === 'DOMSnapshot.captureSnapshot') return { documents: [{ frameId: 'main', nodes: { backendNodeId: Array.from(nodes.keys()) } }] }
      throw new Error(`unexpected CDP ${method}`)
    },
    beginBrowserWorkflowAction: (input: { identity: unknown }) => ({ actionId: `a${++sequence}`, actionSeq: sequence, identity: input.identity }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: unknown) => ({ receiptId: actionId, outcome }),
  } as unknown as BrowserController
  const bind = (id: number, el: Element) => {
    nodes.set(id, el)
    el.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30, toJSON: () => ({}) })
  }
  Object.defineProperty(dom.window, 'CSS', { value: { escape: (value: string) => value } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent } })
  for (const [index, el] of Array.from(dom.window.document.querySelectorAll('input,textarea,button,form,canvas')).entries()) bind(index + 1, el)
  const call = async (name: string, args: Record<string, unknown>) => executeBrowserTool(name, { tab_id: 'tab-a', ...args }, controller,
    undefined, undefined, undefined, undefined, undefined,
    { ownerRunId: 'run', browserTaskId: 'task', parentTaskId: 'parent', inputSource: 'trusted_internal' }) as Promise<ToolExecutionOutput>
  return { dom, controller, bind, call }
}

test('fill_form writes email, number, date, checkbox and radio, then submits a textarea form exactly once', async () => {
  const { dom, controller, call } = backendPage(`<form><input type="email" aria-label="邮箱"><input type="number" aria-label="数量"><input type="date" aria-label="日期"><input type="datetime-local" aria-label="时间"><input type="month" aria-label="月份"><input type="time" aria-label="时刻"><input type="week" aria-label="星期"><input type="checkbox" aria-label="订阅"><input type="radio" name="kind" value="standard" aria-label="普通"><textarea aria-label="留言"></textarea><button id="submit">提交</button></form>`)
  try {
    const submissions: FormData[] = []
    let submitter = ''
    dom.window.document.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault()
      submitter = (event as SubmitEvent).submitter?.id || ''
      submissions.push(new dom.window.FormData(event.target as HTMLFormElement))
    })
    const snapshot = await captureAgentPageMap(controller, 'tab-a', 60000)
    const targets = (snapshot.pageMap as { targets: Array<{ targetId: string; name: string }> }).targets
    const values = [['邮箱', 'bai@example.test'], ['数量', '42'], ['日期', '2026-11-14'], ['时间', '2026-11-14T12:34'], ['月份', '2026-11'], ['时刻', '12:34'], ['星期', '2026-W46'], ['订阅', true], ['普通', true], ['留言', '正文\n末行']] as const
    const filled = await call('browser_fill_form', { fields: values.map(([name, value]) => ({ target_id: targets.find(target => target.name === name)!.targetId, value })), submit: true })
    assert.equal(filled.data?.ok, true, filled.text)
    assert.equal(filled.data?.submitted, true)
    assert.equal(submissions.length, 1)
    assert.equal(submitter, 'submit')
    assert.deepEqual(Array.from(dom.window.document.querySelectorAll('input')).map(el => el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value), ['bai@example.test', '42', '2026-11-14', '2026-11-14T12:34', '2026-11', '12:34', '2026-W46', true, true])
    assert.equal(dom.window.document.querySelector('textarea')!.value, '正文\n末行')
    const invalid = await call('browser_type', { target_id: targets.find(target => target.name === '数量')!.targetId, text: 'not-a-number' })
    assert.equal(invalid.data?.ok, false)
    assert.equal(dom.window.document.querySelector('input[type="number"]')!.getAttribute('type'), 'number')
    assert.equal((dom.window.document.querySelector('input[type="number"]') as HTMLInputElement).value, '42')
    const number = dom.window.document.querySelector('input[type="number"]') as HTMLInputElement
    number.readOnly = true
    const readOnly = await call('browser_type', { target_id: targets.find(target => target.name === '数量')!.targetId, text: '43' })
    assert.equal(readOnly.data?.ok, false)
    assert.equal(number.value, '42')
    const unchecked = await call('browser_fill_form', { fields: [{ target_id: targets.find(target => target.name === '订阅')!.targetId, value: false }] })
    assert.equal(unchecked.data?.ok, true)
    assert.equal((dom.window.document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, false)
    assert.equal(submissions.length, 1)
  } finally { dom.window.close() }
})

test('budgeted snapshots retain container refs through find, and different table rows are not ambiguous', async () => {
  const { dom, controller, call } = backendPage('<table><tr><th>甲帖子</th><td><form><button>删除</button></form></td></tr><tr><th>乙帖子</th><td><form><button>删除</button></form></td></tr></table>')
  try {
    const snapshot = await captureAgentPageMap(controller, 'tab-a', 60000)
    const targets = (snapshot.pageMap as { targets: Array<{ role: string; targetId: string }> }).targets
    const form = targets.filter(target => target.role === 'form')[1]
    const found = await call('browser_find', { query: '删除', within_target_id: form.targetId })
    assert.equal(found.data?.ok, true, found.text)
    assert.equal(found.data?.count, 1)
    const button = (found.data?.matches as Array<{ targetId: string }>)[0]
    assert.equal(currentBrowserPageMapAmbiguity(controller, 'tab-a', button.targetId), null)
    const clicked = await call('browser_click', { target_id: button.targetId })
    // A hidden host is rejected as unpresented before foreground is checked.
    assert.equal(clicked.data?.errorKind, 'browser_surface_required', clicked.text)
    assert.equal(clicked.data?.delivery, 'not_delivered')
    assert.equal(clicked.data?.mayHaveCommitted, false)
  } finally { dom.window.close() }
})

test('selector fields focus their exact native control and submit only its form even when the last field is a checkbox', async () => {
  const { dom, controller, call } = backendPage('<form id="other"><input></form><form id="chosen"><input id="email" type="email"><input id="check" type="checkbox"><button>提交</button></form>')
  try {
    const submitted: string[] = []
    for (const form of dom.window.document.querySelectorAll('form')) form.addEventListener('submit', event => { event.preventDefault(); submitted.push(form.id) })
    await captureAgentPageMap(controller, 'tab-a')
    const result = await call('browser_fill_form', { fields: [{ selector: '#email', value: 'bai@example.test' }, { selector: '#check', value: true }], submit: true })
    assert.equal(result.data?.ok, true, result.text)
    assert.equal(result.data?.submitted, true)
    assert.deepEqual(submitted, ['chosen'])
    assert.equal(dom.window.document.activeElement?.id, 'check')
  } finally { dom.window.close() }
})

test('backend snapshots preserve native checkbox/radio roles and false checked state and focusable canvas', async () => {
  const { dom, controller, bind } = backendPage('<input type="checkbox" aria-label="订阅"><input type="radio" checked aria-label="普通"><canvas tabindex="0" aria-label="选座画布"></canvas>')
  try {
    for (const [index, el] of Array.from(dom.window.document.querySelectorAll('input,canvas')).entries()) {
      bind(index + 1, el)
      const result = await callBrowserBackendTarget(controller, 'tab-a', index + 1, 'probe', { roleHint: 'generic' }) as { target: { role: string; states: { checked?: boolean } } }
      assert.equal(result.target.role, ['checkbox', 'radio', 'canvas'][index])
      if (index < 2) assert.equal(result.target.states.checked, index === 1)
    }
  } finally { dom.window.close() }
})

test('backend shadow target keeps its host label and deep focus through typing readback', async () => {
  const { dom, controller, bind } = backendPage('<label for="recipient">收件人</label><eval-field id="recipient"></eval-field>')
  try {
    const host = dom.window.document.querySelector('eval-field')!
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<input>'
    const input = root.querySelector('input')!
    bind(1, input)
    const probe = await callBrowserBackendTarget(controller, 'tab-a', 1, 'probe') as { target: { name: string } }
    assert.equal(probe.target.name, '收件人')
    const focused = await callBrowserBackendTarget(controller, 'tab-a', 1, 'focus') as { ok: boolean }
    assert.equal(focused.ok, true)
    assert.equal(dom.window.eval(buildFocusedEditableProbeJs()).kind, 'editable')
    input.value = '张三'
    assert.equal(dom.window.eval(buildTypedIntoProbeJs('张三')).textMatchesExpected, true)
    host.previousElementSibling!.textContent = '新收件人'
    const changed = await callBrowserBackendTarget(controller, 'tab-a', 1, 'probe') as { target: { name: string } }
    assert.equal(changed.target.name, '新收件人', 'a changed label must remain visible to identity verification')
  } finally { dom.window.close() }
})

test('fill_form writes the shadow input and submits its outer form without pointer input', async () => {
  const { dom, controller, bind, call } = backendPage('<form><eval-field></eval-field><button>提交</button></form>')
  try {
    const root = dom.window.document.querySelector('eval-field')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<label for="recipient">收件人<input id="recipient"></label>'
    const input = root.querySelector('input')!
    bind(99, input)
    let submitted = ''
    dom.window.document.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); submitted = input.value })
    const snapshot = await captureAgentPageMap(controller, 'tab-a', 60000)
    const target = (snapshot.pageMap as { targets: Array<{ name: string; targetId: string }> }).targets.find(item => item.name === '收件人')!
    const result = await call('browser_fill_form', { fields: [{ target_id: target.targetId, value: '张三' }], submit: true })
    assert.equal(result.data?.ok, true, result.text)
    assert.equal(result.data?.submitted, true)
    assert.equal(submitted, '张三')
  } finally { dom.window.close() }
})

test('backend row context distinguishes same-name buttons by the row header', async () => {
  const { dom, controller, bind } = backendPage('<table><tr><th>甲帖子</th><td><button>删除</button></td></tr><tr><th>乙帖子</th><td><button>删除</button></td></tr></table>')
  try {
    const contexts: string[] = []
    for (const [index, el] of Array.from(dom.window.document.querySelectorAll('button')).entries()) {
      bind(index + 1, el)
      const result = await callBrowserBackendTarget(controller, 'tab-a', index + 1, 'probe') as { target: { ancestorContext: string } }
      contexts.push(result.target.ancestorContext)
    }
    assert.match(contexts[0], /甲帖子/)
    assert.match(contexts[1], /乙帖子/)
    assert.notEqual(contexts[0], contexts[1])
  } finally { dom.window.close() }
})

test('CDP capture keeps delegated targets beyond an old fixed scan cap and resolves the backend node for action', async () => {
  browserSnapshotService.resetForTests()
  const delegatedIds = Array.from({ length: 250 }, (_, index) => 1_000 + index)
  const backendCalls: Array<{ id: number; operation: string }> = []
  const cdpCalls: Array<{ method: string; params: unknown }> = []
  const controller = {
    getActiveTab: () => ({ id: 'tab-a' }),
    getPhysicalTargetToken: () => 'physical-a',
    executeJS: async () => ({
      url: 'https://example.test/page',
      title: 'Page',
      timeOrigin: 10,
      mutationRevision: 0,
      frameDocumentToken: 'document-a',
    }),
    sendCdpCommand: async (_tabId: string | null, method: string, params?: unknown) => {
      cdpCalls.push({ method, params })
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main-frame' } } }
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: 'root', frameId: 'main-frame', role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 10 },
            { nodeId: 'child-frame-button', frameId: 'child-frame', role: { value: 'button' }, name: { value: 'wrong-frame' }, backendDOMNodeId: 9_000 },
          ],
        }
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          documents: [
            {
              frameId: 'main-frame',
              nodes: {
                backendNodeId: [10, ...delegatedIds],
                isClickable: { index: delegatedIds.map((_, index) => index + 1) },
              },
            },
            {
              frameId: 'child-frame',
              nodes: {
                backendNodeId: [9_000, 9_001],
                isClickable: { index: [0, 1] },
              },
            },
          ],
        }
      }
      throw new Error(`unexpected CDP method ${method}`)
    },
    callFunctionOnBackendNode: async (
      _tabId: string | null,
      backendDOMNodeId: number,
      _functionDeclaration: string,
      args: unknown[],
    ) => {
      const operation = String(args[0] || '')
      backendCalls.push({ id: backendDOMNodeId, operation })
      return {
        matchCount: 1,
        disabled: false,
        target: {
          role: 'clickable',
          name: `delegated-${backendDOMNodeId - 1_000}`,
          box: { x: 10, y: 20, width: 40, height: 20 },
          visible: true,
          enabled: true,
          editable: false,
        },
      }
    },
  } as unknown as BrowserController

  const payload = await browserSnapshotService.capture(controller, 'tab-a', 8_192, async (generation) => {
    const captured = await captureBrowserCdpPageMap(controller, 'tab-a', async (backendDOMNodeId, roleHint) => {
      const result = await callBrowserBackendTarget(controller, 'tab-a', backendDOMNodeId, 'probe', { roleHint }) as { target?: Record<string, unknown> }
      return result.target || null
    })
    assert.ok(captured)
    const pageMap = buildPageMap(captured.rawRoots, {
      generation,
      viewport: { width: 1_000, height: 800 },
      maxBytes: 4_096,
    })
    return { pageMap }
  }, { force: true })

  assert.equal((payload.pageMap as { totalTargets?: number }).totalTargets, 250)
  assert.deepEqual(
    cdpCalls.find((call) => call.method === 'Accessibility.getFullAXTree')?.params,
    { frameId: 'main-frame' },
  )
  assert.equal(backendCalls.some((call) => call.id >= 9_000), false, 'subframe nodes must use the frame-bound probe path')
  const found = browserSnapshotService.find(controller, 'tab-a', {
    query: 'delegated-125',
    purpose: 'action',
    limit: 10,
  })
  assert.equal(found?.matches.length, 1)
  const target = found!.matches[0]
  assert.equal(target.backendDOMNodeId, 1_125)
  const resolved = await browserSnapshotService.resolveRef(controller, 'tab-a', target.targetId)
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  assert.match(resolved.rawTargetId, /:b1125$/)

  await callBrowserBackendTarget(controller, 'tab-a', 1_125, 'probe', { roleHint: 'clickable' })
  assert.deepEqual(backendCalls.at(-1), { id: 1_125, operation: 'probe' })
})
