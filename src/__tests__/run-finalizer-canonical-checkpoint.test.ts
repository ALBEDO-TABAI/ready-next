/**
 * EP2-Q4a/G0 — enforced adjudication inside the REAL finalize funnel:
 * every RunOutcome.kind produces a CheckIn (enumerated, not hardcoded);
 * zero-proof done → verdict reject + divergence metric + terminal state
 * downgraded; valid paused continuation proof can become checkpoint; ordering
 * hard clause (digest proof lands before the verdict);
 * admission degradation; the export script; both funnel gates stay green.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finalizeRunOutcome, type RunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { projectionPatchFromChildClose } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { adjudicateTerminalOutcome, appendCheckIns, type CheckInRecord } from '../main/modules/agent-control/quality/task-adjudicator'
import { resolveCriteria } from '../main/modules/agent-control/quality/criteria-templates'
import {
  collectArtifactProof,
  collectResponseDigestProof,
  collectToolOutputProofs,
  collectToolResultProof,
  collectTransactionConfirmedProof,
} from '../main/modules/agent-control/quality/proof-collector'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { setBrowserTargetClaimRunCloseoutPort } from '../main/modules/browser-engine/browser-target-claim-closeout'

const NOW = new Date('2026-06-12T12:00:00.000Z')

test.before(() => setBrowserTargetClaimRunCloseoutPort(() => undefined))
test.after(() => setBrowserTargetClaimRunCloseoutPort(null))

function collectDocumentSaveProofs(path = '/tmp/report.md') {
  return collectToolOutputProofs('document_save_tab', createToolExecutionOutput(`已保存文档：${path}`, {
    shape: 'json',
    data: { documentSaved: true, path },
  }), NOW)
}

function fakeStore(initial: Partial<TaskProjectionRecord> & { taskId: string }) {
  const rows = new Map<string, TaskProjectionRecord>()
  rows.set(initial.taskId, {
    scopeId: 's1', runId: 'r1', taskType: 'short_task', module: 'system',
    status: 'running', interactionState: 'running', steps: [],
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...initial,
  } as TaskProjectionRecord)
  const patches: Array<Partial<TaskProjectionRecord>> = []
  return {
    rows,
    patches,
    get: (taskId: string) => rows.get(taskId) ?? null,
    update: (taskId: string, patch: Partial<TaskProjectionRecord>) => {
      patches.push(patch)
      rows.set(taskId, { ...rows.get(taskId)!, ...patch })
    },
  }
}

const ALL_KINDS: Array<RunOutcome['kind']> = ['done', 'checkpoint', 'error', 'cancelled', 'preempted', 'interrupted']

function outcomeOf(kind: RunOutcome['kind'], taskId: string): RunOutcome {
  const base = { runId: `run-${kind}`, taskId, scopeId: 's1', durationMs: 100, toolCallsUsed: 1, initiator: 'test' }
  if (kind === 'done') return { kind, ...base, finalText: '最终回复' }
  if (kind === 'checkpoint') return { kind, ...base, continuationHandle: '/tmp/run_state.json', terminalReason: 'checkpoint', finalText: '断点说明' }
  return { kind, ...base, terminalReason: `${kind}_reason` } as RunOutcome
}

function budgetRuntime(taskType: TaskProjectionRecord['taskType']) {
  return {
    taskType,
    budget: { maxIterations: 8, maxToolCalls: 8 },
    usage: { iterationsUsed: 0, toolCallsUsed: 0 },
    stepBudget: null,
    warningLevel: 'none' as const,
    frozen: false,
    bootstrapBudget: false,
  }
}

test('P0-3: adjudication judges the EFFECTIVE task facts — terminal patch taskType wins over the stale projection row', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    // stale row: first-build default short_task; the terminal patch carries the real type
    const store = fakeStore({ taskId: 'task-effective', taskType: 'short_task' as never, proofRefs: [] })
    await finalizeRunOutcome({
      kind: 'done', runId: 'run-eff', taskId: 'task-effective', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 0, initiator: 'done', finalText: '这就是答案。',
      projectionPatch: { taskType: 'direct_answer', module: 'system' },
    }, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const checkins = store.rows.get('task-effective')!.checkins as CheckInRecord[]
    assert.equal(checkins[0].verdict, 'accept',
      'direct_answer judged by its own criteria (digest proof suffices) — not by the stale short_task row')
    assert.equal(events.filter((event) => event.metric === 'adjudicator_shadow_divergence').length, 0)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('P0-4: run_close metric carries the effective taskType for coverage accounting', async () => {
  const closes: Array<Record<string, unknown>> = []
  const store = fakeStore({ taskId: 'task-close', taskType: 'short_task' as never, proofRefs: [collectToolResultProof('t', 'ok', NOW)] })
  await finalizeRunOutcome({
    kind: 'done', runId: 'run-close-1', taskId: 'task-close', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: 'ok',
    projectionPatch: { taskType: 'multi_step_task' },
  }, {
    writeRunCloseMetric: (metric) => closes.push(metric as unknown as Record<string, unknown>),
    taskProjectionStore: store,
    now: () => NOW,
  })
  assert.equal(closes[0].taskType, 'multi_step_task', 'close metric reports the effective type')

  // no projection store wired → metric still emits, taskType null (legacy callers)
  const bare: Array<Record<string, unknown>> = []
  await finalizeRunOutcome({
    kind: 'error', runId: 'run-close-2', taskId: null, scopeId: null,
    durationMs: 5, toolCallsUsed: 0, initiator: 'error', terminalReason: 'x',
  }, { writeRunCloseMetric: (metric) => bare.push(metric as unknown as Record<string, unknown>) })
  assert.equal(bare[0].taskType ?? null, null)
})

// ── P2-5: learningDecision + learningRefs writer ───────────────────────────

test('adjudicator sets learningDecision.learned true only for accept + durable refs', () => {
  const criteria = resolveCriteria('short_task', 'system', {}).items
  const accepted = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria,
    proofs: [collectToolResultProof('t', 'ok', NOW)],
    learningRefs: [{ kind: 'artifact', path: '/tmp/x.md' }],
    now: NOW,
  })
  assert.equal(accepted.verdict, 'accept')
  assert.equal(accepted.checkIn.learningDecision?.learned, true)
  assert.equal(accepted.checkIn.learningDecision?.refCount, 1)

  const noRefs = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria,
    proofs: [collectToolResultProof('t', 'ok', NOW)],
    learningRefs: [],
    now: NOW,
  })
  assert.equal(noRefs.checkIn.learningDecision?.learned, false)
  assert.equal(noRefs.checkIn.learningDecision?.refCount, 0)
})

test('research source criteria require real acquisition proofs, never a written artifact or generic tool result', () => {
  const criteria = resolveCriteria('research', 'skill', {
    skillExecutionForm: 'direct',
    skillHasRunStateHandle: false,
  }).items
  const responseProof = collectResponseDigestProof('research response', NOW)!
  const artifactOnly = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria,
    proofs: [
      responseProof,
      collectArtifactProof('/tmp/report.md', NOW),
      collectToolResultProof('skill_write_artifact', 'wrote report', NOW),
    ],
    now: NOW,
  })
  assert.notEqual(artifactOnly.verdict, 'accept')
  assert.ok(artifactOnly.checkIn.blockers.includes('criteria_unsatisfied:c2'))

  const discoveryOnly = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria,
    proofs: [
      responseProof,
      collectArtifactProof('/tmp/report.md', NOW),
      collectToolResultProof('web_search', 'source list https://example.com/source', NOW),
    ],
    now: NOW,
  })
  assert.notEqual(discoveryOnly.verdict, 'accept')
  assert.ok(discoveryOnly.checkIn.blockers.includes('criteria_unsatisfied:c2'))

  for (const fakeContentTool of [
    'browser_snapshot',
    'browser_collect',
    'browser_collect',
    'browser_collect',
  ]) {
    const handleOnly = adjudicateTerminalOutcome({
      terminalStatus: 'done',
      terminalReason: 'done',
      criteria,
      proofs: [
        responseProof,
        collectArtifactProof('/tmp/report.md', NOW),
        collectToolResultProof('browser_search', 'source list https://example.com/source', NOW),
        collectToolResultProof(fakeContentTool, 'task/page handle https://example.com/source', NOW),
      ],
      now: NOW,
    })
    assert.notEqual(handleOnly.verdict, 'accept', `${fakeContentTool} is not an acquired body`)
    assert.ok(handleOnly.checkIn.blockers.includes('criteria_unsatisfied:c2'))
  }

  const sourced = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria,
    proofs: [
      responseProof,
      collectArtifactProof('/tmp/report.md', NOW),
      collectToolResultProof('web_search', 'source list https://example.com/source', NOW),
      collectToolResultProof('web_fetch', 'source body https://example.com/source', NOW),
    ],
    now: NOW,
  })
  assert.equal(sourced.verdict, 'accept')
})

test('non-done terminal outcomes can never produce an accepted or learnable Check-in', () => {
  const result = adjudicateTerminalOutcome({
    terminalStatus: 'error',
    terminalReason: 'delivery_failed',
    criteria: resolveCriteria('research', 'skill', {
      skillExecutionForm: 'direct',
      skillHasRunStateHandle: false,
    }).items,
    proofs: [
      collectArtifactProof('/tmp/report.md', NOW),
      collectToolResultProof('web_search', 'source list https://example.com/source', NOW),
      collectToolResultProof('web_fetch', 'source body https://example.com/source', NOW),
    ],
    learningRefs: [{ kind: 'artifact', ref: '/tmp/report.md' }],
    now: NOW,
  })

  assert.equal(result.verdict, 'reject')
  assert.ok(result.checkIn.blockers.includes('terminal_not_done:error'))
  assert.equal(result.checkIn.learningDecision?.learned, false)
})

test('finalizer writes learningRefs to the projection for an accepted durable run', () => {
  return (async () => {
    const store = fakeStore({
      taskId: 'task-learn-write',
      taskType: 'browser_transaction' as never,
      module: 'browser',
      proofRefs: [
        collectToolResultProof('browser_network', 'ok', NOW),
        collectTransactionConfirmedProof('browser_network:network:success_response', 'network success', NOW),
      ],
    })
    await finalizeRunOutcome({
      kind: 'done', runId: 'run-learn-write', taskId: 'task-learn-write', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '已发布',
    }, { writeRunCloseMetric: () => {}, taskProjectionStore: store, now: () => NOW })

    const learningPatch = store.patches.find((p) => 'learningRefs' in p)
    assert.ok(learningPatch, 'a learningRefs patch must be written')
    const refs = (learningPatch as { learningRefs?: unknown[] }).learningRefs ?? []
    assert.ok(refs.length >= 1, 'durable transaction_confirmed proof becomes a learning ref')
    const checkins = store.rows.get('task-learn-write')!.checkins as CheckInRecord[]
    assert.equal(checkins.at(-1)!.learningDecision?.learned, true)
  })()
})

test('finalizer does NOT write learningRefs when the run produced no durable evidence', () => {
  return (async () => {
    const store = fakeStore({
      taskId: 'task-learn-none',
      taskType: 'direct_answer' as never,
      // A single non-durable tool_result proof (no path, non-durable kind).
      proofRefs: [collectToolResultProof('lookup', 'answered inline', NOW)],
    })
    await finalizeRunOutcome({
      kind: 'done', runId: 'run-learn-none', taskId: 'task-learn-none', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '答案',
    }, { writeRunCloseMetric: () => {}, taskProjectionStore: store, now: () => NOW })

    const learningPatch = store.patches.find((p) => 'learningRefs' in p)
    assert.equal(learningPatch, undefined, 'no durable evidence → no learningRefs write')
  })()
})

test('P2-2: finalizer persists resolved criteria (items + satisfied/total) to the projection', () => {
  return (async () => {
    const store = fakeStore({
      taskId: 'task-criteria-persist',
      taskType: 'multi_step_task' as never,
      proofRefs: [collectToolResultProof('t', 'ok', NOW)],
    })
    await finalizeRunOutcome({
      kind: 'done', runId: 'run-criteria', taskId: 'task-criteria-persist', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: 'done',
    }, { writeRunCloseMetric: () => {}, taskProjectionStore: store, now: () => NOW })

    const criteriaPatch = store.patches.find((p) => 'criteria' in p) as { criteria?: { items?: unknown[]; totalCount?: number } } | undefined
    assert.ok(criteriaPatch, 'criteria must be persisted')
    assert.ok(Array.isArray(criteriaPatch!.criteria!.items) && criteriaPatch!.criteria!.items!.length >= 1)
    assert.equal(typeof criteriaPatch!.criteria!.totalCount, 'number')
  })()
})

test('Browser checkpoint finalization fails before publication without its canonical receipt', async () => {
  let published = false
  await assert.rejects(finalizeRunOutcome({
    kind: 'checkpoint',
    runId: 'run-browser-checkpoint-missing-canonical',
    taskId: 'task-browser-checkpoint-missing-canonical',
    scopeId: 'scope-browser-checkpoint-missing-canonical',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'checkpoint',
    terminalReason: 'checkpoint_incomplete',
    finalText: 'saved',
    continuationHandle: 'checkpoint-1',
    projectionPatch: {
      continuationRef: {
        kind: 'browser_checkpoint',
        checkpointId: 'checkpoint-1',
      },
    },
  }, {
    writeProjectionTerminalPatch: () => { published = true },
    writeRunCloseMetric: () => { published = true },
  }), /browser_checkpoint_canonical_receipt_missing/)
  assert.equal(published, false)
})
