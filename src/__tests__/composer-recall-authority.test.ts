import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import {
  useChannelSessionRecall,
  type UseChannelSessionRecallReturn,
} from '../renderer/components/agent/chat-panel/recall-state/use-channel-session-recall'
import {
  useAgent,
  type ConversationScope,
  type SessionSlice,
} from '../renderer/stores/useAgent'
import type { SessionRecallCapsule, SessionRecallHit } from '../shared/session-recall'

const testDom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
const previousWindow = globalThis.window
const previousDocument = globalThis.document
Object.defineProperty(globalThis, 'window', { value: testDom.window, configurable: true })
Object.defineProperty(globalThis, 'document', { value: testDom.window.document, configurable: true })
process.on('exit', () => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
  if (previousDocument) Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
  testDom.window.close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function makeScope(id: 'scope-a' | 'scope-b', messageVisibilityEpoch = 0): ConversationScope {
  return {
    id,
    aliasGeneration: 1,
    messageVisibilityEpoch,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: id,
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: id,
    meta: {},
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    lastMessageAt: null,
  }
}

function makeSession(scopeId: string, messageVisibilityEpoch = 0): SessionSlice {
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
    messageVisibilityEpoch,
    inputValue: '',
  }
}

function setComposerScope(id: 'scope-a' | 'scope-b', revision: number, epoch = 0) {
  const scopeA = makeScope('scope-a', id === 'scope-a' ? epoch : 0)
  const scopeB = makeScope('scope-b', id === 'scope-b' ? epoch : 0)
  useAgent.setState({
    currentAgent: 'butler',
    currentScopeId: id,
    currentScope: id === 'scope-a' ? scopeA : scopeB,
    scopes: [scopeA, scopeB],
    activeSessionId: id === 'scope-a' ? 'session-a' : 'session-b',
    sessionId: id === 'scope-a' ? 'session-a' : 'session-b',
    sessionOrder: ['session-a', 'session-b'],
    sessions: {
      'session-a': makeSession('scope-a', id === 'scope-a' ? epoch : 0),
      'session-b': makeSession('scope-b', id === 'scope-b' ? epoch : 0),
    },
    composerAuthorityRevision: revision,
  } as unknown as Parameters<typeof useAgent.setState>[0])
}

function capsule(conversationId: string): SessionRecallCapsule {
  return {
    conversationId,
    title: conversationId,
    sourceKind: 'local',
    sourceId: 'app',
    updatedAt: '2026-08-12T00:00:00.000Z',
    summary: `${conversationId} summary`,
  }
}

