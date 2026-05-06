/**
 * Stage N (Phase 3) — predicate coverage for the budget-warning fence.
 *
 * Scope: this file covers the **pure helpers** that the runtime fence inside
 * `turn-engine.ts:consumeExecutedToolBatch` uses to decide whether to set
 * `lastLongTypedSkillActionIteration`:
 *
 *   STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName] -> { skillId, actionName }
 *   isConfiguredChildLoopSkillAction(skillId, actionName)
 *
 * The runtime fence itself (the `if (!isChildLoopExecution)` guard around
 * `lastLongTypedSkillActionIteration = iterations`) is exercised end-to-end
 * by the existing `turn-engine-route.test.ts` and the VEA resume probe —
 * both go through real `consumeExecutedToolBatch` with VEA tool names and
 * assert downstream behavior (no parent force, manifest-fence metric,
 * checkpoint terminal). This file pins the predicate layer so a refactor
 * that changes how child-loop actions are recognized fails here first
 * before it can ripple into the engine fence.
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
