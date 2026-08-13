import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { addReadyContextReferenceToAgentInput } from '../renderer/modules/agent/chat-input-bridge'
import { useAgent, type SessionSlice } from '../renderer/stores/useAgent'
import { useWorkspace } from '../renderer/stores/useWorkspace'

const testDom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
const previousWindow = globalThis.window
const previousDocument = globalThis.document
const previousCustomEvent = globalThis.CustomEvent
Object.defineProperty(globalThis, 'window', { value: testDom.window, configurable: true })
Object.defineProperty(globalThis, 'document', { value: testDom.window.document, configurable: true })
Object.defineProperty(globalThis, 'CustomEvent', { value: testDom.window.CustomEvent, configurable: true })
process.on('exit', () => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
  if (previousDocument) Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
  if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', { value: previousCustomEvent, configurable: true })
  testDom.window.close()
})

function makeSession(scopeId: string): SessionSlice {
  return {
    messages: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    lifecyclePendingAction: null,
    lifecycleError: null,
    state: 'live',
    conversationId: scopeId,
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    inputValue: '',
  }
}

function setComposer(session: 'a' | 'b') {
  useAgent.setState({
    activeSessionId: `session-${session}`,
    sessionId: `session-${session}`,
    currentScopeId: `scope-${session}`,
    sessions: {
      'session-a': makeSession('scope-a'),
      'session-b': makeSession('scope-b'),
    },
    sessionOrder: ['session-a', 'session-b'],
    attachments: [],
    filePool: [],
  })
}

test('late file reference cannot attach to a composer selected after the request began', async () => {
  setComposer('a')
  useWorkspace.setState({ chatPanelVisible: false })

  const pending = addReadyContextReferenceToAgentInput({
    type: 'file',
    name: 'a.md',
    path: '/tmp/a.md',
  })
  setComposer('b')
  await pending

  assert.deepEqual(useAgent.getState().attachments, [])
  assert.deepEqual(useAgent.getState().filePool, [])
  assert.equal(useWorkspace.getState().chatPanelVisible, false)
})

test('file reference attaches normally while its composer stays current', async () => {
  setComposer('a')
  useWorkspace.setState({ chatPanelVisible: false })

  await addReadyContextReferenceToAgentInput({
    type: 'file',
    name: 'a.md',
    path: '/tmp/a.md',
  })

  assert.equal(useAgent.getState().attachments.length, 1)
  assert.equal(useAgent.getState().attachments[0]?.name, 'a.md')
  assert.equal(useWorkspace.getState().chatPanelVisible, true)
})
