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

function skillRunDeps(runMeta: Map<string, Record<string, unknown>>, verifyRunStateTerminal: (p: string) => boolean) {
  return {
    writeRunCloseMetric: () => {},
    runMetaRepository: {
      get: (runId: string) => runMeta.get(runId) ?? null,
      create: (input: Record<string, unknown>) => { runMeta.set(String(input.runId), input); return input },
      update: (runId: string, patch: Record<string, unknown>) => { runMeta.set(runId, { ...runMeta.get(runId), ...patch }); return patch },
    },
    verifyRunStateTerminal,
    verifyArtifactExists: () => false, // isolate s1 to the run_state proof only
    now: () => NOW,
  }
}

test('A1: a skill run whose run_state is VALIDATED terminal-done+delivery → s1 satisfied, stays done', async () => {
  const store = fakeStore({
    taskId: 'task-skill-ok', taskType: 'short_task' as never, module: 'skill',
    proofRefs: [collectToolResultProof('skill_x', 'ok', NOW)], // satisfies c1 tool_call, NOT s1
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-skill-ok', taskId: 'task-skill-ok', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '技能完成',
    projectionPatch: { taskContinuation: { runStatePath: '/tmp/out/run_state.json' } },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => true), taskProjectionStore: store })
  const checkins = store.rows.get('task-skill-ok')!.checkins as CheckInRecord[]
  assert.equal(checkins.at(-1)!.verdict, 'accept', 's1 satisfied by the validated run_state proof')
  assert.equal(finalized.status, 'done')
})

test('A1 control: run_state still running / missing delivery → NOT verified → s1 unsatisfied → force-converted', async () => {
  const store = fakeStore({
    taskId: 'task-skill-running', taskType: 'short_task' as never, module: 'skill',
    proofRefs: [collectToolResultProof('skill_x', 'ok', NOW)],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-skill-running', taskId: 'task-skill-running', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '技能完成',
    // handle present (skill emitted runStatePath at START) but NOT terminal-done
    projectionPatch: { taskContinuation: { runStatePath: '/tmp/out/run_state.json' } },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })
  const checkins = store.rows.get('task-skill-running')!.checkins as CheckInRecord[]
  assert.equal(checkins.at(-1)!.verdict, 'degraded')
  assert.ok(checkins.at(-1)!.blockers.includes('criteria_unsatisfied:s1'), 'a bare/running run_state must not satisfy s1')
  assert.equal(finalized.status, 'error')
})

test('A1 wiring: a REAL child close (projectionPatch null, top-level handle) synthesizes a continuationRef', () => {
  const close = {
    childRunId: 'child-vea', skillId: 'video-expert-analyzer', status: 'completed', terminalReason: 'completed',
    outputDir: '/tmp/vea-out', runStatePath: '/tmp/vea-out/run_state.json',
    sceneScoresPath: '/tmp/vea-out/scene_scores.json', deliveryReportPath: '/tmp/vea-out/delivery_report.json',
    progress: { stage: 'completed', totalUnits: 3, completedUnits: 3, coverageRatio: 1, fingerprint: 'fp' },
    framePatch: null, projectionPatch: null, error: null,
  }
  const patch = projectionPatchFromChildClose(close as never) as { continuationRef?: Record<string, unknown> }
  assert.equal(patch?.continuationRef?.runStatePath, '/tmp/vea-out/run_state.json')
  assert.equal(patch?.continuationRef?.deliveryReportPath, '/tmp/vea-out/delivery_report.json')
  assert.equal(patch?.continuationRef?.outputDir, '/tmp/vea-out')
})

