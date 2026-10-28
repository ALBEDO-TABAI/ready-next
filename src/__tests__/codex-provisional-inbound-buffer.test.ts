import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexProvisionalInboundBuffer,
  type CodexBoundServerRequestExecutor,
} from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import type {
  CodexNativeNotification,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { buildCodexToolResponseDeliveryAttemptId } from '../main/modules/agent-control/codex-runtime/codex-tool-response-delivery'

function turn(id = 'turn-native-1', items: CodexThreadItem[] = []): CodexTurn {
  return { id, items, status: 'inProgress', error: null }
}

function thread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: 'thread-native-1',
    sessionId: 'thread-native-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/tmp/ready-codex/thread-binding-1',
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    turns: [],
    ...overrides,
  }
}

function userMessageNotification(): CodexNativeNotification {
  return {
    method: 'item/started',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      item: {
        type: 'userMessage',
        id: 'user-item-1',
        clientId: 'ready-message-1',
        content: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      startedAtMs: 1,
    },
  }
}

function dynamicToolNotification(): CodexNativeNotification {
  return {
    method: 'item/started',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      item: {
        type: 'dynamicToolCall',
        id: 'call-1',
        tool: 'ready_read',
        namespace: null,
        arguments: { query: 'contract' },
        status: 'inProgress',
        success: null,
      },
      startedAtMs: 2,
    },
  }
}

function contextUsageNotification(turnId = 'turn-native-1'): CodexNativeNotification {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-native-1',
      turnId,
      tokenUsage: {
        total: {
          totalTokens: 16, inputTokens: 12, cachedInputTokens: 0,
          outputTokens: 4, reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 16, inputTokens: 12, cachedInputTokens: 0,
          outputTokens: 4, reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      },
    },
  }
}

function serverRequest() {
  return {
    connectionEpoch: 'epoch-1',
    requestId: 7,
    method: 'item/tool/call' as const,
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      callId: 'call-1',
      namespace: null,
      tool: 'ready_read',
      arguments: { query: 'contract' },
    },
  }
}

function harness(options: {
  maxFrames?: number
  maxBytes?: number
  maxOwners?: number
  quarantine?: (bindingId: string) => void
} = {}) {
  let now = 100
  const events: string[] = []
  let executions = 0
  const quarantines: string[] = []
  const executor: CodexBoundServerRequestExecutor = {
    async executeServerRequest(input) {
      executions += 1
      events.push(`execute:${input.bindingId}:${input.params.callId}`)
      const result = { ok: true, execution: executions }
      const identity = {
        codexThreadId: input.params.threadId,
        codexTurnId: input.params.turnId,
        codexCallId: input.params.callId,
        readyActionId: `action-${input.params.callId}`,
        connectionEpoch: input.connectionEpoch,
        requestRpcId: String(input.requestId),
        toolResponseDigest: digestCanonicalJson(result),
      }
      return {
        result,
        deliveryAttempt: {
          attemptId: buildCodexToolResponseDeliveryAttemptId(identity),
          ...identity,
        },
      }
    },
    confirmServerResponseTransportWrite() {},
  }
  const buffer = new CodexProvisionalInboundBuffer({
    maxFramesPerOwner: options.maxFrames || 16,
    maxBytesPerOwner: options.maxBytes || 64 * 1024,
    maxActiveOwners: options.maxOwners,
    nowMs: () => now,
    serverRequestExecutor: executor,
    startInboundQuarantinePort: {
      quarantine(input) {
        quarantines.push(`${input.method}:${input.bindingId}:${input.reason}`)
        options.quarantine?.(input.bindingId)
      },
    },
  })
  buffer.attachReleasePort({
    broadcastNotification(notification) {
      events.push(`notification:${notification.method}`)
    },
    respondServerRequest(requestId, result) {
      events.push(`response:${requestId}:${JSON.stringify(result)}`)
    },
    failProtocol(error) {
      events.push(`protocol-failure:${error.message}`)
    },
  })
  return {
    buffer,
    events,
    executions: () => executions,
    quarantines,
    setNow(value: number) { now = value },
  }
}

