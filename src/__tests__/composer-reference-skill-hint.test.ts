import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { useReferenceSkillHint } from '../renderer/components/agent/chat-panel/reference-skill/use-reference-skill-hint'
import { useAgent, type SessionSlice } from '../renderer/stores/useAgent'
import type { ReferenceSkillHintData } from '../renderer/types/electron'

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

function makeSession(scopeId: string, generation: number, epoch: number): SessionSlice {
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
    aliasGeneration: generation,
    messageVisibilityEpoch: epoch,
    inputValue: '',
  }
}

function setComposer(scope: 'a' | 'b', revision: number, generation = 1, epoch = 0) {
  useAgent.setState({
    activeSessionId: `session-${scope}`,
    sessionId: `session-${scope}`,
    currentScopeId: `scope-${scope}`,
    sessions: {
      'session-a': makeSession('scope-a', scope === 'a' ? generation : 1, scope === 'a' ? epoch : 0),
      'session-b': makeSession('scope-b', scope === 'b' ? generation : 1, scope === 'b' ? epoch : 0),
    },
    sessionOrder: ['session-a', 'session-b'],
    composerAuthorityRevision: revision,
  } as unknown as Parameters<typeof useAgent.setState>[0])
}

const hintA: ReferenceSkillHintData = {
  id: 'skill-a',
  name: 'Skill A',
  at: 1,
  expiresAt: 10,
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function withHintHarness(
  agentApi: Record<string, unknown>,
  run: (input: {
    getHint: () => ReferenceSkillHintData | null
    render: (scope: 'a' | 'b', revision: number, generation?: number, epoch?: number) => void
  }) => Promise<void>,
) {
  Object.defineProperty(testDom.window, 'electronAPI', {
    value: { agent: agentApi },
    configurable: true,
  })
  let latest: ReferenceSkillHintData | null = null
  const root = createRoot(testDom.window.document.getElementById('root') as HTMLElement)
  function Harness(props: { scope: 'a' | 'b'; revision: number; generation: number; epoch: number }) {
    latest = useReferenceSkillHint({
      activeSessionId: `session-${props.scope}`,
      currentScopeId: `scope-${props.scope}`,
      composerAuthorityRevision: props.revision,
      aliasGeneration: props.generation,
      messageVisibilityEpoch: props.epoch,
      currentScopeRunUpdatedAt: null,
      isStreaming: false,
    })
    return null
  }
  const render = (scope: 'a' | 'b', revision: number, generation = 1, epoch = 0) => {
    setComposer(scope, revision, generation, epoch)
    flushSync(() => root.render(createElement(Harness, { scope, revision, generation, epoch })))
  }

  try {
    render('a', 1)
    await tick()
    await run({ getHint: () => latest, render })
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('late reference skill hint for A cannot appear in B', async () => {
  const oldA = deferred<{ success: boolean; data: ReferenceSkillHintData | null }>()
  await withHintHarness({
    getReferenceSkillHint: (scopeId: string) => scopeId === 'scope-a'
      ? oldA.promise
      : Promise.resolve({ success: true, data: null }),
  }, async ({ getHint, render }) => {
    render('b', 2)
    await tick()
    oldA.resolve({ success: true, data: hintA })
    await oldA.promise
    await tick()

    assert.equal(getHint(), null)
  })
})

test('reset invalidates a late reference skill hint in the same scope', async () => {
  const oldA = deferred<{ success: boolean; data: ReferenceSkillHintData | null }>()
  let calls = 0
  await withHintHarness({
    getReferenceSkillHint: () => {
      calls += 1
      return calls === 1 ? oldA.promise : Promise.resolve({ success: true, data: null })
    },
  }, async ({ getHint, render }) => {
    render('a', 2, 2, 1)
    await tick()
    oldA.resolve({ success: true, data: hintA })
    await oldA.promise
    await tick()

    assert.equal(getHint(), null)
  })
})

test('reference skill hint applies normally while its composer stays current', async () => {
  const current = deferred<{ success: boolean; data: ReferenceSkillHintData | null }>()
  await withHintHarness({
    getReferenceSkillHint: () => current.promise,
  }, async ({ getHint }) => {
    current.resolve({ success: true, data: hintA })
    await current.promise
    await tick()

    assert.equal(getHint()?.id, 'skill-a')
  })
})
