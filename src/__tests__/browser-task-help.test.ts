import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { BrowserAttentionActionRequest, BrowserUserAttention } from '../shared/browser-user-attention'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { useAgent } from '../renderer/stores/useAgent'
import { codexHeadActionAdmissionRef } from '../renderer/modules/agent/productTurnReceipt'
import { requestBrowserTaskReread, resetBrowserTaskWorkForTest, useBrowserTaskWork } from '../renderer/modules/browser/browser-task-work'
import { sendBrowserTaskHelp } from '../renderer/modules/browser/browser-task-help'
import { makeScopeHeadActionProjection } from './product-turn-action-projection-fixture'

// W7 T7: the help button passes ids only. Main writes the fixed sentence as the person's message and admits it like any
// message; the admission reference is the conversation head's, read the way an ordinary send reads it. A refusal is
// shown, never swallowed. Main is a stand-in answering the same calls; the stores are real.

const ATTENTION: BrowserUserAttention = {
  id: 'att-1', reason: 'login', tabId: 'tab-2', physicalTargetToken: 'token', status: 'needs_user',
  browserTaskId: 'bt-1', parentTaskId: 'task-1', ownerRunId: 'run-1',
  action: { kind: 'send_user_input', label: '我处理好了，继续', text: '我已完成登录，请重新检查页面后继续原任务。' },
}

