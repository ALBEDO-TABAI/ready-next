import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeSkillTool,
  shouldRememberPrimitiveOutcomeForContinuity,
} from '../main/modules/tools/skills-tools'
import {
  registerSkillTaskRunRepository,
} from '../main/modules/agent-control/skill-task-tracker'
import type { SkillTaskRunRecord, SkillTaskRunRepository } from '../main/modules/repositories/skill-task-run-repository'

function makeRepositoryWithActiveRun(): SkillTaskRunRepository {
  const activeRun: SkillTaskRunRecord = {
    id: 'str-active-vea',
    scopeId: 'session-active-vea',
    sessionId: 'session-active-vea',
    agent: 'butler',
    runId: 'run-test',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    action: 'video_expert_pipeline',
    toolName: 'skill_video_expert_pipeline',
    runKind: 'typed_action',
    status: 'blocked',
    interactionState: 'suspended',
    goalText: null,
    resourceRefs: [],
    params: null,
    steps: [],
    currentStepId: null,
    artifacts: [],
    outputDir: '/tmp/vea-output',
    runStatePath: '/tmp/vea-output/run_state.json',
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: 'tool_error',
    failureDetail: 'provider config mismatch',
    jobId: null,
    detachedTaskId: 'dst-active-vea',
    resumePayload: { taskRunId: 'str-active-vea', outputDir: '/tmp/vea-output' },
    createdAt: '2026-04-28T00:00:00.000Z',
    startedAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
    finishedAt: null,
  }
  return {
    create: () => {},
    update: () => {},
    get: (id: string) => (id === activeRun.id ? activeRun : null),
    findByDetachedTaskId: (id: string) => (id === activeRun.detachedTaskId ? activeRun : null),
    findLatestRecoverable: () => activeRun,
    listActiveBySession: (sessionId: string) => sessionId === activeRun.sessionId ? [activeRun] : [],
  } as unknown as SkillTaskRunRepository
}

test('monitor-only primitive success without durable handle is not remembered as skill completion', () => {
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: false,
  }), false)
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_inspect_run_state',
    status: 'done',
    hasDurableHandle: false,
  }), false)
})

test('primitive blocked/error or durable handles remain resumable continuity', () => {
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'blocked',
    hasDurableHandle: false,
  }), true)
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: true,
  }), true)
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'done',
    hasDurableHandle: false,
  }), true)
})

test('primitive dispatch accepts active blocked skill task context without a reference hint', async () => {
  registerSkillTaskRunRepository(makeRepositoryWithActiveRun())
  try {
    const result = await executeSkillTool(
      'skill_start_detached',
      { action: 'missing_action_for_test' },
      'session-active-vea',
    )
    const text = typeof result === 'string' ? result : result.text
    assert.doesNotMatch(text, /no active skill execution or reference-skill hint/)
  } finally {
    registerSkillTaskRunRepository(null)
  }
})