test('A1 wiring end-to-end: real completed child close → skill run stays done (s1 via synthesized handle)', async () => {
  const close = {
    childRunId: 'child-vea', skillId: 'video-expert-analyzer', status: 'completed', terminalReason: 'completed',
    outputDir: '/tmp/vea-out', runStatePath: '/tmp/vea-out/run_state.json',
    sceneScoresPath: null, deliveryReportPath: '/tmp/vea-out/delivery_report.json',
    progress: { stage: 'completed', totalUnits: 3, completedUnits: 3, coverageRatio: 1, fingerprint: 'fp' },
    framePatch: null, projectionPatch: null, error: null,
  }
  const projectionPatch = projectionPatchFromChildClose(close as never)!
  const store = fakeStore({
    taskId: 'task-vea', taskType: 'short_task' as never, module: 'skill',
    proofRefs: [collectToolResultProof('skill_x', 'ok', NOW)],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-vea', taskId: 'task-vea', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: 'VEA 完成', projectionPatch,
  } as RunOutcome, { ...skillRunDeps(runMeta, () => true), taskProjectionStore: store })
  const checkins = store.rows.get('task-vea')!.checkins as CheckInRecord[]
  assert.equal(checkins.at(-1)!.verdict, 'accept', 's1 satisfied via the continuationRef synthesized from the real close')
  assert.equal(finalized.status, 'done')
})

test('A1 wiring control: a real close whose run_state is NOT verified stays error (no error→checkpoint flip)', async () => {
  const close = {
    childRunId: 'child-vea', skillId: 'video-expert-analyzer', status: 'completed', terminalReason: 'completed',
    outputDir: '/tmp/vea-out', runStatePath: '/tmp/vea-out/run_state.json',
    sceneScoresPath: null, deliveryReportPath: '/tmp/vea-out/delivery_report.json',
    progress: { stage: 'completed', totalUnits: 3, completedUnits: 3, coverageRatio: 1, fingerprint: 'fp' },
    framePatch: null, projectionPatch: null, error: null,
  }
  const projectionPatch = projectionPatchFromChildClose(close as never)!
  // synthesized handle must NOT carry childRunId (would trip canResumeAsUserPoint)
  assert.equal((projectionPatch as { continuationRef?: Record<string, unknown> }).continuationRef?.childRunId, undefined)
  const store = fakeStore({
    taskId: 'task-vea-fail', taskType: 'short_task' as never, module: 'skill',
    proofRefs: [collectToolResultProof('skill_x', 'ok', NOW)],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-vea-fail', taskId: 'task-vea-fail', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: 'VEA 自称完成', projectionPatch,
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })
  assert.equal(finalized.status, 'error', 'unverified completion stays error, not checkpoint')
  // had proofs (tool_result) but s1 unsatisfied → adjudication_degraded, not proof_gap
  assert.equal(finalized.terminalReason, 'adjudication_degraded')
})


test('P0-1: skill_write_artifact absolutePath mints artifact proof', () => {
  const proofs = collectToolOutputProofs('skill_write_artifact', {
    text: 'Wrote 42 bytes to /tmp/ready-skill/out.md',
    data: {
      absolutePath: '/tmp/ready-skill/out.md',
      bytesWritten: 42,
      artifactRoot: '/tmp/ready-skill',
    },
  }, NOW)

  assert.ok(proofs.some((proof) => proof.kind === 'tool_result' && proof.ref === 'skill_write_artifact'))
  assert.ok(proofs.some((proof) => proof.kind === 'artifact' && proof.ref === '/tmp/ready-skill/out.md'))
})

test('P0-2: a primitive-only skill run (NO run_state handle) exempts s1 → stays done on its tool_result proof', async () => {
  // Primitive-only skill turn (skill_run_shell / skill_write_artifact): no child
  // run, so no run_state handle and no run_state.json/delivery_report can ever
  // exist. s1 is structurally unsatisfiable, so it must be notApplicable — the
  // tool_result proof (short_task c1) is the terminal evidence. This must NOT be
  // force-failed (the old behavior wrongly judged it error).
  const store = fakeStore({
    taskId: 'task-skill-primitive', taskType: 'short_task' as never, module: 'skill',
    proofRefs: [collectToolResultProof('skill_write_artifact', 'ok', NOW)],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-skill-primitive', taskId: 'task-skill-primitive', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '技能完成',
  } as RunOutcome, { ...skillRunDeps(runMeta, () => true), taskProjectionStore: store })
  const last = (store.rows.get('task-skill-primitive')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'accept', 'primitive skill with a tool_result proof is accepted')
  assert.ok(!last.blockers.includes('criteria_unsatisfied:s1'), 's1 is notApplicable for a handle-less primitive run')
  assert.equal(finalized.status, 'done', 'a successful primitive skill run is NOT force-failed')
})