test('turn frames remain effect-free until exact client identity and binding reconciliation', async () => {
  const { buffer, events, executions } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-1',
    connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1',
    deadlineAtMs: 1_000,
  })
  const started: CodexNativeNotification = {
    method: 'turn/started',
    params: { threadId: 'thread-native-1', turn: turn() },
  }
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: started, notification: started,
  }), 'buffered')
  const user = userMessageNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
  const tool = dynamicToolNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: tool, notification: tool })
  assert.deepEqual(await buffer.routeServerRequest(serverRequest()), { disposition: 'buffered' })
  assert.deepEqual(events, [])
  assert.equal(executions(), 0)

  assert.equal(await buffer.reconcileTurn({
    bindingId: 'run-1',
    connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1',
    nativeTurnId: 'turn-native-1',
  }), 'released')
  assert.deepEqual(events, [
    'notification:turn/started',
    'notification:item/started',
    'notification:item/started',
    'execute:run-1:call-1',
    'response:7:{"ok":true,"execution":1}',
  ])
  assert.equal(executions(), 1)

  const immediate = await buffer.routeServerRequest({ ...serverRequest(), requestId: 8 })
  assert.equal(immediate.disposition, 'respond')
  if (immediate.disposition !== 'respond') throw new Error('response_expected')
  assert.deepEqual(immediate.result, { ok: true, execution: 2 })
  assert.equal(immediate.deliveryAttempt.requestRpcId, '8')
  assert.equal(executions(), 2)
})

test('model reroute follows the exact provisional thread and turn binding', async () => {
  const { buffer, events } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-1',
    connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1',
    deadlineAtMs: 1_000,
  })
  const user = userMessageNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
  const rerouted: CodexNativeNotification = {
    method: 'model/rerouted',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      fromModel: 'ready-e0-model',
      toModel: 'fallback-model',
      reason: 'highRiskCyberActivity',
    },
  }
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: rerouted, notification: rerouted,
  }), 'buffered')
  assert.deepEqual(events, [])

  assert.equal(await buffer.reconcileTurn({
    bindingId: 'run-1',
    connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1',
    nativeTurnId: 'turn-native-1',
  }), 'released')
  assert.deepEqual(events, [
    'notification:item/started',
    'notification:model/rerouted',
  ])
})

test('late context telemetry from a settled turn cannot claim the next provisional turn', async () => {
  const { buffer, events } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-next', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const staleUsage = contextUsageNotification('turn-previous')
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: staleUsage, notification: staleUsage,
  }), 'buffered')
  const user = userMessageNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
  assert.equal(await buffer.reconcileTurn({
    bindingId: 'run-next', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }), 'released')
  assert.deepEqual(events, ['notification:item/started'])
})

test('context telemetry is buffered only after the provisional turn identity is known', async () => {
  const { buffer, events } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-usage', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const user = userMessageNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
  const usage = contextUsageNotification()
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: usage, notification: usage,
  }), 'buffered')
  assert.equal(await buffer.reconcileTurn({
    bindingId: 'run-usage', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }), 'released')
  assert.deepEqual(events, [
    'notification:item/started',
    'notification:thread/tokenUsage/updated',
  ])
})

test('response reconciliation alone cannot release turn frames before native client identity', async () => {
  const { buffer, events } = harness()
  let commits = 0
  buffer.registerProvisionalTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const started: CodexNativeNotification = {
    method: 'turn/started', params: { threadId: 'thread-native-1', turn: turn() },
  }
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: started, notification: started })
  const reconciliation = buffer.reconcileTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }, () => { commits += 1 })
  assert.equal(await Promise.race([
    reconciliation,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
  ]), 'pending')
  assert.equal(commits, 0)
  assert.deepEqual(events, [])

  const user = userMessageNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
  assert.equal(await reconciliation, 'released')
  assert.equal(commits, 1)
  assert.deepEqual(events, [
    'notification:turn/started',
    'notification:item/started',
  ])
})

test('response-first identity conflict quarantines without committing or releasing', async () => {
  const { buffer, events, quarantines } = harness()
  let commits = 0
  buffer.registerProvisionalTurn({
    bindingId: 'run-conflict', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const reconciliation = buffer.reconcileTurn({
    bindingId: 'run-conflict', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }, () => { commits += 1 })
  const conflicting = userMessageNotification()
  if (conflicting.method !== 'item/started' || conflicting.params.item.type !== 'userMessage') {
    throw new Error('user_message_fixture_invalid')
  }
  conflicting.params.item.clientId = 'different-ready-message'
  await assert.rejects(buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: conflicting, notification: conflicting,
  }), /turn_client_identity_conflict/)
  assert.equal(await reconciliation, 'unknown')
  assert.equal(commits, 0)
  assert.deepEqual(events, ['protocol-failure:turn_client_identity_conflict'])
  assert.deepEqual(quarantines, [
    'turn/start:run-conflict:turn_client_identity_conflict',
  ])
})

