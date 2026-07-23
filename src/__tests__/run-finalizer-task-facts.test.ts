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

test('only terminal RunOutcome kinds produce a CheckIn; checkpoints stay resumable', async () => {
  for (const kind of ALL_KINDS) {
    const store = fakeStore({ taskId: `task-${kind}`, proofRefs: [collectToolResultProof('t', 'ok', NOW)] })
    await finalizeRunOutcome(outcomeOf(kind, `task-${kind}`), {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const checkins = (store.rows.get(`task-${kind}`)!.checkins ?? []) as CheckInRecord[]
    assert.equal(checkins.length, kind === 'checkpoint' ? 0 : 1)
    if (kind === 'checkpoint') continue
    assert.equal(checkins[0].kind, 'enforce')
    assert.equal(checkins[0].ts, NOW.toISOString())
  }
})

test('zero-proof done: verdict reject + divergence metric + terminal state downgraded', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const store = fakeStore({ taskId: 'task-zero', taskType: 'short_task' as never, proofRefs: [] })
    const runMeta = new Map<string, Record<string, unknown>>()
    const finalized = await finalizeRunOutcome({ kind: 'done', runId: 'run-z', taskId: 'task-zero', scopeId: 's1', durationMs: 10, toolCallsUsed: 0, initiator: 'done' }, {
      writeRunCloseMetric: () => {},
      runMetaRepository: {
        get: (runId) => runMeta.get(runId) ?? null,
        create: (input) => { runMeta.set(String(input.runId), input); return input },
        update: (runId, patch) => { runMeta.set(runId, { ...runMeta.get(runId), ...patch }); return patch },
      },
      taskProjectionStore: store,
      now: () => NOW,
    })
    const checkins = store.rows.get('task-zero')!.checkins as CheckInRecord[]
    assert.equal(checkins[0].kind, 'enforce')
    assert.equal(checkins[0].verdict, 'reject')
    assert.ok(checkins[0].blockers.includes('zero_proof_done'))
    assert.equal(finalized.status, 'error')
    assert.equal(finalized.terminalReason, 'proof_gap')
    assert.equal(runMeta.get('run-z')!.status, 'error')
    assert.equal(runMeta.get('run-z')!.terminalReason, 'proof_gap')
    for (const patch of store.patches) {
      assert.ok(!('status' in patch) && !('interactionState' in patch), 'projection lifecycle fields untouched by adjudication')
    }
    const divergence = events.find((event) => event.metric === 'adjudicator_shadow_divergence')
    assert.ok(divergence, 'divergence metric recorded')
    assert.equal((divergence as unknown as { verdict: string }).verdict, 'reject')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('browser_transaction without transaction_confirmed proof cannot finish as completed', async () => {
  const store = fakeStore({
    taskId: 'task-browser-transaction-missing',
    taskType: 'browser_transaction' as never,
    module: 'browser',
    proofRefs: [collectToolResultProof('browser_click', 'clicked publish', NOW)],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-browser-transaction-missing',
    taskId: 'task-browser-transaction-missing',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '已发布',
  }, {
    writeRunCloseMetric: () => {},
    runMetaRepository: {
      get: (runId) => runMeta.get(runId) ?? null,
      create: (input) => { runMeta.set(String(input.runId), input); return input },
      update: (runId, patch) => { runMeta.set(runId, { ...runMeta.get(runId), ...patch }); return patch },
    },
    taskProjectionStore: store,
    now: () => NOW,
  })

  const checkins = store.rows.get('task-browser-transaction-missing')!.checkins as CheckInRecord[]
  assert.equal(checkins.at(-1)!.verdict, 'degraded')
  assert.ok(checkins.at(-1)!.blockers.includes('criteria_unsatisfied:t1'))
  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'browser_transaction_unconfirmed')
  assert.equal(runMeta.get('run-browser-transaction-missing')!.terminalReason, 'browser_transaction_unconfirmed')
})

test('browser_transaction with transaction_confirmed proof can complete', async () => {
  const store = fakeStore({
    taskId: 'task-browser-transaction-ok',
    taskType: 'browser_transaction' as never,
    module: 'browser',
    proofRefs: [
      collectToolResultProof('browser_network', 'ok', NOW),
      collectTransactionConfirmedProof('browser_network:network:success_response', 'network success', NOW),
    ],
  })
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-browser-transaction-ok',
    taskId: 'task-browser-transaction-ok',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '已发布',
  }, {
    writeRunCloseMetric: () => {},
    taskProjectionStore: store,
    now: () => NOW,
  })

  const checkins = store.rows.get('task-browser-transaction-ok')!.checkins as CheckInRecord[]
  assert.equal(checkins.at(-1)!.verdict, 'accept')
  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
})

