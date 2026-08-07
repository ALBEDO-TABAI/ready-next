import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { ExecutionHostResult } from '../main/modules/agent-control/contracts/run-contracts'
import type {
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThread,
  CodexTurn,
  CodexTurnStatus,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import {
  CodexTurnCollector,
  createHostFailureCandidate,
  type CoreTurnCandidate,
} from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import type { ReadyCodexCloseout } from '../main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter'

type ExitMatrixRow = {
  id: string
  disposition: 'migrate' | 'preserve' | 'retire' | 'unsupported'
  readyOutcome: string
  terminalReason: string
  candidatePolicy: string
  publicationPolicy: string
}

const matrix = JSON.parse(readFileSync(new URL(
  '../../docs/superpowers/audits/2026-08-06-codex-runtime-exit-authority-matrix.json',
  import.meta.url,
), 'utf8')) as { rows: ExitMatrixRow[] }

const preDispatchRows = new Set([
  'checkpoint_background_child',
  'checkpoint_steered',
  'dynamic_delivery_deadline',
  'legacy_child_failed',
  'admission_rejected',
  'legacy_session_cap',
])
const pendingWithoutProductTerminalRows = new Set(['start_delivery_unknown'])

class FixtureNativeRuntime implements CodexNativeRuntime {
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()
  notificationCount = 0

  emit(notification: CodexNativeNotification): void {
    this.notificationCount += 1
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

class MatrixCloseout implements ReadyCodexCloseout<ExecutionHostResult> {
  calls = 0

  constructor(private readonly row: ExitMatrixRow) {}

  async closeCandidate(candidate: CoreTurnCandidate): Promise<ExecutionHostResult> {
    this.calls += 1
    assert.equal(candidate.terminalReasonCandidate, this.row.terminalReason)

    if (this.row.readyOutcome === 'done') {
      assert.equal(candidate.candidateSelection.kind, 'accepted')
      assert.equal(candidate.candidateText, `answer:${this.row.id}`)
      return {
        success: true,
        finalText: candidate.candidateText,
        cancelled: false,
        usedTools: candidate.usedToolCalls.map((call) => call.tool),
        terminalReason: 'done',
      }
    }

    if (this.row.candidatePolicy === 'reject' && this.row.id !== 'protocol_or_response_surface_failure') {
      assert.equal(candidate.candidateSelection.kind, 'accepted')
    } else {
      assert.equal(candidate.candidateText, null)
    }
    return {
      success: false,
      finalText: '',
      cancelled: this.row.readyOutcome === 'cancelled' || this.row.readyOutcome === 'preempted',
      usedTools: candidate.usedToolCalls.map((call) => call.tool),
      error: this.row.terminalReason,
    }
  }

  recoverRejectedCandidate(): ExecutionHostResult {
    throw new Error('matrix closeout must not reject')
  }

  observeCandidateReadback(): () => void {
    throw new Error('matrix closeout must not remain pending')
  }
}

function nativeStatus(row: ExitMatrixRow): Exclude<CodexTurnStatus, 'inProgress'> {
  if (
    row.readyOutcome === 'checkpoint'
    || row.readyOutcome === 'cancelled'
    || row.readyOutcome === 'preempted'
  ) return 'interrupted'
  if (row.readyOutcome === 'done' || row.candidatePolicy === 'reject') return 'completed'
  return 'failed'
}

function terminalTurn(row: ExitMatrixRow): CodexTurn {
  const status = nativeStatus(row)
  return {
    id: `turn:${row.id}`,
    status,
    items: [],
    error: status === 'failed' ? { message: row.terminalReason } : null,
  }
}

async function collectFixture(row: ExitMatrixRow): Promise<{
  candidate: CoreTurnCandidate
  runtime: FixtureNativeRuntime
}> {
  const runtime = new FixtureNativeRuntime()
  const collector = new CodexTurnCollector(runtime)
  const threadId = `thread:${row.id}`
  const turn = terminalTurn(row)
  const needsCompletedBody = row.readyOutcome === 'done'
    || (row.candidatePolicy === 'reject' && row.id !== 'protocol_or_response_surface_failure')
  const candidate = await collector.collect({
    readyTaskId: `task:${row.id}`,
    readyRunId: `run:${row.id}`,
    scopeId: `scope:${row.id}`,
    codexThreadId: threadId,
    terminalTimeoutMs: 1_000,
    actionReceiptRefs: row.id === 'done_effectful_tools' ? ['receipt:effect'] : [],
    interactionState: row.id === 'checkpoint_user_input' ? 'waiting_user' : null,
    waitingFor: row.id === 'checkpoint_user_input' ? 'user_input' : null,
    terminalReasonCandidate: row.terminalReason,
    abortInitiator: row.readyOutcome === 'cancelled' ? 'user' : null,
    budgetState: row.id === 'checkpoint_budget' ? { exhausted: true } : {},
    contextState: {},
    providerDiagnostics: {},
    recoveryCheckpointRef: row.readyOutcome === 'checkpoint' ? `checkpoint:${row.id}` : null,
    browserContinuationRef: row.id === 'browser_action_evidence_barrier' ? 'browser:pending' : null,
    browserProofRefs: row.id === 'done_effectful_tools' ? ['browser-proof:accepted'] : [],
    otherProofRefs: row.id === 'proof_or_artifact_gap' ? ['proof:rejected'] : [],
    projectionPatchRefs: [],
    allowNullPhaseFallback: true,
    allowDirectProvisionalStream: row.id === 'done_direct',
    onAutomaticCompactionObserved: () => {
      throw new Error('matrix terminal fixture must not contain compaction')
    },
    onProvisionalDelta: () => {},
    startTurn: async () => {
      if (row.id === 'protocol_or_response_surface_failure') {
        runtime.emit({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId: turn.id, itemId: 'final:bad', delta: 'mismatch' },
        })
        runtime.emit({
          method: 'item/completed',
          params: {
            threadId,
            turnId: turn.id,
            completedAtMs: 1,
            item: { type: 'agentMessage', id: 'final:bad', text: 'completed-body', phase: 'final_answer' },
          },
        })
      } else if (needsCompletedBody) {
        if (row.id !== 'done_direct') {
          runtime.emit({
            method: 'item/completed',
            params: {
              threadId,
              turnId: turn.id,
              completedAtMs: 1,
              item: {
                type: 'dynamicToolCall',
                id: `tool:${row.id}`,
                tool: 'fixture_tool',
                namespace: null,
                arguments: {},
                status: 'completed',
                success: true,
              },
            },
          })
        }
        runtime.emit({
          method: 'item/completed',
          params: {
            threadId,
            turnId: turn.id,
            completedAtMs: 2,
            item: {
              type: 'agentMessage',
              id: `final:${row.id}`,
              text: `answer:${row.id}`,
              phase: 'final_answer',
            },
          },
        })
      }
      runtime.emit({ method: 'turn/completed', params: { threadId, turn } })
      return { turn: { ...turn, status: 'inProgress' } }
    },
  })
  return { candidate, runtime }
}

test('every migrated or preserved terminal row reaches exactly one Ready closeout', async () => {
  const terminalRows = matrix.rows.filter((row) => (
    !preDispatchRows.has(row.id) && !pendingWithoutProductTerminalRows.has(row.id)
  ))
  assert.equal(terminalRows.length, 22)

  for (const row of terminalRows) {
    const { candidate, runtime } = await collectFixture(row)
    assert.ok(runtime.notificationCount > 0, `${row.id} did not exercise a native notification fixture`)
    const closeout = new MatrixCloseout(row)
    const result = await closeout.closeCandidate(candidate)
    assert.equal(closeout.calls, 1, `${row.id} did not reach exactly one Ready closeout`)
    assert.equal(result.success, row.readyOutcome === 'done')
    if (row.candidatePolicy === 'reject') assert.equal(result.finalText, '')
  }
})

test('retired, unsupported, rejected-admission, and unresolved-start rows cannot form a product candidate', () => {
  const noCandidateRows = matrix.rows.filter((row) => (
    preDispatchRows.has(row.id) || pendingWithoutProductTerminalRows.has(row.id)
  ))
  assert.equal(noCandidateRows.length, 7)
  assert.deepEqual(
    new Set([...noCandidateRows.map((row) => row.id), ...matrix.rows
      .filter((row) => !noCandidateRows.includes(row))
      .map((row) => row.id)]).size,
    matrix.rows.length,
  )
  for (const row of noCandidateRows) {
    assert.ok(
      row.publicationPolicy === 'unreachable_in_codex_experiment'
      || row.publicationPolicy === 'typed_unsupported_before_codex_dispatch'
      || row.publicationPolicy === 'typed_send_result_without_product_or_native_writes'
      || row.publicationPolicy === 'no_product_terminal_keep_thread_local_pending',
      `${row.id} does not have a fail-closed no-candidate policy`,
    )
  }
})

test('live host failures map to persistence_failed and never reuse retired delivery_failed', async () => {
  const persistenceRow = matrix.rows.find((row) => row.id === 'persistence_failed')
  const retiredDeliveryRow = matrix.rows.find((row) => row.id === 'dynamic_delivery_deadline')
  assert.ok(persistenceRow)
  assert.equal(retiredDeliveryRow?.disposition, 'retire')

  const candidate = createHostFailureCandidate({
    readyTaskId: 'task:host-failure',
    readyRunId: 'run:host-failure',
    scopeId: 'scope:host-failure',
    codexThreadId: null,
    actionReceiptRefs: [],
    interactionState: null,
    waitingFor: null,
    abortInitiator: null,
    budgetState: {},
    contextState: {},
    providerDiagnostics: {},
    recoveryCheckpointRef: null,
    browserContinuationRef: null,
    browserProofRefs: [],
    otherProofRefs: [],
    projectionPatchRefs: [],
  }, {
    stage: 'prepared_run_context',
    code: 'prepared_run_context_resolution_failed',
    error: new Error('prepared context failed'),
    codexTurnId: null,
  })

  assert.equal(candidate.terminalReasonCandidate, 'persistence_failed')
  assert.notEqual(candidate.terminalReasonCandidate, retiredDeliveryRow?.terminalReason)
  const closeout = new MatrixCloseout(persistenceRow)
  await closeout.closeCandidate(candidate)
  assert.equal(closeout.calls, 1)
})