test('R-CRIT: finalizer emits adjudicator_criteria_resolved coverage_count + fails a declared-target under-delivery end-to-end', async () => {
  // Drives the LIVE glue: deriveCoverageTargets(steps_json expectedOutputs) →
  // resolveCriteria(delivery_coverage) → adjudicator counting → the metric.
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const store = fakeStore({
      taskId: 'task-skill-coverage',
      taskType: 'multi_step_task' as never,
      module: 'skill',
      steps: [
        { id: 'step-1', description: 'reverse-describe', expectedOutputs: ['/Users/user/V/描述.md'] },
        { id: 'step-2', description: 'deep-read', expectedOutputs: ['/Users/user/V/深读.md'] },
      ] as never,
      proofRefs: [collectArtifactProof('/Users/user/V/描述.md', NOW)], // only 1 of 2 declared docs delivered
    })
    await finalizeRunOutcome({
      kind: 'done', runId: 'run-skill-cov', taskId: 'task-skill-coverage', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 2, initiator: 'done', finalText: '完成',
    } as RunOutcome, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const metric = events.find((event) => event.metric === 'adjudicator_criteria_resolved') as
      unknown as { mode: string; delivered: number; expected: number; item: string } | undefined
    assert.ok(metric, 'adjudicator_criteria_resolved must fire for a declared-target skill run')
    assert.equal(metric!.mode, 'coverage_count')
    assert.equal(metric!.delivered, 1)
    assert.equal(metric!.expected, 2)
    const last = (store.rows.get('task-skill-coverage')!.checkins as CheckInRecord[]).at(-1)!
    assert.notEqual(last.verdict, 'accept', 'under-delivery (1 of 2) must not accept end-to-end')
    assert.ok(last.blockers.includes('criteria_unsatisfied:c1'))
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('P0-2 control: a skill run with an unverified run_state handle still owes s1', async () => {
  const store = fakeStore({
    taskId: 'task-skill-handle-unverified', taskType: 'short_task' as never, module: 'skill',
    proofRefs: [collectToolResultProof('skill_write_artifact', 'ok', NOW)],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-skill-handle-unverified', taskId: 'task-skill-handle-unverified', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '技能完成',
    projectionPatch: { taskContinuation: { runStatePath: '/tmp/out/run_state.json' } },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-skill-handle-unverified')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'degraded')
  assert.ok(last.blockers.includes('criteria_unsatisfied:s1'))
  assert.equal(finalized.status, 'error')
})


test('document multi-step with no step source marks c1 notApplicable on document delivery proof', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-save',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [],
    proofRefs: collectDocumentSaveProofs('/tmp/report.md'),
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-save', taskId: 'task-document-multistep-save', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '文档已保存',
    projectionPatch: { taskType: 'multi_step_task', module: 'document' },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-save')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'accept')
  assert.equal(last.totalCount, 3)
  assert.equal(last.blockers.includes('criteria_unsatisfied:c1'), false)
  assert.equal(finalized.status, 'done')
})

test('document multi-step without document save proof still owes steps_complete proof', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-unsaved',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [],
    proofRefs: [
      collectToolResultProof('document_set_content', '已写入内容，尚未保存', NOW),
      collectArtifactProof('/tmp/unsaved.md', NOW),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-unsaved', taskId: 'task-document-multistep-unsaved', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '文档已写入',
    projectionPatch: { taskType: 'multi_step_task', module: 'document' },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-unsaved')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'degraded')
  assert.ok(last.blockers.includes('criteria_unsatisfied:c1'))
})

test('document multi-step with failed save and unrelated artifact still owes steps_complete proof', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-failed-save-unrelated-artifact',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [],
    proofRefs: [
      collectToolResultProof('document_save_tab', '保存失败：权限不足', NOW),
      collectArtifactProof('/tmp/unrelated-screenshot.png', NOW),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-failed-save-unrelated-artifact', taskId: 'task-document-multistep-failed-save-unrelated-artifact', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '文档已保存',
    projectionPatch: { taskType: 'multi_step_task', module: 'document' },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-failed-save-unrelated-artifact')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'degraded')
  assert.ok(last.blockers.includes('criteria_unsatisfied:c1'))
  assert.equal(finalized.terminalReason, 'adjudication_degraded')
})

test('document multi-step with synthetic document progress still marks c1 notApplicable', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-document-progress',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [
      { id: 'document_write', title: '已写入内容', status: 'done', updatedAt: NOW.toISOString() },
      { id: 'document_save', title: '已保存到指定目录', status: 'done', updatedAt: NOW.toISOString() },
    ] as never,
    proofRefs: [
      collectToolResultProof('document_set_content', '已写入内容', NOW),
      ...collectDocumentSaveProofs('/tmp/report.md'),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-document-progress', taskId: 'task-document-multistep-document-progress', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 2, initiator: 'done', finalText: '文档已保存',
    projectionPatch: { taskType: 'multi_step_task', module: 'document' },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-document-progress')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'accept')
  assert.equal(last.totalCount, 3)
  assert.equal(last.blockers.includes('criteria_unsatisfied:c1'), false)
  assert.equal(finalized.status, 'done')
})

test('document multi-step with failed synthetic document progress still owes steps_complete proof', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-failed-document-progress',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [
      { id: 'document_write', title: '写入内容失败', status: 'error', updatedAt: NOW.toISOString() },
      { id: 'document_save', title: '已保存到指定目录', status: 'done', updatedAt: NOW.toISOString() },
    ] as never,
    proofRefs: [
      ...collectDocumentSaveProofs('/tmp/report.md'),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  const finalized = await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-failed-document-progress', taskId: 'task-document-multistep-failed-document-progress', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 2, initiator: 'done', finalText: '文档已保存',
    projectionPatch: { taskType: 'multi_step_task', module: 'document' },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-failed-document-progress')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'degraded')
  assert.ok(last.blockers.includes('criteria_unsatisfied:c1'))
  assert.equal(finalized.terminalReason, 'adjudication_degraded')
})

test('document multi-step with planned steps still owes steps_complete proof', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-planned',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [{ id: 's1', title: '写入文档', status: 'running', updatedAt: NOW.toISOString() }] as never,
    proofRefs: [
      ...collectDocumentSaveProofs('/tmp/report.md'),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-planned', taskId: 'task-document-multistep-planned', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '文档已保存',
    projectionPatch: { taskType: 'multi_step_task', module: 'document' },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-planned')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'degraded')
  assert.ok(last.blockers.includes('criteria_unsatisfied:c1'))
})

test('document multi-step with terminal patch planned steps still owes steps_complete proof', async () => {
  const store = fakeStore({
    taskId: 'task-document-multistep-terminal-planned',
    taskType: 'multi_step_task' as never,
    module: 'document',
    steps: [],
    proofRefs: [
      ...collectDocumentSaveProofs('/tmp/report.md'),
    ],
  })
  const runMeta = new Map<string, Record<string, unknown>>()
  await finalizeRunOutcome({
    kind: 'done', runId: 'run-document-multistep-terminal-planned', taskId: 'task-document-multistep-terminal-planned', scopeId: 's1',
    durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '文档已保存',
    projectionPatch: {
      taskType: 'multi_step_task',
      module: 'document',
      steps: [{ id: 'outline_review', title: '确认大纲', status: 'running', updatedAt: NOW.toISOString() }],
    },
  } as RunOutcome, { ...skillRunDeps(runMeta, () => false), taskProjectionStore: store })

  const last = (store.rows.get('task-document-multistep-terminal-planned')!.checkins as CheckInRecord[]).at(-1)!
  assert.equal(last.verdict, 'degraded')
  assert.ok(last.blockers.includes('criteria_unsatisfied:c1'))
})

test('P1 degraded_visible mode keeps proof-bearing degraded runs done but still records the degraded reason', async () => {
  const previous = process.env.READY_ADJUDICATION_ENFORCE_MODE
  process.env.READY_ADJUDICATION_ENFORCE_MODE = 'degraded_visible'
  try {
    const store = fakeStore({
      taskId: 'task-degraded-visible', taskType: 'research' as never, module: 'system',
      proofRefs: [
        collectToolResultProof('web_search', 'sources found', NOW),
        collectArtifactProof('/tmp/research.md', NOW),
      ],
    })
    const finalized = await finalizeRunOutcome({
      kind: 'done', runId: 'run-degraded-visible', taskId: 'task-degraded-visible', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 1, initiator: 'done', finalText: '研究完成',
      projectionPatch: { taskType: 'research', module: 'system' },
    } as RunOutcome, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const last = (store.rows.get('task-degraded-visible')!.checkins as CheckInRecord[]).at(-1)!
    assert.equal(last.verdict, 'degraded')
    assert.ok(last.blockers.includes('criteria_unsatisfied:c2'))
    assert.equal(last.satisfiedCount, 1)
    assert.equal(last.totalCount, 2)
    assert.equal(finalized.status, 'done')
    assert.equal(finalized.terminalReason, 'adjudication_degraded')
  } finally {
    if (previous === undefined) delete process.env.READY_ADJUDICATION_ENFORCE_MODE
    else process.env.READY_ADJUDICATION_ENFORCE_MODE = previous
  }
})

test('browser research essential-output floor cannot be turned into green completion by degraded-visible policy', async () => {
  const previous = process.env.READY_ADJUDICATION_ENFORCE_MODE
  process.env.READY_ADJUDICATION_ENFORCE_MODE = 'degraded_visible'
  try {
    const store = fakeStore({
      taskId: 'task-browser-research-empty',
      taskType: 'research' as never,
      module: 'browser',
      proofRefs: [collectToolResultProof('browser_task', 'query failed: invalid_arguments', NOW)],
    })
    const finalized = await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-browser-research-empty',
      taskId: 'task-browser-research-empty',
      scopeId: 's1',
      durationMs: 10,
      toolCallsUsed: 2,
      initiator: 'done',
      finalText: '尝试过研究，但没有拿到任何关键词结果。',
      projectionPatch: {
        taskType: 'research',
        module: 'browser',
        browserResearchEssentialOutputSatisfied: false,
        terminalFailureReason: 'proof_gap',
      },
    }, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    assert.equal(finalized.status, 'error')
    assert.equal(finalized.terminalReason, 'proof_gap')
  } finally {
    if (previous === undefined) delete process.env.READY_ADJUDICATION_ENFORCE_MODE
    else process.env.READY_ADJUDICATION_ENFORCE_MODE = previous
  }
})

test('P1 degraded_visible mode cannot complete a multi-step run with zero satisfied criteria', async () => {
  const previous = process.env.READY_ADJUDICATION_ENFORCE_MODE
  process.env.READY_ADJUDICATION_ENFORCE_MODE = 'degraded_visible'
  try {
    const store = fakeStore({
      taskId: 'task-tag-forge-no-write',
      taskType: 'multi_step_task' as never,
      module: 'system',
      proofRefs: [
        collectToolResultProof('tag_forge_prepare_batch', 'Unknown system tool: tag_forge_prepare_batch', NOW),
        collectToolResultProof('file_inventory', '{"ok":true,"total":31}', NOW),
      ],
    })
    const finalized = await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-tag-forge-no-write',
      taskId: 'task-tag-forge-no-write',
      scopeId: 's1',
      durationMs: 10,
      toolCallsUsed: 2,
      initiator: 'done',
      finalText: '工具不可用，因此没有写入任何文档。',
      projectionPatch: { taskType: 'multi_step_task', module: 'system' },
    } as RunOutcome, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })

    const last = (store.rows.get('task-tag-forge-no-write')!.checkins as CheckInRecord[]).at(-1)!
    assert.equal(last.verdict, 'degraded')
    assert.equal(last.satisfiedCount, 0)
    assert.equal(last.totalCount, 2)
    assert.equal(finalized.status, 'error')
    assert.equal(finalized.terminalReason, 'adjudication_degraded')
  } finally {
    if (previous === undefined) delete process.env.READY_ADJUDICATION_ENFORCE_MODE
    else process.env.READY_ADJUDICATION_ENFORCE_MODE = previous
  }
})