test('response-first native turn mismatch quarantines immediately without waiting for deadline', async () => {
  const { buffer, events, quarantines } = harness()
  let commits = 0
  buffer.registerProvisionalTurn({
    bindingId: 'run-native-conflict', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const reconciliation = buffer.reconcileTurn({
    bindingId: 'run-native-conflict', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-response-a',
  }, () => { commits += 1 })
  const conflicting = userMessageNotification()
  if (conflicting.method !== 'item/started') throw new Error('user_message_fixture_invalid')
  conflicting.params.turnId = 'turn-notification-b'
  await assert.rejects(buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: conflicting, notification: conflicting,
  }), /turn_reconciliation_identity_conflict/)
  assert.equal(await reconciliation, 'unknown')
  assert.equal(commits, 0)
  assert.deepEqual(events, ['protocol-failure:turn_reconciliation_identity_conflict'])
  assert.deepEqual(quarantines, [
    'turn/start:run-native-conflict:turn_reconciliation_identity_conflict',
  ])
})

test('response-first identity deadline quarantines without committing or releasing', async () => {
  const { buffer, events, quarantines, setNow } = harness()
  let commits = 0
  buffer.registerProvisionalTurn({
    bindingId: 'run-expired-response', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 200,
  })
  const reconciliation = buffer.reconcileTurn({
    bindingId: 'run-expired-response', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }, () => { commits += 1 })
  setNow(201)
  assert.equal(buffer.expireDue(), 1)
  assert.equal(await reconciliation, 'unknown')
  assert.equal(commits, 0)
  assert.deepEqual(events, [
    'protocol-failure:provisional_buffer_deadline_exceeded',
  ])
  assert.deepEqual(quarantines, [
    'turn/start:run-expired-response:provisional_buffer_deadline_exceeded',
  ])
})

test('automatic compaction before user identity stays buffered without becoming a Ready action', async () => {
  const { buffer, events } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const compact: CodexNativeNotification = {
    method: 'item/completed',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      item: { type: 'contextCompaction', id: 'compact-auto-1' },
      completedAtMs: 1,
    },
  }
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: compact, notification: compact,
  }), 'buffered')
  assert.equal(buffer.snapshot()[0].state, 'provisional')
  assert.equal(buffer.snapshot()[0].unknownReason, null)
  const reconciliation = buffer.reconcileTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  })
  assert.equal(await Promise.race([
    reconciliation,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
  ]), 'pending')
  const user = userMessageNotification()
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
  assert.equal(await reconciliation, 'released')
  assert.deepEqual(events, [
    'notification:item/completed',
    'notification:item/started',
  ])
})

test('server request arriving before turn identity retires its body and fails the protocol', async () => {
  const { buffer, events, executions, quarantines } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  await assert.rejects(
    buffer.routeServerRequest(serverRequest()),
    /server_request_before_turn_identity/,
  )
  assert.equal(executions(), 0)
  assert.deepEqual(events, ['protocol-failure:server_request_before_turn_identity'])
  assert.deepEqual(buffer.snapshot(), [{
    kind: 'turn',
    bindingId: 'run-1',
    state: 'unknown',
    unknownReason: 'server_request_before_turn_identity',
    frameCount: 0,
    bufferedBytes: 0,
  }])
  assert.equal(await buffer.reconcileTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }), 'unknown')
  assert.deepEqual(quarantines, [
    'turn/start:run-1:server_request_before_turn_identity',
  ])
})

