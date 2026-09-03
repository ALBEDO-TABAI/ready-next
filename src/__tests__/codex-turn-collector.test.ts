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
import { buildCodexPendingInteractionRestartCandidate } from '../main/modules/agent-control/codex-runtime/codex-pending-interaction-restart'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

class FakeNativeRuntime implements CodexNativeRuntime {
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()
  private readonly connectionClosedListeners = new Set<(error: Error) => void>()

  emit(notification: CodexNativeNotification): void {
    for (const listener of this.listeners) listener(notification)
  }

  subscribe(listener: (notification: CodexNativeNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeConnectionClosed(listener: (error: Error) => void): () => void {
    this.connectionClosedListeners.add(listener)
    return () => this.connectionClosedListeners.delete(listener)
  }

  closeConnection(error = new Error('runtime connection closed')): void {
    for (const listener of this.connectionClosedListeners) listener(error)
  }

  initialize(): Promise<{ userAgent: string }> { throw new Error('unused') }
  threadStart(): Promise<{ thread: CodexThread; instructionSources: string[] }> { throw new Error('unused') }
  threadRead(): Promise<{ thread: CodexThread }> { throw new Error('unused') }
  threadList(): Promise<{ data: CodexThread[]; nextCursor: string | null }> { throw new Error('unused') }
  threadResume(): Promise<{ thread: CodexThread; instructionSources: string[] }> { throw new Error('unused') }
  threadArchive(): Promise<Record<string, never>> { throw new Error('unused') }
  turnStart(): Promise<{ turn: CodexTurn }> { throw new Error('unused') }
  turnInterrupt(): Promise<Record<string, never>> { throw new Error('unused') }
  threadCompactStart(): Promise<Record<string, never>> { throw new Error('unused') }
}

function turn(status: CodexTurn['status'], id = 'turn-1'): CodexTurn {
  return { id, status, items: [], error: status === 'failed' ? { message: 'provider failed' } : null }
}

function tokenBreakdown(inputTokens: number, outputTokens: number) {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
  }
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

test('collector projects live context usage and seals the latest attributable snapshot', async () => {
  const runtime = new FakeNativeRuntime()
  const projected: number[] = []
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    runtime.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: tokenBreakdown(1_000, 120),
          last: tokenBreakdown(100, 20),
          modelContextWindow: 258_400,
        },
      },
    })
    runtime.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: tokenBreakdown(1_080, 135),
          last: tokenBreakdown(80, 15),
          modelContextWindow: 258_400,
        },
      },
    })
    runtime.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: tokenBreakdown(1_080, 135),
          last: tokenBreakdown(0, 0),
          modelContextWindow: null,
        },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  }, {
    onActivity: (event) => {
      if (event.kind === 'context_usage') projected.push(event.contextUsage.usedInputTokens)
    },
  }))

  assert.deepEqual(projected, [100, 80])
  assert.equal(result.contextUsage?.usedInputTokens, 80)
  assert.equal(result.contextUsage?.windowTokens, 258_400)
  assert.equal(result.contextUsage?.source, 'last_model_request')
})

