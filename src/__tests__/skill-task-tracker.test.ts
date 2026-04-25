import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearSkillTaskProjection,
  recordSkillTaskEvent,
  readSkillTaskProjection,
} from '../main/modules/agent-control/skill-task-tracker'

test('SkillTaskTracker records primitive steps and recent artifacts for task cards', () => {
  clearSkillTaskProjection('scope-skill-1')

  recordSkillTaskEvent({
    sessionId: 'scope-skill-1',
    skillId: 'novel_writer_system',
    skillName: 'Novel Writer System',
    toolName: 'skill_run_shell',
    status: 'done',
  })
  recordSkillTaskEvent({
    sessionId: 'scope-skill-1',
    skillId: 'novel_writer_system',
    skillName: 'Novel Writer System',
    toolName: 'skill_write_artifact',
    status: 'done',
    artifactPath: '/tmp/ready-skill-output/report.md',
    artifactLabel: 'report.md',
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-1',
    skillId: 'novel_writer_system',
  })

  assert.equal(projection?.module, 'skill')
  assert.equal(projection?.taskTitle, '技能执行 · Novel Writer System')
  assert.equal(projection?.steps?.length, 2)
  assert.equal(projection?.steps?.[0]?.status, 'done')
  assert.equal(projection?.currentStepId, 'skill_write_artifact')
  assert.equal(projection?.waitingFor, 'none')
  assert.equal(projection?.recentArtifacts?.[0]?.label, 'report.md')
})

test('SkillTaskTracker exposes ask_user as an input wait state', () => {
  clearSkillTaskProjection('scope-skill-2')

  recordSkillTaskEvent({
    sessionId: 'scope-skill-2',
    skillId: 'novel_writer_system',
    skillName: 'Novel Writer System',
    toolName: 'skill_ask_user',
    status: 'blocked',
    message: '需要确认章节范围',
  })

  const projection = readSkillTaskProjection({
    sessionId: 'scope-skill-2',
    skillId: 'novel_writer_system',
  })

  assert.equal(projection?.waitingFor, 'input')
  assert.equal(projection?.blockedReason, '需要确认章节范围')
  assert.equal(projection?.resumableActions?.includes('continue'), true)
  assert.equal(projection?.taskContinuation?.blockerType, 'need_input')
})