test('frame, byte, and deadline bounds never release a partial provisional buffer', async () => {
  const overflow = harness({ maxFrames: 2 })
  overflow.buffer.registerProvisionalTurn({
    bindingId: 'run-overflow', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  const started: CodexNativeNotification = {
    method: 'turn/started', params: { threadId: 'thread-native-1', turn: turn() },
  }
  for (let index = 0; index < 2; index += 1) {
    await overflow.buffer.routeNotification({
      connectionEpoch: 'epoch-1', frame: { ...started, index }, notification: started,
    })
  }
  await assert.rejects(overflow.buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: { ...started, index: 2 }, notification: started,
  }), /provisional_buffer_overflow/)
  assert.deepEqual(overflow.buffer.snapshot(), [{
    kind: 'turn', bindingId: 'run-overflow', state: 'unknown',
    unknownReason: 'provisional_buffer_overflow', frameCount: 0,
    bufferedBytes: 0,
  }])
  assert.deepEqual(overflow.events, ['protocol-failure:provisional_buffer_overflow'])

  const expired = harness()
  expired.buffer.registerProvisionalTurn({
    bindingId: 'run-expired', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 200,
  })
  expired.setNow(201)
  assert.equal(expired.buffer.expireDue(), 1)
  assert.equal(await expired.buffer.reconcileTurn({
    bindingId: 'run-expired', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'turn-native-1',
  }), 'unknown')
  assert.deepEqual(expired.events, [
    'protocol-failure:provisional_buffer_deadline_exceeded',
  ])

  const scheduled = harness()
  scheduled.buffer.registerProvisionalTurn({
    bindingId: 'run-scheduled', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 110,
  })
  scheduled.setNow(111)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(scheduled.buffer.snapshot()[0].state, 'unknown')
  assert.deepEqual(scheduled.quarantines, [
    'turn/start:run-scheduled:provisional_buffer_deadline_exceeded',
  ])
  assert.deepEqual(scheduled.events, [
    'protocol-failure:provisional_buffer_deadline_exceeded',
  ])
})

test('early thread notification is released only after exact root metadata reconciliation', async () => {
  const { buffer, events } = harness()
  buffer.registerProvisionalThread({
    bindingId: 'thread-binding-1', connectionEpoch: 'epoch-1',
    expectedCwd: '/tmp/ready-codex/thread-binding-1', expectedSource: 'vscode',
    deadlineAtMs: 1_000,
  })
  const notification: CodexNativeNotification = {
    method: 'thread/started', params: { thread: thread() },
  }
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: notification, notification,
  }), 'buffered')
  assert.deepEqual(events, [])
  assert.equal(await buffer.reconcileThread({
    bindingId: 'thread-binding-1', connectionEpoch: 'epoch-1',
    nativeThreadId: 'thread-native-1',
  }), 'released')
  assert.deepEqual(events, ['notification:thread/started'])

  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: notification, notification,
  }), 'broadcast')
})

test('non-root early thread metadata becomes unknown with zero broadcast', async () => {
  const { buffer, events } = harness()
  buffer.registerProvisionalThread({
    bindingId: 'thread-binding-1', connectionEpoch: 'epoch-1',
    expectedCwd: '/tmp/ready-codex/thread-binding-1', expectedSource: 'vscode',
    deadlineAtMs: 1_000,
  })
  const notification: CodexNativeNotification = {
    method: 'thread/started',
    params: {
      thread: thread({
        sessionId: 'session-parent',
        parentThreadId: 'thread-parent',
      }),
    },
  }
  await assert.rejects(buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: notification, notification,
  }), /thread_metadata_conflict/)
  assert.deepEqual(events, ['protocol-failure:thread_metadata_conflict'])
  assert.equal(await buffer.reconcileThread({
    bindingId: 'thread-binding-1', connectionEpoch: 'epoch-1',
    nativeThreadId: 'thread-native-1',
  }), 'unknown')
})

test('manual compaction evidence is retired after exact terminal consumption', async () => {
  const { buffer, events, executions } = harness()
  buffer.registerProvisionalManualCompaction({
    manualCompactionId: 'manual-1',
    connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1',
    deadlineAtMs: 1_000,
  })
  const started: CodexNativeNotification = {
    method: 'turn/started',
    params: { threadId: 'thread-native-1', turn: turn('compact-turn-1') },
  }
  const compacted: CodexNativeNotification = {
    method: 'item/completed',
    params: {
      threadId: 'thread-native-1',
      turnId: 'compact-turn-1',
      item: { type: 'contextCompaction', id: 'compact-item-1' },
      completedAtMs: 3,
    },
  }
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: started, notification: started })
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: compacted, notification: compacted })
  assert.deepEqual(events, [])
  assert.equal(buffer.readManualCompactionEvidence('manual-1'), null)
  const terminal: CodexNativeNotification = {
    method: 'turn/completed',
    params: {
      threadId: 'thread-native-1',
      turn: { ...turn('compact-turn-1'), status: 'completed' },
    },
  }
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: terminal, notification: terminal })
  assert.deepEqual(buffer.readManualCompactionEvidence('manual-1'), {
    turnId: 'compact-turn-1',
    contextCompactionItemId: 'compact-item-1',
    terminalStatus: 'completed',
  })
  assert.equal(await buffer.reconcileTurn({
    bindingId: 'manual-1', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', nativeTurnId: 'compact-turn-1',
  }), 'released')
  assert.equal(buffer.readManualCompactionEvidence('manual-1'), null)
  assert.deepEqual(events, [
    'notification:turn/started',
    'notification:item/completed',
    'notification:turn/completed',
  ])
  assert.equal(executions(), 0)
  await assert.rejects(
    buffer.routeServerRequest({
      ...serverRequest(),
      params: { ...serverRequest().params, turnId: 'compact-turn-1' },
    }),
    /server_request_owner_not_unique/,
  )
  assert.equal(executions(), 0)
})