test('collector publishes Matrix-style commentary and tool item activity without making it answer truth', async () => {
  const runtime = new FakeNativeRuntime()
  const activities: Array<Record<string, string>> = []
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    runtime.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 0,
        item: { type: 'agentMessage', id: 'commentary-1', text: '', phase: 'commentary' },
      },
    })
    runtime.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'commentary-1',
        delta: '正在查找飞书文档。',
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: { type: 'agentMessage', id: 'commentary-1', text: '正在查找飞书文档。', phase: 'commentary' },
      },
    })
    runtime.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 2,
        item: { type: 'other', id: 'reasoning-1', nativeType: 'reasoning' },
      },
    })
    runtime.emit({
      method: 'item/reasoning/summaryPartAdded',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        summaryIndex: 0,
      },
    })
    runtime.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        summaryIndex: 0,
        delta: '正在核对统计口径。',
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 3,
        item: { type: 'other', id: 'reasoning-1', nativeType: 'reasoning' },
      },
    })
    runtime.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 4,
        item: {
          type: 'dynamicToolCall', id: 'call-1', tool: 'skill_run_shell', namespace: null,
          arguments: { command: 'must-not-be-projected' }, status: 'inProgress', success: null,
        },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 5,
        item: {
          type: 'dynamicToolCall', id: 'call-1', tool: 'skill_run_shell', namespace: null,
          arguments: { command: 'must-not-be-projected' }, status: 'completed', success: true,
        },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 6,
        item: { type: 'agentMessage', id: 'final-1', text: '共 89 条。', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  }, {
    onActivity: (event) => {
      if (event.kind === 'context_usage') return
      activities.push(event.kind === 'narration'
        ? {
          kind: event.kind,
          stage: event.stage,
          itemId: event.itemId,
          source: event.source,
          text: event.text,
          }
        : {
          kind: event.kind,
          stage: event.stage,
          itemId: event.item.id,
          type: event.item.type,
          })
    },
  }))

  assert.deepEqual(activities, [
    { kind: 'item', stage: 'started', itemId: 'commentary-1', type: 'agentMessage' },
    { kind: 'narration', stage: 'streaming', itemId: 'commentary-1', source: 'commentary', text: '正在查找飞书文档。' },
    { kind: 'item', stage: 'completed', itemId: 'commentary-1', type: 'agentMessage' },
    { kind: 'narration', stage: 'completed', itemId: 'commentary-1', source: 'commentary', text: '正在查找飞书文档。' },
    { kind: 'item', stage: 'started', itemId: 'reasoning-1', type: 'other' },
    { kind: 'narration', stage: 'streaming', itemId: 'reasoning-1', source: 'reasoning_summary', text: '正在核对统计口径。' },
    { kind: 'item', stage: 'completed', itemId: 'reasoning-1', type: 'other' },
    { kind: 'narration', stage: 'completed', itemId: 'reasoning-1', source: 'reasoning_summary', text: '正在核对统计口径。' },
    { kind: 'item', stage: 'started', itemId: 'call-1', type: 'dynamicToolCall' },
    { kind: 'item', stage: 'completed', itemId: 'call-1', type: 'dynamicToolCall' },
    { kind: 'item', stage: 'completed', itemId: 'final-1', type: 'agentMessage' },
  ])
  assert.equal(result.candidateText, '共 89 条。')
})

test('collector isolates task activity observer failures from the native turn', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: { type: 'agentMessage', id: 'commentary-1', text: '正在处理。', phase: 'commentary' },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { type: 'agentMessage', id: 'final-1', text: '完成。', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  }, {
    onActivity: () => { throw new Error('projection listener down') },
  }))

  assert.equal(result.candidateText, '完成。')
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

test('collector treats an assistant preamble before a tool call as non-terminal', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const result = await collector.collect(context(runtime, async () => {
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: {
          type: 'agentMessage', id: 'preamble-1', text: 'I will read it.', phase: 'final_answer',
        },
      },
    })
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: {
          type: 'dynamicToolCall',
          id: 'call-1',
          tool: 'document_read_section',
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
        completedAtMs: 3,
        item: { type: 'agentMessage', id: 'final-1', text: 'answer', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  }))

  assert.deepEqual(result.candidateSelection, { kind: 'accepted', itemId: 'final-1' })
  assert.equal(result.candidateText, 'answer')
})

test('collector treats compaction items as passive while preserving product evidence', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
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
          contentItems: [{ type: 'inputText', text: 'clicked' }],
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
  }))

  assert.deepEqual(result.usedToolCalls, [{
    itemId: 'call-1', tool: 'browser_click', status: 'completed', success: true,
    responseDigest: digestCanonicalJson({
      contentItems: [{ type: 'inputText', text: 'clicked' }],
      success: true,
    }),
  }])
  assert.deepEqual(result.actionReceiptRefs, ['receipt-1'])
  assert.equal(result.terminalReasonCandidate, 'browser_transaction_unconfirmed')
  assert.deepEqual(result.contextState, {})
})

