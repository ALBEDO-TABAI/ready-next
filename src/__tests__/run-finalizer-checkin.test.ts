/**
 * EP2-Q4a — shadow adjudication inside the REAL finalize funnel:
 * every RunOutcome.kind produces a CheckIn (enumerated, not hardcoded);
 * zero-proof done → verdict reject + divergence metric + terminal state
 * untouched; ordering hard clause (digest proof lands before the verdict);
 * admission degradation; the export script; both funnel gates stay green.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finalizeRunOutcome, type RunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { adjudicateTerminalOutcome, appendCheckIns, type CheckInRecord } from '../main/modules/agent-control/quality/task-adjudicator'
import { resolveCriteria } from '../main/modules/agent-control/quality/criteria-templates'
import { collectToolResultProof } from '../main/modules/agent-control/quality/proof-collector'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const NOW = new Date('2026-06-12T12:00:00.000Z')

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

test('every RunOutcome.kind produces a CheckIn through the real funnel (enumerated, no hardcoded count)', async () => {
  for (const kind of ALL_KINDS) {
    const store = fakeStore({ taskId: `task-${kind}`, proofRefs: [collectToolResultProof('t', 'ok', NOW)] })
    await finalizeRunOutcome(outcomeOf(kind, `task-${kind}`), {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const checkins = store.rows.get(`task-${kind}`)!.checkins as CheckInRecord[]
    assert.equal(checkins.length, 1, `${kind} must produce exactly one CheckIn`)
    assert.equal(checkins[0].kind, 'shadow')
    assert.equal(checkins[0].ts, NOW.toISOString())
  }
})

test('zero-proof done: verdict reject + divergence metric + terminal state UNTOUCHED', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const store = fakeStore({ taskId: 'task-zero', taskType: 'short_task' as never, proofRefs: [] })
    const runMeta = new Map<string, Record<string, unknown>>()
    await finalizeRunOutcome({ kind: 'done', runId: 'run-z', taskId: 'task-zero', scopeId: 's1', durationMs: 10, toolCallsUsed: 0, initiator: 'done' }, {
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
    assert.equal(checkins[0].verdict, 'reject')
    assert.ok(checkins[0].blockers.includes('zero_proof_done'))
    assert.equal(runMeta.get('run-z')!.status, 'done', 'shadow mode: run_meta terminal stays done')
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

test('ordering hard clause: direct_answer done with finalText is judged WITH the digest proof — zero divergence', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const store = fakeStore({ taskId: 'task-da', taskType: 'direct_answer' as never, proofRefs: [] })
    await finalizeRunOutcome({ kind: 'done', runId: 'run-da', taskId: 'task-da', scopeId: 's1', durationMs: 10, toolCallsUsed: 0, initiator: 'done', finalText: '这就是答案。' }, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const row = store.rows.get('task-da')!
    const proofs = row.proofRefs as Array<{ kind: string }>
    assert.ok(proofs.some((proof) => proof.kind === 'assistant_response'), 'digest proof landed')
    const checkins = row.checkins as CheckInRecord[]
    assert.equal(checkins[0].verdict, 'accept', 'judged AFTER the digest proof — no structural zero-proof')
    assert.equal(events.filter((event) => event.metric === 'adjudicator_shadow_divergence').length, 0)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('admission degradation: invalid learning refs mark the verdict degraded (pure function)', () => {
  const criteria = resolveCriteria('short_task', 'system')
  const { verdict, checkIn } = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria: criteria.items,
    proofs: [collectToolResultProof('t', 'ok', NOW)],
    learningRefsValid: false,
    now: NOW,
  })
  assert.equal(verdict, 'degraded')
  assert.ok(checkIn.blockers.includes('learning_refs_missing'))
})

test('checkins rolling governance: limit 50, overflow archives oldest first', () => {
  let rows: unknown[] = []
  const archived: unknown[][] = []
  for (let i = 0; i < 53; i += 1) {
    rows = appendCheckIns(rows, {
      kind: 'shadow', verdict: 'accept', terminalStatus: 'done', terminalReason: `r${i}`,
      satisfiedCount: 1, totalCount: 1, proofCount: 1, blockers: [], ts: NOW.toISOString(),
    }, { archive: (overflow) => archived.push(overflow) })
  }
  assert.equal(rows.length, 50)
  assert.equal(archived.flat().length, 3)
})

test('export script reports divergence rows and terminal-run sample size from a metrics log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-q4a-'))
  try {
    const log = join(dir, 'metrics.log')
    const lines = [
      { at: '2026-06-12T10:00:00.000Z', metric: 'run_close', runId: 'r1' },
      { at: '2026-06-12T10:01:00.000Z', metric: 'adjudicator_shadow_divergence', runId: 'r1', taskId: 't1', taskType: 'short_task', verdict: 'reject', actualStatus: 'done', proofCount: 0 },
      { at: '2026-06-10T10:00:00.000Z', metric: 'adjudicator_shadow_divergence', runId: 'r0', taskType: 'research', verdict: 'reject' }, // before --since
      'not json at all',
      { at: '2026-06-12T11:00:00.000Z', metric: 'run_close', runId: 'r2' },
    ]
    writeFileSync(log, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'), 'utf-8')
    const output = execFileSync('node', ['scripts/export-adjudicator-divergence.cjs', '--since', '2026-06-12T00:00:00.000Z', '--file', log], { encoding: 'utf-8' })
    const report = JSON.parse(output)
    assert.equal(report.count, 1)
    assert.equal(report.totalTerminalRuns, 2)
    assert.deepEqual(report.taskTypes, { short_task: 1 })
    assert.equal(report.rows[0].disposition, null, 'disposition column ready for the Q4b review')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('both funnel gates stay green', () => {
  execFileSync('node', ['scripts/check-run-finalize-funnel.cjs'], { encoding: 'utf-8' })
  execFileSync('node', ['scripts/check-checkin-funnel.cjs'], { encoding: 'utf-8' })
})