test('P1 degraded_visible mode still hard-fails zero-proof rejects', async () => {
  const previous = process.env.READY_ADJUDICATION_ENFORCE_MODE
  process.env.READY_ADJUDICATION_ENFORCE_MODE = 'degraded_visible'
  try {
    const store = fakeStore({ taskId: 'task-zero-visible', taskType: 'short_task' as never, proofRefs: [] })
    const finalized = await finalizeRunOutcome({
      kind: 'done', runId: 'run-zero-visible', taskId: 'task-zero-visible', scopeId: 's1',
      durationMs: 10, toolCallsUsed: 0, initiator: 'done', finalText: '',
      projectionPatch: { taskType: 'short_task', module: 'system' },
    } as RunOutcome, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    const last = (store.rows.get('task-zero-visible')!.checkins as CheckInRecord[]).at(-1)!
    assert.equal(last.verdict, 'reject')
    assert.ok(last.blockers.includes('zero_proof_done'))
    assert.equal(finalized.status, 'error')
    assert.equal(finalized.terminalReason, 'proof_gap')
  } finally {
    if (previous === undefined) delete process.env.READY_ADJUDICATION_ENFORCE_MODE
    else process.env.READY_ADJUDICATION_ENFORCE_MODE = previous
  }
})

test('failed delivery facts produce a specific terminal reason, never accept or adjudication_degraded', async () => {
  const store = fakeStore({
    taskId: 'task-delivery-failed',
    taskType: 'short_task' as never,
    module: 'skill',
    proofRefs: [],
  })
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-delivery-failed',
    taskId: 'task-delivery-failed',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '微信发送失败。',
    projectionPatch: {
      taskType: 'short_task',
      module: 'skill',
      skillExecutionForm: 'direct',
      terminalFailureReason: 'delivery_failed',
      terminalFailureTool: 'skill_send_im_file',
    },
  }, {
    writeRunCloseMetric: () => {},
    taskProjectionStore: store,
    now: () => NOW,
  })

  const checkins = store.rows.get('task-delivery-failed')!.checkins as CheckInRecord[]
  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'delivery_failed')
  assert.equal(checkins[0].kind, 'enforce')
  assert.notEqual(checkins[0].verdict, 'accept')
  assert.notEqual(finalized.terminalReason, 'adjudication_degraded')
})

