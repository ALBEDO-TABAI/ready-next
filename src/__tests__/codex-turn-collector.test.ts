import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeCodexNativeNotification,
  type CodexNativeNotification,
  type CodexNativeRuntime,
  type CodexNotificationNormalizationResult,
  type CodexThread,
  type CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexTurnCollector } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'

class FakeNativeRuntime implements CodexNativeRuntime {
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()

  emit(notification: CodexNativeNotification): void {
    for (const listener of this.listeners) listener(notification)
  }

  subscribe(listener: (notification: CodexNativeNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize(): Promise<{ userAgent: string }> { throw new Error('unused') }
  threadStart(): Promise<{ thread: CodexThread; instructionSources: string[] }> { throw new Error('unused') }
  threadRead(): Promise<{ thread: CodexThread }> { throw new Error('unused') }
  threadResume(): Promise<{ thread: CodexThread; instructionSources: string[] }> { throw new Error('unused') }
  threadArchive(): Promise<Record<string, never>> { throw new Error('unused') }
  turnStart(): Promise<{ turn: CodexTurn }> { throw new Error('unused') }
  turnInterrupt(): Promise<Record<string, never>> { throw new Error('unused') }
  threadCompactStart(): Promise<Record<string, never>> { throw new Error('unused') }
}

function turn(status: CodexTurn['status'], id = 'turn-1'): CodexTurn {
  return { id, status, items: [], error: status === 'failed' ? { message: 'provider failed' } : null }
}

function emitRaw(runtime: FakeNativeRuntime, value: unknown): void {
  const normalized: CodexNotificationNormalizationResult = normalizeCodexNativeNotification(value)
  assert.equal(normalized.kind, 'accepted')
  if (normalized.kind === 'accepted') runtime.emit(normalized.notification)
}

function context(
  runtime: FakeNativeRuntime,
  startTurn: () => Promise<{ turn: CodexTurn }>,
  overrides: Partial<Parameters<CodexTurnCollector['collect']>[0]> = {},
): Parameters<CodexTurnCollector['collect']>[0] {
  return {
    readyTaskId: 'task-1',
    readyRunId: 'run-1',
    scopeId: 'scope-1',
    codexThreadId: 'thread-1',
    startTurn,
    terminalTimeoutMs: 1_000,
    actionReceiptRefs: [],
    interactionState: null,
    waitingFor: null,
    terminalReasonCandidate: 'done',
    abortInitiator: null,
    budgetState: {},
    contextState: {},
    providerDiagnostics: {},
    recoveryCheckpointRef: null,
    browserContinuationRef: null,
    browserProofRefs: [],
    otherProofRefs: [],
    projectionPatchRefs: [],
    allowNullPhaseFallback: true,
    allowDirectProvisionalStream: true,
    onAutomaticCompactionObserved: () => {},
    onProvisionalDelta: () => {},
    ...overrides,
  }
}

test('collector buffers accepted-before-response notifications and selects only completed final_answer', async () => {
  const runtime = new FakeNativeRuntime()
  const provisional: string[] = []
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    runtime.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
      },
    })
    runtime.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', delta: 'done' },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { type: 'agentMessage', id: 'commentary-1', text: 'working', phase: 'commentary' },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 3,
        item: { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  }, {
    onProvisionalDelta: (event) => provisional.push(event.delta),
  }))

  assert.deepEqual(provisional, ['done'])
  assert.deepEqual(result.candidateSelection, { kind: 'accepted', itemId: 'final-1' })
  assert.equal(result.candidateText, 'done')
  assert.equal(result.runtimeDiagnostics.commentaryItemIds[0], 'commentary-1')
})

test('collector rejects delta/completed mismatch and multiple explicit finals', async () => {
  for (const fixture of ['delta_mismatch', 'multiple_finals'] as const) {
    const runtime = new FakeNativeRuntime()
    const collector = new CodexTurnCollector(runtime)
    const result = await collector.collect(context(runtime, async () => {
      if (fixture === 'delta_mismatch') {
        runtime.emit({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', delta: 'partial' },
        })
        runtime.emit({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 1,
            item: { type: 'agentMessage', id: 'final-1', text: 'different', phase: 'final_answer' },
          },
        })
      } else {
        for (const id of ['final-1', 'final-2']) {
          runtime.emit({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              completedAtMs: 1,
              item: { type: 'agentMessage', id, text: id, phase: 'final_answer' },
            },
          })
        }
      }
      runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
      return { turn: turn('inProgress') }
    }))
    assert.equal(result.candidateSelection.kind, 'protocol_failure')
    assert.equal(result.candidateText, null)
  }
})