function stand(t: TestContext, options: { head?: ReturnType<typeof makeScopeHeadActionProjection>; act?: (request: BrowserAttentionActionRequest) => Promise<unknown> } = {}) {
  const head = options.head ?? makeScopeHeadActionProjection('scope-a')
  let attention: BrowserUserAttention | null = ATTENTION
  const acts: BrowserAttentionActionRequest[] = []
  const surfaceReads: unknown[] = []
  const loaded: string[] = []
  const ingress: Array<(event: { originUserMessageId: string }) => void> = []
  const electronAPI = {
    browser: {
      getTabs: async () => [{ id: 'tab-2', browserTaskId: 'bt-1', url: 'http://x/', title: 'x', active: true }],
      getAgentSupervisionState: async () => ({ claims: [] }),
      getTaskDownloadReceipts: async () => ({ success: true, downloadReceipts: [] }),
    },
    agent: {
      getBrowserTaskAttention: async () => attention,
      getTaskProjection: async () => ({ success: false }),
      readCodexActionSurface: async (request: unknown) => {
        surfaceReads.push(request)
        return { success: true, data: { state: 'active_head', scopeId: 'scope-a', scopeEpoch: 0, sourceAliasGeneration: 1, head, lifecycle: {}, beginNewContext: null, contextBoundaries: [] } }
      },
      onIngressAdmitted: (callback: (event: { originUserMessageId: string }) => void) => {
        ingress.push(callback)
        return () => { ingress.splice(ingress.indexOf(callback), 1) }
      },
      actOnBrowserTaskAttention: async (request: BrowserAttentionActionRequest) => {
        acts.push(request)
        if (options.act) return options.act(request)
        // Main writes the message, admits it, and answers when the new run ends.
        attention = null
        for (const listener of [...ingress]) listener({ originUserMessageId: `browser-help:${request.browserTaskId}:${request.attentionId}` })
        return { success: true, disposition: 'terminal_success' }
      },
    },
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: { electronAPI, setTimeout, clearTimeout }, configurable: true })
  const agentState = useAgent.getState()
  useAgent.setState({
    currentScopeId: 'scope-a',
    scopes: [],
    messages: [],
    scopeRunStates: {},
    sessions: { 'session-a': { ...makeEmptySessionSlice('scope-a'), aliasGeneration: 1 } },
    activeSessionId: 'session-a',
    loadScope: async (scopeId: string) => { loaded.push(scopeId); return true },
    setCurrentScope: async () => {},
  })
  resetBrowserTaskWorkForTest()
  t.after(() => {
    resetBrowserTaskWorkForTest()
    useAgent.setState(agentState, true)
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  return { head, acts, surfaceReads, loaded, setAttention: (next: BrowserUserAttention | null) => { attention = next } }
}

test('the button sends ids and the head admission reference only; the need clears once Main admits the input', async t => {
  const s = stand(t)
  await requestBrowserTaskReread('mount')
  assert.equal(useBrowserTaskWork.getState().tasks['bt-1'].attention?.id, 'att-1')
  await sendBrowserTaskHelp('bt-1')
  assert.equal(s.acts.length, 1)
  assert.deepEqual(Object.keys(s.acts[0]).sort(), ['actionAdmissionRef', 'attentionId', 'browserTaskId', 'expectedAliasGeneration', 'expectedMessageVisibilityEpoch'])
  assert.deepEqual(s.acts[0], {
    browserTaskId: 'bt-1', attentionId: 'att-1', expectedMessageVisibilityEpoch: 0, expectedAliasGeneration: 1,
    actionAdmissionRef: codexHeadActionAdmissionRef(s.head),
  })
  assert.equal(JSON.stringify(s.acts[0]).includes(ATTENTION.action.text), false, 'no message text leaves the renderer')
  assert.deepEqual(s.surfaceReads, [{ aliasId: 'scope-a', aliasGeneration: 1, workbenchMode: 'browser' }])
  assert.ok(s.loaded.includes('scope-a'), 'the conversation re-reads and shows the new message')
  await requestBrowserTaskReread('acted', ['bt-1'])
  assert.equal(useBrowserTaskWork.getState().tasks['bt-1'].attention, null)
  assert.equal(useBrowserTaskWork.getState().actions['bt-1'], undefined)
})

test('an admission refusal (no usable model) stays on the card in plain words', async t => {
  const s = stand(t, { act: async () => ({ success: false, disposition: 'rejected_before_persistence', errorKind: 'current_contract_read_failed', error: 'no profile' }) })
  await requestBrowserTaskReread('mount')
  await sendBrowserTaskHelp('bt-1')
  const action = useBrowserTaskWork.getState().actions['bt-1']
  assert.equal(action?.phase, 'refused')
  assert.match(action?.message ?? '', /模型配置无法使用/)
  await requestBrowserTaskReread('poll')
  assert.equal(useBrowserTaskWork.getState().actions['bt-1']?.phase, 'refused', 'the refusal stays while the need stands')
  assert.equal(s.acts.length, 1)
})

test('Main refusing a moved conversation is shown in plain words', async t => {
  const moved = stand(t, { act: async () => { throw new Error('Error invoking remote method: browser_attention_scope_changed') } })
  await requestBrowserTaskReread('mount')
  await sendBrowserTaskHelp('bt-1')
  assert.equal(useBrowserTaskWork.getState().actions['bt-1']?.message, '这段对话已经变了，不能从这里继续。')
  assert.equal(moved.acts.length, 1)
})

test('a head that is busy refuses before anything is sent', async t => {
  const busy = stand(t, { head: makeScopeHeadActionProjection('scope-a', { activeProductFence: true }) })
  await requestBrowserTaskReread('mount')
  await sendBrowserTaskHelp('bt-1')
  assert.equal(busy.acts.length, 0)
  assert.equal(useBrowserTaskWork.getState().actions['bt-1']?.message, '助手还在忙，等这一轮结束再继续。')
})

test('a second click while the input is on its way sends nothing more', async t => {
  let release!: () => void
  const s = stand(t, { act: () => new Promise(resolve => { release = () => resolve({ success: true, disposition: 'terminal_success' }) }) })
  await requestBrowserTaskReread('mount')
  const first = sendBrowserTaskHelp('bt-1')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(useBrowserTaskWork.getState().actions['bt-1']?.phase, 'sending')
  await sendBrowserTaskHelp('bt-1')
  release()
  await first
  assert.equal(s.acts.length, 1)
})
