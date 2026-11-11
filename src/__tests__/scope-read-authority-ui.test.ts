import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  localStorage: globalThis.localStorage,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  matchMedia: globalThis.matchMedia,
  getComputedStyle: globalThis.getComputedStyle,
}

function installGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

installGlobal('window', dom.window)
installGlobal('document', dom.window.document)
installGlobal('navigator', dom.window.navigator)
installGlobal('HTMLElement', dom.window.HTMLElement)
installGlobal('Element', dom.window.Element)
installGlobal('Node', dom.window.Node)
installGlobal('MutationObserver', dom.window.MutationObserver)
installGlobal('localStorage', dom.window.localStorage)
installGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  callback(0)
  return 0
})
installGlobal('cancelAnimationFrame', () => undefined)
installGlobal('matchMedia', dom.window.matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
}))
installGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
;(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined

function channelProxy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property)
      if (property in target) return target[property]
      if (property.startsWith('on')) {
        const subscribe = () => () => undefined
        target[property] = subscribe
        return subscribe
      }
      const call = async () => ({ success: false })
      target[property] = call
      return call
    },
  })
}

const agentApi = channelProxy({
  listConversationScopes: () => new Promise(() => undefined),
  listAttachedSessionRecallContexts: async () => ({ success: true, data: [] }),
  listActiveChildRuns: async () => ({ success: true, data: [] }),
  listScopeRuns: async () => ({ success: true, data: [] }),
  listTaskProjections: async () => ({ success: true, data: [] }),
})

;(dom.window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  agent: agentApi,
  agentInteraction: channelProxy({
    listPendingAskUserQuestions: async () => ({ success: true, data: [] }),
  }),
  tools: channelProxy({ logToolEvent: () => undefined }),
  settings: channelProxy(),
  chat: channelProxy(),
  document: channelProxy(),
  pet: channelProxy(),
  memory: channelProxy(),
  browser: channelProxy(),
  ui: channelProxy(),
}

const { MemoryRouter } = await import('react-router-dom')
const { useAgent } = await import('../renderer/stores/useAgent')
const { makeEmptySessionSlice } = await import('../renderer/stores/agent-store-helpers')
const ChatPanel = (await import('../renderer/components/agent/ChatPanel')).default
const TaskPanel = (await import('../renderer/components/ready/TaskPanel')).default
const { useTaskInteractionHandlers } = await import(
  '../renderer/components/agent/chat-panel/task-interaction/use-task-interaction-handlers'
)
const { taskProjectionToTaskCardRun } = await import(
  '../renderer/components/agent/task-card-from-projection'
)
const { createAgentPanelTestHarness } = await import(
  '../renderer/modules/agent/agent-panel-test-harness-driver'
)

process.on('exit', () => {
  for (const [name, value] of Object.entries(previousGlobals)) {
    if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[name]
    else installGlobal(name, value)
  }
  dom.window.close()
})

function makeScope(aliasGeneration = 1, messageVisibilityEpoch = 0) {
  return {
    id: 'scope-authority-ui',
    aliasGeneration,
    messageVisibilityEpoch,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: 'Authority UI',
    sourceKind: 'local' as const,
    sourceId: 'app',
    threadKey: 'scope-authority-ui',
    meta: {},
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    lastMessageAt: null,
  }
}

function seedScope(aliasGeneration = 1, messageVisibilityEpoch = 0, revision = 20): void {
  const scope = makeScope(aliasGeneration, messageVisibilityEpoch)
  const messages = [{
    id: 'authority-user-message',
    agent: 'butler',
    content: 'run authority task',
    type: 'user' as const,
    timestamp: new Date('2026-08-12T00:00:00.000Z'),
  }]
  const session = {
    ...makeEmptySessionSlice(scope.id),
    messages,
    aliasGeneration,
    messageVisibilityEpoch,
  }
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle' }],
    currentAgent: 'butler',
    messages,
    currentScopeId: scope.id,
    currentScope: scope,
    scopes: [scope],
    conversations: [],
    conversationId: scope.id,
    scopeRunStates: {},
    inputValue: '',
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    retiredScopeIds: {},
    scopeAuthorityRevision: revision,
    composerAuthorityRevision: revision,
    sessions: { 'session-authority-ui': session },
    activeSessionId: 'session-authority-ui',
    sessionId: 'session-authority-ui',
    sessionOrder: ['session-authority-ui'],
    taskDisclosureState: {},
  })
}