// 2026-10-07: Codex rejected a compaction; its owner waited out the deadline and failed the whole connection.
test('a rejected manual compaction owner is discarded and its deadline never fails the connection', async () => {
  const { buffer, events, setNow } = harness()
  buffer.registerProvisionalManualCompaction({
    manualCompactionId: 'manual-rejected', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', deadlineAtMs: 1_000,
  })
  assert.throws(() => buffer.discardRejectedManualCompaction({
    manualCompactionId: 'manual-rejected', connectionEpoch: 'epoch-other',
  }), /manual_compaction_owner_not_discardable/)
  buffer.discardRejectedManualCompaction({ manualCompactionId: 'manual-rejected', connectionEpoch: 'epoch-1' })
  setNow(5_000)
  assert.equal(buffer.expireDue(), 0)
  assert.deepEqual(events, [])

  buffer.registerProvisionalManualCompaction({
    manualCompactionId: 'manual-started', connectionEpoch: 'epoch-1',
    threadId: 'thread-native-1', deadlineAtMs: 9_000,
  })
  const started: CodexNativeNotification = {
    method: 'turn/started',
    params: { threadId: 'thread-native-1', turn: turn('compact-turn-1') },
  }
  await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: started, notification: started })
  assert.throws(() => buffer.discardRejectedManualCompaction({
    manualCompactionId: 'manual-started', connectionEpoch: 'epoch-1',
  }), /manual_compaction_owner_not_discardable/, 'a compaction that produced frames did start')
})

test('active owner capacity fails closed without evicting retained identities', () => {
  const { buffer } = harness({ maxOwners: 2 })
  buffer.registerProvisionalThread({
    bindingId: 'thread-owner-1', connectionEpoch: 'epoch-1',
    expectedCwd: '/tmp/one', expectedSource: 'vscode', deadlineAtMs: 1_000,
  })
  buffer.registerProvisionalTurn({
    bindingId: 'turn-owner-1', connectionEpoch: 'epoch-1', threadId: 'thread-1',
    clientUserMessageId: 'message-1', deadlineAtMs: 1_000,
  })
  assert.throws(() => buffer.registerProvisionalThread({
    bindingId: 'thread-owner-overflow', connectionEpoch: 'epoch-1',
    expectedCwd: '/tmp/overflow', expectedSource: 'vscode', deadlineAtMs: 1_000,
  }), /provisional_owner_capacity_exhausted/)
  assert.equal(buffer.snapshot().length, 2)
})

test('same connection cannot re-register an owner identity after it becomes unknown', () => {
  const { buffer, setNow } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'turn-owner-1', connectionEpoch: 'epoch-1', threadId: 'thread-1',
    clientUserMessageId: 'message-1', deadlineAtMs: 1_000,
  })
  setNow(2_000)
  assert.equal(buffer.expireDue(), 1)
  assert.throws(() => buffer.registerProvisionalTurn({
    bindingId: 'turn-owner-1', connectionEpoch: 'epoch-1', threadId: 'thread-2',
    clientUserMessageId: 'message-2', deadlineAtMs: 3_000,
  }), /provisional_turn_identity_conflict/)
  assert.doesNotThrow(() => buffer.registerProvisionalTurn({
    bindingId: 'turn-owner-1', connectionEpoch: 'epoch-2', threadId: 'thread-2',
    clientUserMessageId: 'message-2', deadlineAtMs: 3_000,
  }))
})