test('action tasks with structurally missing proof become proof_gap, not accept or adjudication_degraded', async () => {
  const store = fakeStore({
    taskId: 'task-proof-gap',
    taskType: 'short_task' as never,
    module: 'system',
    proofRefs: [],
  })
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-proof-gap',
    taskId: 'task-proof-gap',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '',
    projectionPatch: {
      taskType: 'short_task',
      module: 'system',
    },
  }, {
    writeRunCloseMetric: () => {},
    taskProjectionStore: store,
    now: () => NOW,
  })

  const checkins = store.rows.get('task-proof-gap')!.checkins as CheckInRecord[]
  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'proof_gap')
  assert.equal(checkins[0].kind, 'enforce')
  assert.notEqual(checkins[0].verdict, 'accept')
  assert.notEqual(finalized.terminalReason, 'adjudication_degraded')
})

test('zero-proof done with valid paused continuation becomes checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-finalizer-paused-'))
  const runStatePath = join(dir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify({ resumeKind: 'paused' }), 'utf8')
  try {
    const store = fakeStore({ taskId: 'task-paused', taskType: 'short_task' as never, proofRefs: [] })
    const finalized = await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-paused',
      taskId: 'task-paused',
      scopeId: 's1',
      durationMs: 10,
      toolCallsUsed: 0,
      initiator: 'done',
      projectionPatch: {
        taskContinuation: {
          taskId: 'task-paused',
          resumeKind: 'paused',
          outputDir: dir,
          runStatePath,
        },
      },
    }, {
      writeRunCloseMetric: () => {},
      taskProjectionStore: store,
      now: () => NOW,
    })
    assert.equal(finalized.status, 'checkpoint')
    assert.equal(finalized.terminalReason, 'checkpoint_budget')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('direct skill done does not require skill_run_state but still needs tool proof', async () => {
  const store = fakeStore({
    taskId: 'task-direct-skill',
    taskType: 'short_task' as never,
    module: 'skill',
    proofRefs: [collectToolResultProof('skill_send_im_file', 'ok', NOW)],
  })
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-direct-skill',
    taskId: 'task-direct-skill',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    projectionPatch: {
      module: 'skill',
      taskType: 'short_task',
      skillExecutionForm: 'direct',
    },
  }, {
    writeRunCloseMetric: () => {},
    taskProjectionStore: store,
    now: () => NOW,
  })

  const checkins = store.rows.get('task-direct-skill')!.checkins as CheckInRecord[]
  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
  assert.equal(checkins[0].verdict, 'accept')
  assert.equal(checkins[0].satisfiedCount, 1)
  assert.equal(checkins[0].totalCount, 1)
  assert.equal(checkins[0].blockers.includes('criteria_unsatisfied:s1'), false)
})

