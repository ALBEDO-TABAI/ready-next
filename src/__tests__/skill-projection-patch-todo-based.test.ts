/**
 * B Phase 4 PR1 — `buildSkillTaskProjectionPatch` shape contract.
 *
 * Locks the 14-field projection-patch shape that `ChatPanel.tsx` /
 * `TaskPanel.tsx` / `taskCardViewModel.ts` consume, sourced from the
 * tracker-driven replacement for the retired `skill_executions` state
 * machine. The patch shape is identical to the legacy
 * `buildSkillProjectionPatch` output plus the `taskContinuation.todoId` /
 * `todoTitle` fields (B Phase 4 D1).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SkillTaskTracker,
  _resetSkillTaskTrackerForTests,
  getSkillTaskTracker,
} from '../main/modules/agent-control/skill-task-tracker'

import { buildSkillTaskProjectionPatch } from '../main/modules/tools/skills-tools'

interface PatchTaskContinuation {
  executionId: string
  stepId: string | null
  blockerType: string | null
  todoId?: string
  todoTitle?: string
}

interface PatchShape {
  module: string
  message: string
  taskTitle: string
  taskSummary: string
  taskType: string
  interactionState: string
  steps: Array<{ id: string; title: string; status: string; updatedAt: string }>
  currentStepId: string
  waitingFor: 'none' | 'clarification' | 'input' | 'confirmation' | 'agent_result' | 'background'
  resumableActions: Array<'continue' | 'retry' | 'open_artifact' | 'cancel'>
  blockedReason: string | null
  taskContinuation: PatchTaskContinuation
  recentArtifacts: Array<Record<string, unknown>>
}

function patch(sessionId: string, skillId: string): PatchShape | null {
  const raw = buildSkillTaskProjectionPatch(sessionId, skillId)
  return raw as PatchShape | null
}

function resetAndSeed(
  seed: (tracker: SkillTaskTracker) => void,
): { sessionId: string; skillId: string } {
  _resetSkillTaskTrackerForTests()
  const sessionId = 'sess-1'
  const skillId = 'video-copy-analyzer'
  seed(getSkillTaskTracker())
  return { sessionId, skillId }
}

test('returns null when tracker has no todos for the given session+skill', () => {
  _resetSkillTaskTrackerForTests()
  assert.equal(buildSkillTaskProjectionPatch('no-session', 'video-copy-analyzer'), null)
})

test('single running run_shell todo → interactionState=running, cancel-only resumableActions', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: '运行命令: python3 scripts/analyze.py',
      origin: 'run_shell',
    })
  })
  const p = patch(sessionId, skillId)
  assert.ok(p, 'patch should not be null')
  assert.equal(p.module, 'skill')
  assert.equal(p.taskType, 'multi_step_task')
  assert.equal(p.interactionState, 'running')
  assert.equal(p.waitingFor, 'none')
  assert.deepEqual(p.resumableActions, ['cancel'])
  assert.equal(p.steps.length, 1)
  assert.equal(p.steps[0].status, 'running')
  assert.equal(p.currentStepId, p.steps[0].id)
  assert.equal(p.blockedReason, null)
  assert.equal(p.taskContinuation.executionId, '')
  assert.equal(p.taskContinuation.todoId, p.steps[0].id)
  assert.equal(p.taskContinuation.todoTitle, '运行命令: python3 scripts/analyze.py')
  assert.equal(p.recentArtifacts.length, 0)
})

test('done todo with artifactPath → retry + open_artifact + cancel, recentArtifacts populated', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    const id = tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: '运行命令: python3 scripts/analyze.py',
      origin: 'run_shell',
    })
    tracker.markDone(id, '/abs/output/result.json')
  })
  const p = patch(sessionId, skillId)
  assert.ok(p)
  assert.equal(p.interactionState, 'completed')
  assert.equal(p.waitingFor, 'none')
  // `done` → retry; artifactPath present → open_artifact
  assert.ok(p.resumableActions.includes('retry'))
  assert.ok(p.resumableActions.includes('open_artifact'))
  assert.ok(p.resumableActions.includes('cancel'))
  assert.equal(p.resumableActions.includes('continue'), false, 'no blocked todo → no continue')
  assert.equal(p.recentArtifacts.length, 1)
  assert.equal((p.recentArtifacts[0] as { path: string | null }).path, '/abs/output/result.json')
  assert.equal((p.recentArtifacts[0] as { kind: string }).kind, 'skill-artifact')
  // todoId anchors to the done todo
  assert.equal(p.taskContinuation.todoId, p.steps[0].id)
})

test('blocked ask_user todo → waitingFor=clarification, continue+cancel, interactionState=awaiting_clarification', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: '等待用户回答: 请确认采用此帧',
      origin: 'ask_user',
      status: 'blocked',
    })
  })
  const p = patch(sessionId, skillId)
  assert.ok(p)
  assert.equal(p.waitingFor, 'clarification')
  assert.equal(p.interactionState, 'awaiting_clarification')
  assert.ok(p.resumableActions.includes('continue'), 'blocked todo → continue allowed')
  assert.ok(p.resumableActions.includes('cancel'))
  assert.equal(p.resumableActions.includes('retry'), false, 'no done todo → no retry')
  assert.equal(p.taskContinuation.blockerType, 'need_input')
})

test('blocked run_shell todo (non-zero exit) → waitingFor=none (not a user-driven block)', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    const id = tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: '运行命令: python3 scripts/fail.py',
      origin: 'run_shell',
    })
    tracker.markBlocked(id, 'exit code 2')
  })
  const p = patch(sessionId, skillId)
  assert.ok(p)
  // run_shell blocked is a failure, not a user-clarification request
  assert.equal(p.waitingFor, 'none')
  assert.equal(p.interactionState, 'awaiting_clarification')
  assert.ok(p.resumableActions.includes('continue'))
  assert.equal(p.blockedReason, 'exit code 2')
})

test('mixed todos (done + blocked ask_user) → continue + retry + cancel, anchor=latest blocked', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    const firstId = tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: '运行命令: python3 scripts/first.py',
      origin: 'run_shell',
    })
    tracker.markDone(firstId, '/abs/output/first.json')
    tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: '等待用户回答: 请确认',
      origin: 'ask_user',
      status: 'blocked',
    })
  })
  const p = patch(sessionId, skillId)
  assert.ok(p)
  assert.equal(p.steps.length, 2)
  assert.equal(p.waitingFor, 'clarification')
  assert.ok(p.resumableActions.includes('continue'))
  assert.ok(p.resumableActions.includes('retry'))
  assert.ok(p.resumableActions.includes('open_artifact'))
  assert.ok(p.resumableActions.includes('cancel'))
  // anchor prefers blocked (ask_user pending) over done
  assert.equal(p.taskContinuation.todoTitle, '等待用户回答: 请确认')
})

test('patch filters todos by skillId — other skill todos in same session do not leak', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'video-copy-analyzer',
      title: 'A',
      origin: 'run_shell',
    })
    tracker.startTodo({
      sessionId: 'sess-1',
      skillId: 'other-skill',
      title: 'B',
      origin: 'write_artifact',
    })
  })
  const p = patch(sessionId, skillId)
  assert.ok(p)
  assert.equal(p.steps.length, 1)
  assert.equal(p.steps[0].title, 'A')
})

test('recentArtifacts is capped at 4 (last 4 done todos with artifactPath)', () => {
  const { sessionId, skillId } = resetAndSeed((tracker) => {
    for (let i = 0; i < 6; i += 1) {
      const id = tracker.startTodo({
        sessionId: 'sess-1',
        skillId: 'video-copy-analyzer',
        title: `out-${i}`,
        origin: 'write_artifact',
      })
      tracker.markDone(id, `/abs/output/${i}.json`)
    }
  })
  const p = patch(sessionId, skillId)
  assert.ok(p)
  assert.equal(p.recentArtifacts.length, 4)
  // The last 4 should be the tail (i=2..5 since slice(-4))
  const paths = p.recentArtifacts.map((a) => (a as { path: string }).path)
  assert.deepEqual(paths, ['/abs/output/2.json', '/abs/output/3.json', '/abs/output/4.json', '/abs/output/5.json'])
})
