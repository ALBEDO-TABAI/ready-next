/**
 * Stage N (Phase 3) — `lastLongTypedSkillActionIteration` fence for child-loop.
 *
 * The marker is set inside `consumeExecutedToolBatch` at turn-engine.ts:3937
 * when an executed tool's name passes `isLongTypedSkillActionName`. Setting
 * the marker tells the next iteration's budget-warning helper
 * (`shouldInjectBudgetWarning`) to suppress the "summarize progress" nudge,
 * because a long-skill action just completed and the model needs a clear
 * channel to report.
 *
 * Stage N inverts this for child-loop typed actions: their typed-action
 * "result" is a `child_launched` envelope, not a real long-action
 * completion. Treating them as completed silences a legitimate budget
 * warning that should fire during a child run.
 *
 * The fence runs inside the same conditional, gated by:
 *   STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName] -> { skillId, actionName }
 *   isConfiguredChildLoopSkillAction(skillId, actionName)
 *
 * Both helpers are pure; we test the gate decision via a unit-level proxy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../main/modules/tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../main/modules/tools/child-loop-skill-actions'

function isChildLoopExecution(toolName: string): boolean {
  const entry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
  if (!entry) return false
  return isConfiguredChildLoopSkillAction(entry.skillId, entry.actionName)
}

test('VEA typed actions are recognized as child-loop executions (fence ON)', () => {
  assert.equal(isChildLoopExecution('skill_video_expert_pipeline'), true)
  assert.equal(isChildLoopExecution('skill_video_expert_ai_analyze'), true)
})

test('lets-go-rss typed actions are NOT child-loop executions (fence OFF)', () => {
  // lets-go-rss has no `child_loop` declaration; its long-skill markers stay
  // on the legacy budget-warning suppression path.
  assert.equal(isChildLoopExecution('skill_rss_update'), false)
  assert.equal(isChildLoopExecution('skill_rss_status'), false)
  assert.equal(isChildLoopExecution('skill_rss_add'), false)
})

test('non-skill / unmapped tool names are NOT child-loop executions', () => {
  // Tools outside the static skill registry never trip the fence.
  assert.equal(isChildLoopExecution('memory_search'), false)
  assert.equal(isChildLoopExecution('file_search'), false)
  assert.equal(isChildLoopExecution('skill_inspect_run_state'), false)
  assert.equal(isChildLoopExecution(''), false)
})
