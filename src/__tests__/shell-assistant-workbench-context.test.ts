import assert from 'node:assert/strict'
import test from 'node:test'
import { useAgent } from '../renderer/stores/useAgent'
import { useMode } from '../renderer/stores/useMode'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { makeScopeHeadActionProjection } from './product-turn-action-projection-fixture'
import type { SendScopedRequest, SendScopedResponse } from '../shared/ipc-contracts/agent-runtime'

// Exercise ChatPanel's real sendMessage path; only the Main IPC boundary is replaced.
// Restoring seeded renderer singletons is test-only and never runs during a live session.
export const __breaksInvariants = ['renderer.agent-and-mode-singletons.seeded-between-isolated-tests'] as const

test('assistant sends the current RSS work surface to Main and reads a later mode change at send time', async t => {
  const previousAgent = useAgent.getState(), previousMode = useMode.getState()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: SendScopedRequest[] = []
  const sendScoped = async (request: SendScopedRequest): Promise<SendScopedResponse> => {
    requests.push(request)
    // Stop at Main admission: this test neither persists messages nor invokes a provider.
    return { success: false, disposition: 'rejected_before_persistence', ownerRunId: null,
      retryableByUser: false, persistence: { scope: 'none', message: 'none', attachments: 'none', inputAttachments: 'none' },
      errorKind: 'conversation_reset_required', error: 'fixture_admission_boundary', admissionEvidenceDigest: 'fixture' }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { agent: { sendScoped } } } })
  t.after(() => {
    useAgent.setState(previousAgent, true); useMode.setState(previousMode, true)
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const scope = { id: 'shell-context', aliasGeneration: 1, messageVisibilityEpoch: 0, agent: 'butler',
    title: '外壳测试', sourceKind: 'local' as const, sourceId: 'app', threadKey: 'shell-context',
    meta: {}, createdAt: '', updatedAt: '', lastMessageAt: null }
  const slice = { ...makeEmptySessionSlice(scope.id), aliasGeneration: 1, inputValue: '整理当前资料',
    scopeHeadActionProjection: makeScopeHeadActionProjection(scope.id) }
  useAgent.setState({ ...slice, currentAgent: 'butler', currentScopeId: scope.id, currentScope: scope,
    scopes: [scope], activeSessionId: 'shell-session', sessionId: 'shell-session',
    sessionOrder: ['shell-session'], sessions: { 'shell-session': slice }, retiredScopeIds: {},
    pendingContinuationIntent: null })
  for (const mode of ['rss', 'calendar'] as const) {
    useMode.setState({ workbenchMode: mode, splitMode: 'browser' })
    await useAgent.getState().sendMessage('整理当前资料')
    assert.equal(requests.length, mode === 'rss' ? 1 : 2)
    assert.equal(requests.at(-1)?.userMessage?.meta?.workbenchMode, mode)
    assert.equal(requests.at(-1)?.message, '整理当前资料')
  }
})
