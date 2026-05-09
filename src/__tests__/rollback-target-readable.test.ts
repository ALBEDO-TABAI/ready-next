/**
 * Stage T (W9.2) — `rollback_target` reaches the renderer surface.
 *
 * Two checks:
 *   1. The reader helper `readChildRunRollbackTarget` returns the cancel
 *      close event's `rollback_target` (string | null) and `undefined`
 *      when the run never cancelled.
 *   2. `buildTaskCardViewModel` propagates the `rollback_target` field
 *      from `TaskCardRunLike` (the renderer-facing projection shape) to
 *      the produced `TaskCardViewModel` so a TaskCard component can
 *      surface the diagnostic label without recomputing it.
 *
 * Diagnostic-only contract — no UI action binds to this field; that
 * stays enforced by `check-no-auto-rollback-on-cancel.cjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  appendChildRunEvent,
  deriveChildRunLogPath,
  readChildRunRollbackTarget,
} from '../main/modules/agent-control/skill-child-run-log'
import { createSkillChildRunId } from '../main/modules/agent-control/skill-child-run-id'
import type { SkillChildRunEvent } from '../main/modules/agent-control/skill-child-run-types'
import {
  buildTaskCardViewModel,
  createDefaultTaskDisclosureState,
  type TaskCardRunLike,
} from '../renderer/modules/agent/taskCardViewModel'

async function makeTempOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ready-rollback-readable-'))
}

function makeRun(overrides: Partial<TaskCardRunLike> = {}): TaskCardRunLike {
  return {
    scopeId: 'scope-rb',
    taskId: 'task-rb',
    phase: 'cancelled',
    status: 'cancelled',
    title: '取消的任务',
    taskTitle: '取消的任务',
    taskSummary: '已取消',
    waitingFor: 'none',
    resumableActions: [],
    steps: [],
    recentArtifacts: [],
    memoryCapture: null,
    progress: null,
    updatedAt: '2026-05-09T10:00:00.000Z',
    ...overrides,
  }
}

test('readChildRunRollbackTarget returns null on cancel-without-safe-step', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const cancelClose: SkillChildRunEvent = {
    type: 'close',
    at: new Date().toISOString(),
    event_kind: 'cancelled',
    terminal_reason: 'cancelled_user',
    rollback_target: null,
    close: {
      childRunId,
      skillId: 'video-expert-analyzer',
      status: 'killed',
      terminalReason: 'cancelled_user',
      outputDir,
      runStatePath: path.join(outputDir, 'run_state.json'),
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {
        stage: null,
        totalUnits: null,
        completedUnits: null,
        coverageRatio: null,
        fingerprint: null,
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
    },
  }
  await appendChildRunEvent({ logPath, event: cancelClose })

  const got = await readChildRunRollbackTarget(logPath)
  assert.equal(got, null)
})

test('readChildRunRollbackTarget returns the safe step id when present', async () => {
  const outputDir = await makeTempOutputDir()
  const childRunId = createSkillChildRunId('vea')
  const logPath = deriveChildRunLogPath(outputDir, childRunId)

  const cancelClose: SkillChildRunEvent = {
    type: 'close',
    at: new Date().toISOString(),
    event_kind: 'cancelled',
    terminal_reason: 'cancelled_user',
    rollback_target: 'video_expert_pipeline',
    close: {
      childRunId,
      skillId: 'video-expert-analyzer',
      status: 'killed',
      terminalReason: 'cancelled_user',
      outputDir,
      runStatePath: path.join(outputDir, 'run_state.json'),
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {
        stage: 'video_expert_pipeline',
        totalUnits: null,
        completedUnits: null,
        coverageRatio: null,
        fingerprint: null,
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
    },
  }
  await appendChildRunEvent({ logPath, event: cancelClose })

  const got = await readChildRunRollbackTarget(logPath)
  assert.equal(got, 'video_expert_pipeline')
})

test('buildTaskCardViewModel propagates rollback_target to view-model', () => {
  const run = makeRun({ rollback_target: 'video_expert_pipeline' })
  const vm = buildTaskCardViewModel(run, createDefaultTaskDisclosureState(run))
  assert.equal(vm.rollback_target, 'video_expert_pipeline')
})

test('buildTaskCardViewModel preserves rollback_target=null distinct from undefined', () => {
  const cancelledNoSafe = makeRun({ rollback_target: null })
  const vmCancelled = buildTaskCardViewModel(
    cancelledNoSafe,
    createDefaultTaskDisclosureState(cancelledNoSafe),
  )
  assert.equal(
    vmCancelled.rollback_target,
    null,
    'cancelled-without-safe-step renders as null',
  )

  const neverCancelled = makeRun({ rollback_target: undefined, phase: 'tool_running' })
  const vmNever = buildTaskCardViewModel(
    neverCancelled,
    createDefaultTaskDisclosureState(neverCancelled),
  )
  assert.equal(
    vmNever.rollback_target,
    undefined,
    'never-cancelled run keeps rollback_target undefined',
  )
})