test('child-loop skill still requires skill_run_state proof', async () => {
  const store = fakeStore({
    taskId: 'task-child-skill',
    taskType: 'short_task' as never,
    module: 'skill',
    proofRefs: [collectToolResultProof('skill_video_expert_pipeline', 'ok', NOW)],
  })
  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-child-skill',
    taskId: 'task-child-skill',
    scopeId: 's1',
    durationMs: 10,
    toolCallsUsed: 1,
    initiator: 'done',
    projectionPatch: {
      module: 'skill',
      taskType: 'short_task',
      skillExecutionForm: 'child_loop',
    },
  }, {
    writeRunCloseMetric: () => {},
    taskProjectionStore: store,
    now: () => NOW,
  })

  const checkins = store.rows.get('task-child-skill')!.checkins as CheckInRecord[]
  assert.equal(finalized.status, 'error')
  // had a tool_result proof but s1 unsatisfied → adjudication_degraded (proofCount>0)
  assert.equal(finalized.terminalReason, 'adjudication_degraded')
  assert.equal(checkins[0].verdict, 'degraded')
  assert.ok(checkins[0].blockers.includes('criteria_unsatisfied:s1'))
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
      { at: '2026-06-12T10:00:00.000Z', metric: 'run_close', runId: 'r1', taskType: 'direct_answer' },
      { at: '2026-06-12T10:01:00.000Z', metric: 'adjudicator_shadow_divergence', runId: 'r1', taskId: 't1', taskType: 'short_task', verdict: 'reject', actualStatus: 'done', proofCount: 0 },
      { at: '2026-06-10T10:00:00.000Z', metric: 'adjudicator_shadow_divergence', runId: 'r0', taskType: 'research', verdict: 'reject' }, // before --since
      'not json at all',
      { at: '2026-06-12T11:00:00.000Z', metric: 'run_close', runId: 'r2', taskType: 'research' },
    ]
    writeFileSync(log, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'), 'utf-8')
    const output = execFileSync('node', ['scripts/export-adjudicator-divergence.cjs', '--since', '2026-06-12T00:00:00.000Z', '--file', log], { encoding: 'utf-8' })
    const report = JSON.parse(output)
    assert.equal(report.count, 1)
    assert.equal(report.totalTerminalRuns, 2)
    // P0-4: coverage comes from run_close rows (the real sample), NOT from
    // divergence rows — divergence types are reported separately
    assert.deepEqual(report.taskTypes, { direct_answer: 1, research: 1 })
    assert.deepEqual(report.divergenceTaskTypes, { short_task: 1 })
    assert.equal(report.rows[0].disposition, null, 'disposition column ready for the Q4b review')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('both funnel gates stay green', () => {
  execFileSync('node', ['scripts/check-run-finalize-funnel.cjs'], { encoding: 'utf-8' })
  execFileSync('node', ['scripts/check-checkin-funnel.cjs'], { encoding: 'utf-8' })
})

// ---------- Codex P0-3/P0-4: effective task facts + close-metric taskType ----------