function seedBackgroundTarget(): void {
  const scopeA = makeScope()
  const scopeB = {
    ...makeScope(),
    id: 'scope-authority-ui-b',
    title: 'Authority UI B',
    threadKey: 'scope-authority-ui-b',
  }
  const sessionA = { ...makeEmptySessionSlice(scopeA.id), aliasGeneration: 1, messageVisibilityEpoch: 0 }
  const sessionB = { ...makeEmptySessionSlice(scopeB.id), aliasGeneration: 1, messageVisibilityEpoch: 0 }
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle' }],
    currentAgent: 'butler',
    messages: [],
    currentScopeId: scopeB.id,
    currentScope: scopeB,
    scopes: [scopeA, scopeB],
    conversations: [],
    conversationId: scopeB.id,
    scopeRunStates: {},
    inputValue: '',
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    retiredScopeIds: {},
    scopeAuthorityRevision: 80,
    composerAuthorityRevision: 80,
    sessions: { 'session-authority-a': sessionA, 'session-authority-b': sessionB },
    activeSessionId: 'session-authority-b',
    sessionId: 'session-authority-b',
    sessionOrder: ['session-authority-a', 'session-authority-b'],
    taskDisclosureState: {},
  })
}

function advanceScope(aliasGeneration: number, messageVisibilityEpoch: number, bumpRevision: boolean): void {
  flushSync(() => {
    useAgent.setState((state) => {
      const scope = makeScope(aliasGeneration, messageVisibilityEpoch)
      return {
        currentScope: scope,
        scopes: [scope],
        currentScopeId: scope.id,
        scopeRunStates: {},
        scopeAuthorityRevision: state.scopeAuthorityRevision + (bumpRevision ? 1 : 0),
        composerAuthorityRevision: state.composerAuthorityRevision + (bumpRevision ? 1 : 0),
        sessions: {
          ...state.sessions,
          'session-authority-ui': {
            ...state.sessions['session-authority-ui'],
            conversationId: scope.id,
            aliasGeneration,
            messageVisibilityEpoch,
            scopeRunStates: {},
          },
        },
      }
    })
  })
}

function makeProjection(title: string, messageVisibilityEpoch: number) {
  return {
    taskId: `task-${title}`,
    scopeId: 'scope-authority-ui',
    messageVisibilityEpoch,
    runId: `run-${title}`,
    taskType: 'multi_step_task',
    module: 'document',
    taskTitle: title,
    taskSummary: `${title} summary`,
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [
      { id: 'one', description: 'one', title: 'one', status: 'done', updatedAt: '2026-08-12T00:00:00.500Z' },
      { id: 'two', description: 'two', title: 'two', status: 'running', updatedAt: '2026-08-12T00:00:01.000Z' },
    ],
    currentStepId: 'two',
    progress: { current: 1, total: 2, unit: 'steps', updatedAt: '2026-08-12T00:00:01.000Z' },
    resumableActions: [],
    recentArtifacts: [],
    continuationRef: null,
    updatedAt: '2026-08-12T00:00:01.000Z',
  }
}

function makeScopeRun(title: string, messageVisibilityEpoch: number) {
  return {
    scopeId: 'scope-authority-ui',
    messageVisibilityEpoch,
    agent: 'butler',
    title,
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-authority-ui',
    phase: 'tool_running',
    taskId: `task-${title}`,
    taskTitle: title,
    taskSummary: `${title} summary`,
    updatedAt: '2026-08-12T00:00:01.000Z',
  }
}

