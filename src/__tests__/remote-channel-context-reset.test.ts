import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import {
  RemoteChannelService,
  type RemoteChannelServiceDeps,
} from '../main/modules/agent-control/runtime-core/remote-channel-service'

function publicScope(epoch: number): ConversationScope {
  return {
    id: 'scope-remote',
    aliasGeneration: 2,
    messageVisibilityEpoch: epoch,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: 'Remote',
    sourceKind: 'channel',
    sourceId: 'channel-1',
    threadKey: 'thread-1',
    meta: {},
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  }
}

function createHarness(options: {
  getRuntimeStatus?: RemoteChannelServiceDeps['getRuntimeStatus']
  recoveredRunning?: number
  projectionEmitThrows?: boolean
  markSeenThrows?: boolean
} = {}) {
  let epoch = 0
  let bootRecoveryCalls = 0
  const eventStates = new Map<string, { status: string; error: string | null }>()
  const messages: Array<{ content: string; epoch: number }> = []
  const messageMeta: Array<Record<string, unknown>> = []
  const db = {
    failRunningAgentChannelEventsOnBoot: () => {
      bootRecoveryCalls += 1
      return options.recoveredRunning || 0
    },
    getSetting: () => '600',
    getAgentChannelEvent: () => null,
    getAgentChannelThread: () => ({ session_id: 'scope-remote' }),
    getConversationScope: () => ({ id: 'scope-remote', message_visibility_epoch: epoch }),
    upsertAgentChannelEvent: (record: { eventId: string; status: string; error?: string | null }) => {
      eventStates.set(record.eventId, { status: record.status, error: record.error || null })
    },
    upsertAgentChannelThread: () => undefined,
    getAgentChannel: () => ({ id: 'channel-1', type: 'local-debug', enabled: 1, config_json: '{}' }),
    getChatMessages: () => [],
    markAgentChannelSeen: () => {
      if (options.markSeenThrows) throw new Error('seen_update_failed')
    },
  }
  const service = new RemoteChannelService({
    db,
    sidecar: {},
    settingsRepository: { getAIConfig: () => null },
    getRuntimeStatus: options.getRuntimeStatus || (async () => ({ state: 'ready' }) as never),
    emitConversationEvent: () => {
      if (options.projectionEmitThrows) throw new Error('projection_emit_failed')
    },
    recordChannelDeliveryResult: () => undefined,
    ensureChannelScope: () => publicScope(epoch),
    createConversationMessage: (_scopeId, payload, expectedEpoch) => {
      if (expectedEpoch !== epoch) throw new Error('visibility epoch mismatch')
      messages.push({ content: payload.content, epoch: expectedEpoch })
      messageMeta.push(payload.meta || {})
      return {
        id: `message-${messages.length}`,
        conversationId: 'scope-remote',
        role: payload.role,
        content: payload.content,
        timestamp: '2026-08-12T00:00:00.000Z',
        meta: payload.meta || {},
      }
    },
    refreshScope: () => publicScope(epoch),
  } as unknown as RemoteChannelServiceDeps)

  const enqueue = (eventId: string, text: string, attachments?: unknown[]) => service.handleInboundChannel({
    id: eventId,
    channelId: 'channel-1',
    thread: 'thread-1',
    sender: 'sender-1',
    text,
    attachments,
  })
  const flush = async () => {
    for (const id of eventStates.keys()) await (service as unknown as { flushInboundChannel(key: string): Promise<void> }).flushInboundChannel(`channel-1::thread-1::${id}`)
  }

  return {
    service,
    eventStates,
    messages,
    messageMeta,
    enqueue,
    flush,
    getBootRecoveryCalls: () => bootRecoveryCalls,
    setEpoch: (value: number) => { epoch = value },
  }
}

test('a coalesced remote event queued before reset cannot enter or dispatch in the new epoch', async () => {
  const harness = createHarness()
  await harness.enqueue('event-old', 'old remote request')
  harness.setEpoch(1)

  assert.equal(harness.service.discardScopeContext('scope-remote'), 1)
  await harness.flush()

  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.eventStates.get('event-old'), {
    status: 'failed',
    error: 'conversation_context_reset',
  })
})

test('same-epoch remote inbound is stored and settled without Agent dispatch', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  let providerCalls = 0
  globalThis.fetch = (async () => {
    providerCalls += 1
    throw new Error('remote_inbound_must_not_call_provider')
  }) as typeof fetch
  try {
    await harness.enqueue('event-current', 'current remote request', [{
      name: 'brief.pdf',
      path: '/tmp/brief.pdf',
      type: 'text',
      size: 12,
    }])
    await harness.flush()
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(harness.messages, [{ content: 'current remote request', epoch: 0 }])
  assert.deepEqual(harness.messageMeta[0].eventIds, ['event-current'])
  assert.equal((harness.messageMeta[0].attachments as unknown[]).length, 1)
  assert.deepEqual(harness.eventStates.get('event-current'), { status: 'done', error: null })
  assert.equal(providerCalls, 0)
})

test('service startup reconciles ownerless legacy running events exactly once', () => {
  const harness = createHarness({ recoveredRunning: 3 })
  assert.equal(harness.getBootRecoveryCalls(), 1)
})

test('ordinary resource settlement remains done when ancillary updates fail', async () => {
  const harness = createHarness({ projectionEmitThrows: true, markSeenThrows: true })
  await harness.enqueue('event-ancillary-failure', 'persist this resource')
  await harness.flush()

  assert.deepEqual(harness.messages, [{ content: 'persist this resource', epoch: 0 }])
  assert.deepEqual(harness.eventStates.get('event-ancillary-failure'), { status: 'done', error: null })
})

test('a stale queue fails closed at flush even when reset cleanup did not observe its timer', async () => {
  const harness = createHarness()
  await harness.enqueue('event-race', 'racing remote request')
  harness.setEpoch(1)
  await harness.flush()

  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.eventStates.get('event-race'), {
    status: 'failed',
    error: 'conversation_context_stale',
  })
})

test('a status command awaiting runtime state fails closed when reset advances its epoch', async () => {
  let resolveStatus!: (value: unknown) => void
  let markStatusRead!: () => void
  const statusRead = new Promise<void>((resolve) => { markStatusRead = resolve })
  const deferredStatus = new Promise<unknown>((resolve) => { resolveStatus = resolve })
  const harness = createHarness({
    getRuntimeStatus: (() => {
      markStatusRead()
      return deferredStatus
    }) as RemoteChannelServiceDeps['getRuntimeStatus'],
  })
  await harness.enqueue('event-status-race', '/status')

  const flushing = harness.flush()
  await statusRead
  harness.setEpoch(1)
  resolveStatus({
    state: 'ready',
    sidecar: { status: 'connected', error: null },
    channels: { connected: 1, enabled: 1, errors: 0 },
    heartbeat: {
      orchestrator: { activeTasks: 0 },
      toolGateway: { availableTools: 1 },
    },
  })

  await assert.doesNotReject(flushing)
  assert.deepEqual(harness.messages, [])
  assert.deepEqual(harness.eventStates.get('event-status-race'), {
    status: 'failed',
    error: 'conversation_context_stale',
  })
})
