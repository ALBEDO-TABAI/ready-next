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

function harness(options: { maxFrames?: number; maxBytes?: number } = {}) {
  let now = 100
  const events: string[] = []
  let executions = 0
  const quarantines: string[] = []
  const executor: CodexBoundServerRequestExecutor = {
    async execute(input) {
      executions += 1
      events.push(`execute:${input.bindingId}:${input.params.callId}`)
      return { ok: true, execution: executions }
    },
  }
  const buffer = new CodexProvisionalInboundBuffer({
    maxFramesPerOwner: options.maxFrames || 16,
    maxBytesPerOwner: options.maxBytes || 64 * 1024,
    nowMs: () => now,
    serverRequestExecutor: executor,
    startInboundQuarantinePort: {
      quarantine(input) {
        quarantines.push(`${input.method}:${input.bindingId}:${input.reason}`)
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

  assert.deepEqual(await buffer.routeServerRequest({ ...serverRequest(), requestId: 8 }), {
    disposition: 'respond',
    result: { ok: true, execution: 2 },
  })
  assert.equal(executions(), 2)
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
  await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: conflicting, notification: conflicting,
  })
  assert.equal(await reconciliation, 'unknown')
  assert.equal(commits, 0)
  assert.deepEqual(events, [])
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
  await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: conflicting, notification: conflicting,
  })
  assert.equal(await reconciliation, 'unknown')
  assert.equal(commits, 0)
  assert.deepEqual(events, [])
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
  assert.deepEqual(events, [])
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

test('server request arriving before turn identity blocks only that provisional turn', async () => {
  const { buffer, events, executions, quarantines } = harness()
  buffer.registerProvisionalTurn({
    bindingId: 'run-1', connectionEpoch: 'epoch-1', threadId: 'thread-native-1',
    clientUserMessageId: 'ready-message-1', deadlineAtMs: 1_000,
  })
  assert.deepEqual(await buffer.routeServerRequest(serverRequest()), { disposition: 'buffered' })
  assert.equal(executions(), 0)
  assert.deepEqual(events, [])
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
  for (let index = 0; index < 3; index += 1) {
    await overflow.buffer.routeNotification({
      connectionEpoch: 'epoch-1', frame: { ...started, index }, notification: started,
    })
  }
  assert.deepEqual(overflow.buffer.snapshot(), [{
    kind: 'turn', bindingId: 'run-overflow', state: 'unknown',
    unknownReason: 'provisional_buffer_overflow', frameCount: 2,
    bufferedBytes: overflow.buffer.snapshot()[0].bufferedBytes,
  }])
  assert.deepEqual(overflow.events, [])

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
  assert.deepEqual(expired.events, [])

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
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1', frame: notification, notification,
  }), 'buffered')
  assert.deepEqual(events, [])
  assert.equal(await buffer.reconcileThread({
    bindingId: 'thread-binding-1', connectionEpoch: 'epoch-1',
    nativeThreadId: 'thread-native-1',
  }), 'unknown')
})

test('manual compaction frames use their own binding and reject every tool request', async () => {
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
    /manual_compaction_tool_forbidden/,
  )
  assert.equal(executions(), 0)
})