function makeActiveChild(messageVisibilityEpoch: number) {
  return {
    childRunId: 'old-child',
    skillId: 'old-skill',
    sessionId: 'session-authority-ui',
    scopeId: 'scope-authority-ui',
    messageVisibilityEpoch,
    status: 'running',
    startedAt: '2026-08-12T00:00:00.000Z',
    outputDir: '/tmp/old-child',
    runStatePath: '/tmp/old-child/run_state.json',
    progress: { stage: 'prepare', detail: 'OLD CHILD SHOULD NOT RETURN', updatedAt: '2026-08-12T00:00:01.000Z' },
    blockedReason: null,
    liveness: 'background',
    closeStatus: null,
  }
}

function mount(element: ReturnType<typeof createElement>) {
  const host = document.getElementById('root')!
  host.innerHTML = ''
  const container = document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(MemoryRouter, { initialEntries: ['/workbench'] }, element))
  })
  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

let taskHandlers: ReturnType<typeof useTaskInteractionHandlers> | null = null

function TaskHandlerHarness(props: Parameters<typeof useTaskInteractionHandlers>[0]) {
  taskHandlers = useTaskInteractionHandlers(props)
  return null
}

function mountTaskHandlers(
  mergedTaskRuns: Parameters<typeof useTaskInteractionHandlers>[0]['mergedTaskRuns'],
  _loadConversation: ReturnType<typeof useAgent.getState>['loadConversation'],
) {
  taskHandlers = null
  const mounted = mount(createElement(TaskHandlerHarness, {
    mergedTaskRuns,
    setInputValue: useAgent.getState().setInputValue,
    setPersistedScopeRuns: () => undefined,
    focusInputWithResize: () => undefined,
    refreshPersistedScopeRuns: async () => undefined,
    refreshPersistedTaskProjections: async () => undefined,
    refreshActiveChildRuns: async () => undefined,
  }))
  assert.ok(taskHandlers)
  return mounted
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail('condition was not reached')
}