test('deprecated thread compaction notification is passive; gateway exchange evidence is authoritative', () => {
  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'thread/compacted',
    params: { threadId: 'thread-1' },
  }), { kind: 'ignored', method: 'thread/compacted' })
})

test('thread archive acknowledgement is passive after the typed request resolves', () => {
  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'thread/archived',
    params: { threadId: 'thread-1' },
  }), { kind: 'ignored', method: 'thread/archived' })
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

test('collector replaces the default success hint for native failure and interruption', async () => {
  for (const [status, expected] of [
    ['failed', 'blocked_external'],
    ['interrupted', 'cancelled_runtime'],
  ] as const) {
    const runtime = new FakeNativeRuntime()
    const collector = new CodexTurnCollector(runtime)
    const result = await collector.collect(context(runtime, async () => {
      runtime.emit({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn(status) },
      })
      return { turn: turn('inProgress') }
    }))
    assert.equal(result.engineOutcome, status)
    assert.equal(result.terminalReasonCandidate, expected)
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

test('model reroute fails only its exact turn and blocks every later assistant byte', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const reroutedProvisional: string[] = []
  const otherProvisional: string[] = []
  const reroutedCollection = collector.collect(context(
    runtime,
    async () => ({ turn: turn('inProgress', 'turn-rerouted') }),
    {
      readyRunId: 'run-rerouted',
      codexThreadId: 'thread-rerouted',
      onProvisionalDelta: (event) => reroutedProvisional.push(event.delta),
    },
  ))
  const otherCollection = collector.collect(context(
    runtime,
    async () => ({ turn: turn('inProgress', 'turn-other') }),
    {
      readyRunId: 'run-other',
      codexThreadId: 'thread-other',
      onProvisionalDelta: (event) => otherProvisional.push(event.delta),
    },
  ))
  await new Promise<void>((resolve) => setImmediate(resolve))

  runtime.emit({
    method: 'item/started',
    params: {
      threadId: 'thread-rerouted',
      turnId: 'turn-rerouted',
      startedAtMs: 1,
      item: { type: 'agentMessage', id: 'final-rerouted', text: '', phase: 'final_answer' },
    },
  })
  runtime.emit({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-rerouted', turnId: 'turn-rerouted',
      itemId: 'final-rerouted', delta: 'before-reroute',
    },
  })
  runtime.emit({
    method: 'model/rerouted',
    params: {
      threadId: 'thread-rerouted',
      turnId: 'turn-rerouted',
      fromModel: 'ready-e0-model',
      toModel: 'fallback-model',
      reason: 'highRiskCyberActivity',
    },
  })
  runtime.emit({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-rerouted', turnId: 'turn-rerouted',
      itemId: 'final-rerouted', delta: 'must-not-publish',
    },
  })
  runtime.emit({
    method: 'item/completed',
    params: {
      threadId: 'thread-rerouted', turnId: 'turn-rerouted', completedAtMs: 2,
      item: {
        type: 'agentMessage', id: 'final-rerouted',
        text: 'before-reroutemust-not-publish', phase: 'final_answer',
      },
    },
  })
  runtime.emit({
    method: 'turn/completed',
    params: {
      threadId: 'thread-rerouted',
      turn: {
        ...turn('completed', 'turn-rerouted'),
        items: [{
          type: 'agentMessage', id: 'final-rerouted',
          text: 'before-reroutemust-not-publish', phase: 'final_answer',
        }],
      },
    },
  })

  runtime.emit({
    method: 'item/completed',
    params: {
      threadId: 'thread-other', turnId: 'turn-other', completedAtMs: 3,
      item: { type: 'agentMessage', id: 'final-other', text: 'other answer', phase: 'final_answer' },
    },
  })
  runtime.emit({
    method: 'turn/completed',
    params: { threadId: 'thread-other', turn: turn('completed', 'turn-other') },
  })

  const [rerouted, other] = await Promise.all([reroutedCollection, otherCollection])
  assert.equal(rerouted.kind, 'native_terminal')
  assert.equal(rerouted.engineOutcome, 'failed')
  assert.deepEqual(rerouted.candidateSelection, {
    kind: 'protocol_failure', code: 'model_rerouted',
  })
  assert.equal(rerouted.candidateText, null)
  assert.deepEqual(reroutedProvisional, ['before-reroute'])
  assert.equal(other.engineOutcome, 'completed')
  assert.equal(other.candidateText, 'other answer')
  assert.deepEqual(otherProvisional, [])
})

