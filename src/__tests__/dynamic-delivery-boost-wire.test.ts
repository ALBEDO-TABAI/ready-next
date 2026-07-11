import assert from 'node:assert/strict'
import test from 'node:test'

import { useAgent } from '../renderer/stores/useAgent'
import { createThoroughDeliveryOverrideLatch } from '../renderer/modules/agent/dynamicDeliveryMode'

test('Boost thorough mode reaches the sendScoped IPC payload unchanged', async () => {
  const sent: Array<Record<string, unknown>> = []
  const scope = {
    id: 'boost-scope',
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: '新对话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'boost-scope',
    meta: { sourceLabel: '应用内', createdBy: 'app' },
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    lastMessageAt: null,
  }
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      agent: {
        createLocalScope: async () => ({ success: true, data: scope }),
        sendScoped: async (payload: Record<string, unknown>) => {
          sent.push(payload)
          return { success: true }
        },
        kill: async () => ({ success: true }),
      },
      chat: {
        createConversation: async () => ({ success: true }),
        saveMessage: async () => ({ success: true }),
        updateConversationTitle: async () => ({ success: true }),
      },
      settings: {
        getAIConfig: async () => ({ success: true, data: null }),
      },
    },
  }
  useAgent.setState({
    currentAgent: 'butler',
    currentScopeId: scope.id,
    currentScope: scope,
    scopes: [scope],
    conversations: [],
    messages: [],
    attachments: [],
    filePool: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    sessions: {},
    activeSessionId: '__primary__',
    sessionId: '__primary__',
    sendCoalescingEnabled: false,
  } as never)

  const oneShotBoost = createThoroughDeliveryOverrideLatch()
  oneShotBoost.setEnabled(true)
  const immediateSend = oneShotBoost.consume()
  const result = await useAgent.getState().sendMessage('research this', {
    deliveryMode: immediateSend.deliveryMode,
  })

  assert.equal(result.success, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.deliveryMode, 'thorough')
  assert.equal(oneShotBoost.consume().deliveryMode, undefined, 'Boost resets immediately after one send')
})