test('ChatPanel rejects old scope runs, projections, and active children after reset', async () => {
  seedScope()
  const oldRuns = deferred<{ success: boolean; data: unknown[] }>()
  const oldProjections = deferred<{ success: boolean; data: unknown[] }>()
  const oldChildren = deferred<{ success: boolean; data: unknown[] }>()
  let runCalls = 0
  let projectionCalls = 0
  let childCalls = 0
  agentApi.listScopeRuns = () => (++runCalls === 1 ? oldRuns.promise : Promise.resolve({ success: true, data: [] }))
  agentApi.listTaskProjections = () => (++projectionCalls === 1 ? oldProjections.promise : Promise.resolve({ success: true, data: [] }))
  agentApi.listActiveChildRuns = () => (++childCalls === 1 ? oldChildren.promise : Promise.resolve({ success: true, data: [] }))

  const mounted = mount(createElement(ChatPanel, { shellWidth: 380, panelState: 'expanded' }))
  try {
    await waitFor(() => runCalls >= 1 && projectionCalls >= 1 && childCalls >= 1)
    advanceScope(2, 1, true)
    await waitFor(() => runCalls >= 2 && projectionCalls >= 2 && childCalls >= 2)

    oldRuns.resolve({ success: true, data: [makeScopeRun('OLD SCOPE RUN SHOULD NOT RETURN', 0)] })
    oldProjections.resolve({ success: true, data: [makeProjection('OLD PROJECTION SHOULD NOT RETURN', 0)] })
    oldChildren.resolve({ success: true, data: [makeActiveChild(0)] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.doesNotMatch(mounted.container.textContent || '', /OLD .* SHOULD NOT RETURN/)
  } finally {
    mounted.unmount()
  }
})

test('ChatPanel accepts a late read across same-epoch alias rollover', async () => {
  seedScope(1, 0, 40)
  const pendingRuns = deferred<{ success: boolean; data: unknown[] }>()
  const pendingProjections = deferred<{ success: boolean; data: unknown[] }>()
  let runCalls = 0
  let projectionCalls = 0
  agentApi.listScopeRuns = () => {
    runCalls += 1
    return pendingRuns.promise
  }
  agentApi.listTaskProjections = () => {
    projectionCalls += 1
    return pendingProjections.promise
  }
  agentApi.listActiveChildRuns = async () => ({ success: true, data: [] })

  const mounted = mount(createElement(ChatPanel, { shellWidth: 380, panelState: 'expanded' }))
  try {
    await waitFor(() => runCalls >= 1 && projectionCalls >= 1)
    advanceScope(2, 0, false)
    pendingRuns.resolve({ success: true, data: [makeScopeRun('SAME EPOCH CARD', 0)] })
    pendingProjections.resolve({ success: true, data: [makeProjection('SAME EPOCH CARD', 0)] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.match(mounted.container.textContent || '', /SAME EPOCH CARD/)
  } finally {
    mounted.unmount()
  }
})

test('TaskPanel latest empty response wins an old pre-reset projection response', async () => {
  seedScope(1, 0, 60)
  const oldProjections = deferred<{ success: boolean; data: unknown[] }>()
  let calls = 0
  agentApi.listTaskProjections = () => (++calls === 1
    ? oldProjections.promise
    : Promise.resolve({ success: true, data: [] }))

  const mounted = mount(createElement(TaskPanel))
  try {
    await waitFor(() => calls >= 1)
    advanceScope(2, 1, true)
    await waitFor(() => calls >= 2)
    oldProjections.resolve({ success: true, data: [makeProjection('OLD TASK PANEL CARD', 0)] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.doesNotMatch(mounted.container.textContent || '', /OLD TASK PANEL CARD/)
  } finally {
    mounted.unmount()
  }
})

test('background detached continuation is absent from the live task handlers', () => {
  seedBackgroundTarget()
  const mounted = mountTaskHandlers([], useAgent.getState().loadConversation)
  try {
    assert.equal('handleContinueDetachedTask' in taskHandlers!, false)
    assert.equal(typeof taskHandlers!.handleCancelDetachedTask, 'function')
  } finally {
    mounted.unmount()
  }
})

test('task handlers expose no generic retry producer after reset retirement', () => {
  seedBackgroundTarget()
  const mounted = mountTaskHandlers([], useAgent.getState().loadConversation)
  try {
    assert.equal('handleRetryTask' in taskHandlers!, false)
    assert.equal(useAgent.getState().pendingContinuationIntent, null)
  } finally {
    mounted.unmount()
  }
})

test('retired confirmation, suspend, resume, and takeover actions stay absent', () => {
  seedScope(2, 0, 100)
  const mounted = mountTaskHandlers([], useAgent.getState().loadConversation)
  try {
    assert.equal('handleSubmitTaskConfirmation' in taskHandlers!, false)
    assert.equal('handleSuspendTask' in taskHandlers!, false)
    assert.equal('handleResumeTask' in taskHandlers!, false)
    assert.equal('handleSubmitTaskAgentResult' in taskHandlers!, false)
  } finally {
    mounted.unmount()
  }
})

test('agent panel test snapshot rejects a projection response from the pre-reset epoch', async () => {
  seedScope(1, 0, 120)
  const pending = deferred<{ success: boolean; data: unknown[] }>()
  agentApi.listTaskProjections = () => pending.promise
  const harness = createAgentPanelTestHarness(useAgent)
  try {
    const reading = harness.snapshot()
    advanceScope(2, 1, true)
    pending.resolve({ success: true, data: [makeProjection('OLD HARNESS CARD', 0)] })
    const snapshot = await reading
    assert.equal(snapshot.currentScopeId, 'scope-authority-ui')
    assert.equal(snapshot.taskCards.some((card) => /OLD HARNESS CARD/.test(card.title)), false)
  } finally {
    harness.dispose()
  }
})