test('collector terminal timeout measures inactivity instead of total multi-tool turn duration', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const collection = collector.collect(context(runtime, async () => ({ turn: turn('inProgress') }), {
    terminalTimeoutMs: 80,
  }))
  setTimeout(() => {
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: {
          type: 'dynamicToolCall', id: 'call-1', tool: 'skill_run_shell', namespace: null,
          arguments: {}, status: 'completed', success: true, contentItems: [],
        },
      },
    })
  }, 50)
  setTimeout(() => {
    runtime.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
      },
    })
    runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })
  }, 100)

  const result = await collection
  assert.equal(result.engineOutcome, 'completed')
  assert.equal(result.candidateText, 'done')
})

test('collector allows an unbounded production turn and only closes when Runtime reports terminal', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const collection = collector.collect(context(runtime, async () => ({ turn: turn('inProgress') }), {
    terminalTimeoutMs: null,
  }))
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  runtime.emit({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 1,
      item: { type: 'agentMessage', id: 'final-unbounded', text: 'done', phase: 'final_answer' },
    },
  })
  runtime.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } })

  const result = await collection
  assert.equal(result.engineOutcome, 'completed')
  assert.equal(result.candidateText, 'done')
})

test('collector fails an unbounded turn when the Runtime connection actually closes', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const collection = collector.collect(context(runtime, async () => ({ turn: turn('inProgress') }), {
    terminalTimeoutMs: null,
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  runtime.closeConnection(new Error('sidecar exited'))

  const result = await collection
  assert.equal(result.kind, 'host_failure')
  if (result.kind === 'host_failure') {
    assert.equal(result.hostFailure.stage, 'collection')
    assert.equal(result.hostFailure.code, 'codex_connection_closed_before_terminal')
  }
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

test('boot readback wakes a collector whose original turn start never resolves', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const collection = collector.collect(context(runtime, () => new Promise(() => undefined)))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const readbackContext = context(runtime, async () => ({ turn: turn('inProgress') }))
  const recovered = collector.buildReadbackCandidate(readbackContext, {
    ...turn('completed'),
    items: [{ type: 'agentMessage', id: 'final-recovered', text: 'recovered', phase: 'final_answer' }],
  })

  assert.equal(collector.deliverRecoveredCandidate(recovered), true)
  assert.equal((await collection).candidateText, 'recovered')
  assert.equal(collector.deliverRecoveredCandidate(recovered), true)
  collector.releaseRun('run-1')
  assert.equal(collector.deliverRecoveredCandidate(recovered), false)
})

test('pending-interaction restart candidate wakes a live collector before terminal timeout', async () => {
  const runtime = new FakeNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const collection = collector.collect(context(runtime, async () => ({ turn: turn('inProgress') }), {
    terminalTimeoutMs: 60_000,
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const recovered = buildCodexPendingInteractionRestartCandidate({
    readyRunId: 'run-1',
    readyTaskId: 'task-1',
    readyScopeId: 'scope-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
  })
  assert.equal(collector.deliverRecoveredCandidate(recovered), true)
  const result = await collection
  assert.equal(result.kind, 'host_failure')
  if (result.kind === 'host_failure') {
    assert.equal(result.hostFailure.code, 'codex_pending_interaction_cancelled_app_restart')
    assert.equal(result.hostFailure.stage, 'collection')
    assert.equal(result.codexTurnId, 'turn-1')
  }
  collector.releaseRun('run-1')
})