test('collector preserves tool, compaction, action, proof, waiting, and checkpoint evidence without deciding outcome', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const automaticCompactionObservations: unknown[] = []
  const result = await collector.collect(context(runtime, async () => {
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: {
          type: 'dynamicToolCall',
          id: 'call-1',
          tool: 'browser_click',
          namespace: null,
          arguments: {},
          status: 'completed',
          success: true,
        },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { type: 'contextCompaction', id: 'compact-1' },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 3,
        item: { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  }, {
    allowDirectProvisionalStream: false,
    actionReceiptRefs: ['receipt-1'],
    interactionState: 'awaiting_confirmation',
    waitingFor: 'browser_readback',
    terminalReasonCandidate: 'browser_transaction_unconfirmed',
    recoveryCheckpointRef: 'checkpoint-1',
    browserContinuationRef: 'browser-continuation-1',
    browserProofRefs: ['browser-proof-1'],
    otherProofRefs: ['proof-1'],
    projectionPatchRefs: ['patch-1'],
    onAutomaticCompactionObserved: (event) => automaticCompactionObservations.push(event),
  }))

  assert.deepEqual(result.usedToolCalls, [{ itemId: 'call-1', tool: 'browser_click', status: 'completed' }])
  assert.deepEqual(result.actionReceiptRefs, ['receipt-1'])
  assert.equal(result.terminalReasonCandidate, 'browser_transaction_unconfirmed')
  assert.deepEqual(automaticCompactionObservations, [{
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'compact-1',
  }])
  assert.equal(JSON.stringify(result).includes('compact-1'), false)
})

test('collector covers product exit hints while engine outcome remains native truth', async () => {
  const fixtures = [
    ['done', 'completed'],
    ['checkpoint_budget', 'completed'],
    ['cancelled_user', 'interrupted'],
    ['cancelled_runtime', 'interrupted'],
    ['main_no_progress_timeout', 'interrupted'],
    ['blocked_external', 'failed'],
    ['checkpoint_user_input', 'completed'],
    ['proof_gap', 'completed'],
  ] as const
  for (const [terminalReasonCandidate, terminalStatus] of fixtures) {
    const runtime = new FakeNativeRuntime()
    const collector = new CodexTurnCollector(runtime)
    const result = await collector.collect(context(runtime, async () => {
      if (terminalStatus === 'completed') {
        runtime.emit({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 1,
            item: { type: 'agentMessage', id: 'final-1', text: 'candidate', phase: 'final_answer' },
          },
        })
      }
      runtime.emit({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn(terminalStatus) },
      })
      return { turn: turn('inProgress') }
    }, { terminalReasonCandidate }))
    assert.equal(result.terminalReasonCandidate, terminalReasonCandidate)
    assert.equal(result.engineOutcome, terminalStatus === 'completed' ? 'completed' : terminalStatus)
  }
})

test('collector waits for native terminal after a non-retry pinned error notification', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    emitRaw(runtime, {
      method: 'error',
      params: {
        error: { message: 'native transport closed' },
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
      },
    })
    runtime.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          ...turn('failed'),
          error: { message: 'native transport closed' },
        },
      },
    })
    return { turn: turn('inProgress') }
  }))

  assert.equal(result.kind, 'native_terminal')
  assert.equal(result.engineOutcome, 'failed')
  assert.equal(result.candidateText, null)
  assert.equal(result.runtimeDiagnostics.nativeTurnError, 'native transport closed')
})

test('collector keeps the turn alive when the pinned error notification will retry', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    emitRaw(runtime, {
      method: 'error',
      params: {
        error: { message: 'temporary stream disconnect' },
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: {
          type: 'agentMessage',
          id: 'final-1',
          text: 'answer after retry',
          phase: 'final_answer',
        },
      },
    })
    runtime.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    })
    return { turn: turn('inProgress') }
  }))

  assert.equal(result.kind, 'native_terminal')
  assert.equal(result.engineOutcome, 'completed')
  assert.equal(result.candidateText, 'answer after retry')
})

test('collector closes a non-retry native error only when its required terminal never arrives', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    emitRaw(runtime, {
      method: 'error',
      params: {
        error: { message: 'native transport closed' },
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
      },
    })
    return { turn: turn('inProgress') }
  }, { terminalTimeoutMs: 10 }))

  assert.equal(result.kind, 'host_failure')
  assert.equal(result.terminalReasonCandidate, 'persistence_failed')
  assert.equal(result.runtimeDiagnostics.nativeTurnError, 'native transport closed')
  if (result.kind === 'host_failure') {
    assert.equal(result.hostFailure.stage, 'native_error_notification')
    assert.equal(result.hostFailure.code, 'codex_nonretry_error_without_terminal')
    assert.equal(result.codexTurnId, 'turn-1')
  }
})
