import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifySendScopedError,
  createSendScopedPersistence,
  markUserMessagePersistenceFailed,
  resolveAttachmentConfirmation,
  runConfirmedSendScoped,
} from '../main/modules/agent-control/send-scoped-confirmation'

test('scope missing errors classify to scope_missing', () => {
  assert.equal(
    classifySendScopedError(new Error('Conversation scope not found: conv-local-x')),
    'scope_missing',
  )
})

test('message persistence failures classify to message_persist_failed', () => {
  assert.equal(
    classifySendScopedError(new Error('SQLITE constraint failed'), 'message'),
    'message_persist_failed',
  )
})

test('superseded is not inferred from free-form run error text', () => {
  assert.equal(
    classifySendScopedError(new Error('superseded_by_newer_send'), 'run'),
    'unknown',
  )
})

test('attachment confirmation separates metadata and model-input state', () => {
  const confirmation = resolveAttachmentConfirmation({
    selectedCount: 2,
    metadataCount: 1,
    inputIncludedCount: 1,
    inputFailedCount: 1,
  })

  assert.equal(confirmation.attachments, 'metadata_partial')
  assert.equal(confirmation.inputAttachments, 'partial')
})

test('no attachments reports stable none statuses', () => {
  const confirmation = resolveAttachmentConfirmation({
    selectedCount: 0,
    metadataCount: 0,
    inputIncludedCount: 0,
    inputFailedCount: 0,
  })

  assert.equal(confirmation.attachments, 'none')
  assert.equal(confirmation.inputAttachments, 'none')
})

test('message persistence failure marks attachment metadata unavailable', () => {
  const initial = createSendScopedPersistence({
    scope: 'pre-existing',
    message: 'skipped',
    attachmentConfirmation: {
      selectedCount: 1,
      metadataCount: 1,
      inputIncludedCount: 1,
      inputFailedCount: 0,
    },
  })

  const failed = markUserMessagePersistenceFailed(initial)

  assert.equal(failed.message, 'failed')
  assert.equal(failed.attachments, 'metadata_failed')
  assert.equal(failed.inputAttachments, 'included')
})

test('sendScoped persists user message before starting the run', async () => {
  const calls: string[] = []
  const runCalls: unknown[] = []
  const sendScoped = createSendScopedHarness({
    getScope: () => ({
      id: 'conv-send-confirm',
      agent: 'butler',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'conv-send-confirm',
    }),
    addChatMessage: () => {
      calls.push('persist-user-message')
    },
    runScoped: async (payload) => {
      calls.push('run-agent')
      runCalls.push(payload)
      return { success: true, finalText: 'ok', usedTools: [] }
    },
  })

  const result = await sendScoped({
    scopeId: 'conv-send-confirm',
    agent: 'butler',
    message: 'hello',
    userMessage: {
      id: 'msg-1',
      content: 'hello',
      attachmentConfirmation: {
        selectedCount: 1,
        metadataCount: 1,
        inputIncludedCount: 1,
        inputFailedCount: 0,
      },
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.persistence?.message, 'persisted')
  assert.equal(result.persistence?.attachments, 'metadata_persisted')
  assert.deepEqual(calls, ['persist-user-message', 'run-agent'])
  assert.equal(runCalls.length, 1)
})

test('sendScoped stops before run when user message persistence fails', async () => {
  let runStarted = false
  const sendScoped = createSendScopedHarness({
    getScope: () => ({
      id: 'conv-send-failed',
      agent: 'butler',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'conv-send-failed',
    }),
    addChatMessage: () => {
      throw new Error('SQLITE constraint failed')
    },
    runScoped: async () => {
      runStarted = true
      return { success: true, finalText: 'ok', usedTools: [] }
    },
  })

  const result = await sendScoped({
    scopeId: 'conv-send-failed',
    agent: 'butler',
    message: 'hello',
    userMessage: {
      id: 'msg-1',
      content: 'hello',
      attachmentConfirmation: {
        selectedCount: 1,
        metadataCount: 1,
        inputIncludedCount: 1,
        inputFailedCount: 0,
      },
    },
  })

  assert.equal(result.success, false)
  assert.equal(result.errorKind, 'message_persist_failed')
  assert.equal(result.persistence?.message, 'failed')
  assert.equal(result.persistence?.attachments, 'metadata_failed')
  assert.equal(runStarted, false)
})

test('sendScoped lazy-creates a local scope before persistence', async () => {
  let row: Record<string, unknown> | null = null
  const sendScoped = createSendScopedHarness({
    getScope: () => row,
    createLocalScope: (_agent, id) => {
      row = {
        id,
        agent: 'butler',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: id,
      }
      return row
    },
    addChatMessage: () => {},
    runScoped: async () => ({ success: true, finalText: 'ok', usedTools: [] }),
  })

  const result = await sendScoped({
    scopeId: 'conv-lazy-create',
    agent: 'butler',
    message: 'hello',
    userMessage: {
      id: 'msg-1',
      content: 'hello',
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.persistence?.scope, 'lazy-created')
  assert.equal(result.persistence?.message, 'persisted')
})

function createSendScopedHarness(params: {
  getScope: (scopeId: string) => Record<string, unknown> | null
  addChatMessage: (...args: unknown[]) => void
  runScoped: (payload: unknown) => Promise<{ success: boolean; finalText?: string; usedTools?: string[]; error?: string }>
  createLocalScope?: (agent: string, id?: string) => Record<string, unknown>
}) {
  return (payload: {
    scopeId: string
    agent?: string
    message: string
    userMessage?: {
      id: string
      content: string
      attachmentConfirmation?: {
        selectedCount: number
        metadataCount: number
        inputIncludedCount: number
        inputFailedCount: number
      }
    }
  }) => runConfirmedSendScoped({
    scopeId: payload.scopeId,
    agent: payload.agent,
    userMessage: payload.userMessage,
    getScope: params.getScope,
    createLocalScope: params.createLocalScope || ((_agent: string, id: string) => ({
      id,
      agent: 'butler',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: id,
    })),
    persistUserMessage: (_scope, userMessage) => {
      params.addChatMessage(userMessage.id, userMessage.content)
    },
    runConfirmed: async (scope, persistence) => {
      const result = await params.runScoped({ scope, message: payload.message })
      return { ...result, persistence }
    },
  })
}