function hit(conversationId: string): SessionRecallHit {
  return {
    conversationId,
    lineageRootId: conversationId,
    resumeTitle: conversationId,
    title: conversationId,
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: conversationId,
    agentId: 'butler',
    activeAgentId: 'butler',
    matchedBy: ['recent'],
    score: 1,
    attachmentNames: [],
    updatedAt: '2026-08-12T00:00:00.000Z',
    sessionStatus: null,
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function withRecallHarness(
  electronAgent: Record<string, unknown>,
  run: (input: {
    getHandle: () => UseChannelSessionRecallReturn
    render: (scopeId: 'scope-a' | 'scope-b', revision: number, epoch?: number) => void
  }) => Promise<void>,
) {
  Object.defineProperty(testDom.window, 'electronAPI', {
    value: { agent: electronAgent },
    configurable: true,
  })
  let latest: UseChannelSessionRecallReturn | null = null
  let root: Root | null = createRoot(testDom.window.document.getElementById('root') as HTMLElement)

  function Harness(props: { scopeId: 'scope-a' | 'scope-b'; revision: number; epoch: number }) {
    const scope = makeScope(props.scopeId, props.epoch)
    latest = useChannelSessionRecall({
      agents: [],
      currentAgent: 'butler',
      scopes: [makeScope('scope-a'), makeScope('scope-b')],
      currentScope: scope,
      currentScopeId: props.scopeId,
      composerAuthorityRevision: props.revision,
    })
    return null
  }

  const render = (scopeId: 'scope-a' | 'scope-b', revision: number, epoch = 0) => {
    setComposerScope(scopeId, revision, epoch)
    flushSync(() => root?.render(createElement(Harness, { scopeId, revision, epoch })))
  }

  try {
    render('scope-a', 1)
    await tick()
    assert.ok(latest)
    await run({
      getHandle: () => {
        if (!latest) throw new Error('recall harness missing')
        return latest
      },
      render,
    })
  } finally {
    root?.unmount()
    root = null
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('late attached-recall list for A cannot populate B', async () => {
  const listA = deferred<{ success: boolean; data: SessionRecallCapsule[] }>()
  await withRecallHarness({
    listAttachedSessionRecallContexts: (scopeId: string) => scopeId === 'scope-a'
      ? listA.promise
      : Promise.resolve({ success: true, data: [] }),
  }, async ({ getHandle, render }) => {
    render('scope-b', 2)
    await tick()
    listA.resolve({ success: true, data: [capsule('old-a')] })
    await listA.promise
    await tick()

    assert.deepEqual(getHandle().recallState.capsules, [])
  })
})

test('attached-recall list applies normally while the composer authority stays current', async () => {
  const listA = deferred<{ success: boolean; data: SessionRecallCapsule[] }>()
  await withRecallHarness({
    listAttachedSessionRecallContexts: () => listA.promise,
  }, async ({ getHandle }) => {
    listA.resolve({ success: true, data: [capsule('kept-a')] })
    await listA.promise
    await tick()

    assert.deepEqual(getHandle().recallState.conversationIds, ['kept-a'])
  })
})

test('reset invalidates a late recall search without leaving the new composer searching', async () => {
  const searchA = deferred<{ success: boolean; data: SessionRecallHit[] }>()
  await withRecallHarness({
    listAttachedSessionRecallContexts: () => Promise.resolve({ success: true, data: [] }),
    searchSessionRecall: () => searchA.promise,
  }, async ({ getHandle, render }) => {
    const search = getHandle().recallState.runSearch('old A')
    render('scope-a', 2, 1)
    await tick()
    searchA.resolve({ success: true, data: [hit('old-a')] })
    await search
    await tick()

    assert.deepEqual(getHandle().recallState.results, [])
    assert.equal(getHandle().recallState.searching, false)
    assert.equal(getHandle().recallState.error, null)
  })
})

test('late attach response for A cannot alter B recall UI or current scope', async () => {
  const attachA = deferred<{
    success: boolean
    data: { scope: ConversationScope; capsule: SessionRecallCapsule }
  }>()
  await withRecallHarness({
    listAttachedSessionRecallContexts: () => Promise.resolve({ success: true, data: [] }),
    attachSessionRecallContext: () => attachA.promise,
  }, async ({ getHandle, render }) => {
    const attach = getHandle().recallState.attach('history-a')
    render('scope-b', 2)
    attachA.resolve({
      success: true,
      data: { scope: makeScope('scope-a'), capsule: capsule('history-a') },
    })
    await attach
    await tick()

    assert.equal(useAgent.getState().currentScopeId, 'scope-b')
    assert.deepEqual(getHandle().recallState.capsules, [])
  })
})

test('late detach response for A cannot remove B recall UI', async () => {
  const detachA = deferred<{
    success: boolean
    data: { scope: ConversationScope }
  }>()
  await withRecallHarness({
    listAttachedSessionRecallContexts: (scopeId: string) => Promise.resolve({
      success: true,
      data: scopeId === 'scope-b' ? [capsule('history-b')] : [capsule('history-a')],
    }),
    detachSessionRecallContext: () => detachA.promise,
  }, async ({ getHandle, render }) => {
    const detach = getHandle().recallState.detach('history-a')
    render('scope-b', 2)
    await tick()
    detachA.resolve({ success: true, data: { scope: makeScope('scope-a') } })
    await detach
    await tick()

    assert.deepEqual(getHandle().recallState.conversationIds, ['history-b'])
  })
})