test('run_meta records effective browser_transaction type from terminal projection patch', async () => {
  const store = fakeStore({
    taskId: 'task-browser-transaction-patch-type',
    taskType: 'short_task' as never,
    module: 'browser',
    proofRefs: [
      collectTransactionConfirmedProof('browser_eval:page_text:success_text', 'page success', NOW),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-browser-transaction-patch-type',
    taskId: 'task-browser-transaction-patch-type',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '已发布',
    projectionPatch: {
      taskType: 'browser_transaction',
      module: 'browser',
    },
  }, {
    writeRunCloseMetric: () => {},
    runMetaRepository: {
      get: (runId) => runMeta.get(runId) ?? null,
      create: (input) => { runMeta.set(String(input.runId), input); return input },
      update: (runId, patch) => { runMeta.set(runId, { ...runMeta.get(runId), ...patch }); return patch },
    },
    taskProjectionStore: store,
    now: () => NOW,
  })

  assert.equal(finalized.status, 'done')
  assert.equal(runMeta.get('run-browser-transaction-patch-type')!.taskType, 'browser_transaction')
})

test('browser_transaction adjudication unavailable does not silently complete; direct_answer remains tolerant', async () => {
  const transaction = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-browser-transaction-no-store',
    taskId: 'task-browser-transaction-no-store',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '已发布',
    taskBudgetRuntime: budgetRuntime('browser_transaction' as never),
  }, {
    writeRunCloseMetric: () => {},
    now: () => NOW,
  })
  assert.equal(transaction.status, 'error')
  assert.equal(transaction.terminalReason, 'browser_transaction_unconfirmed')

  const direct = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-direct-no-store',
    taskId: 'task-direct-no-store',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 0,
    initiator: 'done',
    finalText: '直接回答',
    taskBudgetRuntime: budgetRuntime('direct_answer' as never),
  }, {
    writeRunCloseMetric: () => {},
    now: () => NOW,
  })
  assert.equal(direct.status, 'done')
})

test('P1 live regression: a browser_transaction finalized DIRECTLY as error/proof_gap normalizes to browser_transaction_unconfirmed', async () => {
  // The ledger showed run_meta rows with task_type=browser_transaction AND
  // terminal_reason=proof_gap — the publish task surfaced as a hard 失败.
  // A direct kind:'error' finalize skipped the done→adjudication conversion;
  // the finalizer must normalize the generic gap to the recoverable reason.
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'error',
    runId: 'run-bt-direct-error',
    taskId: 'task-bt-direct-error',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 2,
    initiator: 'error',
    terminalReason: 'proof_gap',
    taskBudgetRuntime: budgetRuntime('browser_transaction' as never),
  }, {
    writeRunCloseMetric: () => {},
    runMetaRepository: {
      get: (runId) => runMeta.get(runId) ?? null,
      create: (input) => { runMeta.set(String(input.runId), input); return input },
      update: (runId, patch) => { runMeta.set(runId, { ...runMeta.get(runId), ...patch }); return patch },
    },
    now: () => NOW,
  })
  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'browser_transaction_unconfirmed')
  assert.equal(runMeta.get('run-bt-direct-error')!.terminalReason, 'browser_transaction_unconfirmed')
  assert.equal(runMeta.get('run-bt-direct-error')!.taskType, 'browser_transaction')
})

test('P1: a non-browser direct error/proof_gap keeps proof_gap (normalization is browser-transaction only)', async () => {
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'error',
    runId: 'run-short-direct-error',
    taskId: 'task-short-direct-error',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 0,
    initiator: 'error',
    terminalReason: 'proof_gap',
    taskBudgetRuntime: budgetRuntime('short_task' as never),
  }, {
    writeRunCloseMetric: () => {},
    runMetaRepository: {
      get: (runId) => runMeta.get(runId) ?? null,
      create: (input) => { runMeta.set(String(input.runId), input); return input },
      update: (runId, patch) => { runMeta.set(runId, { ...runMeta.get(runId), ...patch }); return patch },
    },
    now: () => NOW,
  })
  assert.equal(finalized.terminalReason, 'proof_gap')
})

