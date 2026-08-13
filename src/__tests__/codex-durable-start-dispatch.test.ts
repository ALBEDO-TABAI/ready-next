import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { CodexDurableStartDispatchPort } from '../main/modules/agent-control/codex-runtime/codex-durable-start-dispatch'
import type { CodexNativeNotification } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexProvisionalInboundBuffer } from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'

function dispatchWithCloseOwners(input: {
  repository: Pick<CodexBindingRepository, 'closeLateResponseGuardsForConnection'>
  registry: Pick<CodexStartIdentityRegistry, 'markConnectionClosed'>
  inboundBuffer: Pick<CodexProvisionalInboundBuffer, 'markConnectionClosed'>
}): CodexDurableStartDispatchPort {
  return new CodexDurableStartDispatchPort({
    repository: input.repository as CodexBindingRepository,
    registry: input.registry as CodexStartIdentityRegistry,
    inboundBuffer: input.inboundBuffer as CodexProvisionalInboundBuffer,
    evidenceResolver: { async resolveTypedRejection() { return { resolution: 'unknown' as const } } },
    now: () => '2026-08-12T00:00:00.000Z',
    inboundDeadlineMs: 1_000,
    pinnedThreadSource: 'vscode',
  })
}

function isAggregateWith(error: unknown, message: string): boolean {
  return error instanceof AggregateError
    && error.errors.some((failure) => failure instanceof Error && failure.message === message)
}

test('start close runs every durable owner and retries the exact failed child', async () => {
  for (const failedOwner of ['repository', 'registry', 'buffer'] as const) {
    const attempts = { repository: 0, registry: 0, buffer: 0 }
    let fail = true
    const step = (owner: keyof typeof attempts) => {
      attempts[owner] += 1
      if (fail && owner === failedOwner) throw new Error(`${owner}_close_failed`)
    }
    const dispatch = dispatchWithCloseOwners({
      repository: { closeLateResponseGuardsForConnection() { step('repository') } },
      registry: { markConnectionClosed() { step('registry') } },
      inboundBuffer: { markConnectionClosed() { step('buffer') } },
    })

    await assert.rejects(
      dispatch.markConnectionClosed('epoch-1'),
      (error) => isAggregateWith(error, `${failedOwner}_close_failed`),
    )
    assert.deepEqual(attempts, { repository: 1, registry: 1, buffer: 1 })

    fail = false
    await dispatch.markConnectionClosed('epoch-1')
    assert.deepEqual(attempts, { repository: 2, registry: 2, buffer: 2 })
  }
})

test('repository close failure still recovery-holds capacity and scrubs provisional bodies', async () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 1 })
  const reserved = registry.reserve({ scopeId: 'scope-1', existingThread: true })
  assert.equal(reserved.ok, true)
  if (!reserved.ok) throw new Error(reserved.code)
  const member = reserved.reservation.members[0]
  registry.activate({
    reservationSetId: reserved.reservation.reservationSetId,
    reservationId: member.reservationId,
    bindingId: 'run-1',
    connectionEpoch: 'epoch-1',
    rpcId: 1,
  })

  const buffer = new CodexProvisionalInboundBuffer({
    maxFramesPerOwner: 8,
    maxBytesPerOwner: 16_384,
    nowMs: () => 100,
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_tool_execution') },
      confirmServerResponseTransportWrite() {},
    },
    startInboundQuarantinePort: { quarantine() {} },
  })
  buffer.registerProvisionalTurn({
    bindingId: 'run-1',
    connectionEpoch: 'epoch-1',
    threadId: 'thread-1',
    clientUserMessageId: 'secret-message-id',
    deadlineAtMs: 1_000,
  })
  const notification: CodexNativeNotification = {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'item-1',
        clientId: 'secret-message-id',
        content: [{ type: 'text', text: 'sensitive body', text_elements: [] }],
      },
      startedAtMs: 1,
    },
  }
  assert.equal(await buffer.routeNotification({
    connectionEpoch: 'epoch-1',
    frame: notification,
    notification,
  }), 'buffered')

  let repositoryAttempts = 0
  let repositoryFails = true
  const dispatch = dispatchWithCloseOwners({
    repository: {
      closeLateResponseGuardsForConnection() {
        repositoryAttempts += 1
        if (repositoryFails) throw new Error('repository_close_failed')
      },
    },
    registry,
    inboundBuffer: buffer,
  })

  await assert.rejects(
    dispatch.markConnectionClosed('epoch-1'),
    (error) => isAggregateWith(error, 'repository_close_failed'),
  )
  assert.equal(registry.snapshot().members[0].state, 'recovery_held')
  assert.deepEqual(buffer.snapshot(), [{
    kind: 'turn',
    bindingId: 'run-1',
    state: 'unknown',
    unknownReason: 'connection_closed_before_binding',
    frameCount: 0,
    bufferedBytes: 0,
  }])
  assert.equal(JSON.stringify(buffer).includes('sensitive body'), false)

  repositoryFails = false
  await dispatch.markConnectionClosed('epoch-1')
  assert.equal(repositoryAttempts, 2)
})

test('owner capacity rejects a second start before durable activation', async () => {
  const buffer = new CodexProvisionalInboundBuffer({
    maxFramesPerOwner: 8,
    maxBytesPerOwner: 16_384,
    maxActiveOwners: 1,
    nowMs: () => 100,
    serverRequestExecutor: {
      async executeServerRequest() { throw new Error('unexpected_tool_execution') },
      confirmServerResponseTransportWrite() {},
    },
    startInboundQuarantinePort: { quarantine() {} },
  })
  buffer.registerProvisionalTurn({
    bindingId: 'held-run',
    connectionEpoch: 'held-epoch',
    threadId: 'held-thread',
    clientUserMessageId: 'held-message',
    deadlineAtMs: 1_000,
  })
  let repositoryActivations = 0
  let registryActivations = 0
  const dispatch = new CodexDurableStartDispatchPort({
    repository: {
      activateStartDispatch() {
        repositoryActivations += 1
        throw new Error('durable_activation_must_not_run')
      },
    } as unknown as CodexBindingRepository,
    registry: {
      activate() { registryActivations += 1 },
    } as unknown as CodexStartIdentityRegistry,
    inboundBuffer: buffer,
    evidenceResolver: { async resolveTypedRejection() { return { resolution: 'unknown' } } },
    now: () => '2026-08-12T00:00:00.000Z',
    inboundDeadlineMs: 1_000,
    pinnedThreadSource: 'vscode',
  })

  await assert.rejects(dispatch.activate({
    connectionEpoch: 'epoch-2',
    rpcId: 2,
    method: 'turn/start',
    bindingLookupKey: 'run-2',
    requestDigest: 'request-2',
  }), /provisional_owner_capacity_exhausted/)
  assert.equal(repositoryActivations, 0)
  assert.equal(registryActivations, 0)
  assert.deepEqual(buffer.snapshot(), [{
    kind: 'turn', bindingId: 'held-run', state: 'provisional', unknownReason: null,
    frameCount: 0, bufferedBytes: 0,
  }])
})