test('connection close clears every sensitive owner without quarantining recoverable start intent', () => {
  const quarantined: string[] = []
  const { buffer } = harness({
    quarantine(bindingId) {
      quarantined.push(bindingId)
    },
  })
  for (const index of [1, 2]) {
    buffer.registerProvisionalTurn({
      bindingId: `turn-owner-${index}`,
      connectionEpoch: 'epoch-1',
      threadId: `thread-${index}`,
      clientUserMessageId: `message-${index}`,
      deadlineAtMs: 1_000,
    })
  }
  assert.doesNotThrow(() => buffer.markConnectionClosed('epoch-1'))
  assert.deepEqual(buffer.snapshot().map((owner) => ({
    bindingId: owner.bindingId,
    state: owner.state,
    frameCount: owner.frameCount,
    bufferedBytes: owner.bufferedBytes,
  })).sort((left, right) => left.bindingId.localeCompare(right.bindingId)), [
    { bindingId: 'turn-owner-1', state: 'unknown', frameCount: 0, bufferedBytes: 0 },
    { bindingId: 'turn-owner-2', state: 'unknown', frameCount: 0, bufferedBytes: 0 },
  ])
  const internals = buffer as unknown as {
    turns: Map<string, unknown>
    threads: Map<string, unknown>
  }
  assert.equal(internals.turns.size, 0)
  assert.equal(internals.threads.size, 0)
  assert.deepEqual(quarantined, [])
})

test('failed quarantine keeps only a retryable identity until the exact close audit succeeds', () => {
  let attempts = 0
  let fail = true
  const { buffer, setNow } = harness({
    quarantine() {
      attempts += 1
      if (fail) throw new Error('quarantine_down')
    },
  })
  buffer.registerProvisionalTurn({
    bindingId: 'turn-retry', connectionEpoch: 'epoch-retry', threadId: 'secret-thread',
    clientUserMessageId: 'secret-message', deadlineAtMs: 1_000,
  })
  setNow(2_000)
  assert.throws(() => buffer.expireDue(), /quarantine_down/)
  assert.equal(attempts, 1)
  const internal = buffer as unknown as {
    turns: Map<string, unknown>
    pendingQuarantines: Map<string, Record<string, unknown>>
  }
  assert.equal(internal.turns.size, 0)
  assert.equal(internal.pendingQuarantines.size, 1)
  assert.equal(JSON.stringify([...internal.pendingQuarantines.values()]).includes('secret-'), false)

  fail = false
  assert.doesNotThrow(() => buffer.markConnectionClosed('epoch-retry'))
  assert.equal(attempts, 2)
  assert.equal(internal.pendingQuarantines.size, 0)
})

test('non-retry error keeps the bound turn until the required terminal arrives', async () => {
  const { buffer } = harness({ maxOwners: 4 })
  for (let index = 0; index < 10_000; index += 1) {
    const turnId = `turn-${index}`
    const bindingId = `run-${index}`
    const messageId = `message-${index}`
    buffer.registerProvisionalTurn({
      bindingId, connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
      clientUserMessageId: messageId, deadlineAtMs: 1_000,
    })
    const user = userMessageNotification()
    if (user.method !== 'item/started' || user.params.item.type !== 'userMessage') {
      throw new Error('user_message_fixture_invalid')
    }
    user.params.turnId = turnId
    user.params.item.clientId = messageId
    await buffer.routeNotification({ connectionEpoch: 'epoch-1', frame: user, notification: user })
    assert.equal(await buffer.reconcileTurn({
      bindingId, connectionEpoch: 'epoch-1', threadId: 'thread-native-1', nativeTurnId: turnId,
    }), 'released')
    const terminalError: CodexNativeNotification = {
      method: 'error',
      params: {
        threadId: 'thread-native-1', turnId,
        error: { message: 'terminal host failure', additionalDetails: null },
        willRetry: false,
      },
    }
    assert.equal(await buffer.routeNotification({
      connectionEpoch: 'epoch-1', frame: terminalError, notification: terminalError,
    }), 'broadcast')
    const terminal: CodexNativeNotification = {
      method: 'turn/completed',
      params: {
        threadId: 'thread-native-1',
        turn: {
          id: turnId,
          items: [],
          status: 'failed',
          error: { message: 'terminal host failure', additionalDetails: null },
        },
      },
    }
    assert.equal(await buffer.routeNotification({
      connectionEpoch: 'epoch-1', frame: terminal, notification: terminal,
    }), 'broadcast')
  }
  const internals = buffer as unknown as {
    turns: Map<string, unknown>
    boundTurns: Map<string, unknown>
  }
  assert.equal(internals.turns.size, 0)
  assert.equal(internals.boundTurns.size, 0)
})
