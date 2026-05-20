/**
 * Regression — the tool snapshot for the first turn of a skill-invocation
 * turn must see the reference-skill hint registered. Before this fix the
 * ordering in `turn-engine.ts` was:
 *   1. detect explicit skill
 *   2. prepareInitialRun → filterSkillPrimitivesBySession(sessionId, …)
 *   3. maybeInjectExplicitSkillContext → rememberLastReferenceSkill
 *
 * Step 2 saw an empty hint store, so `skill_run_shell` /
 * `skill_ask_user` / `skill_write_artifact` / `skill_read_artifact` were
 * stripped from the allowed-tool list. The model reported "当前上下文
 * 没有 skill_run_shell 工具" and gave up on the skill even though the
 * SKILL.md was inlined later in the same turn.
 *
 * The current route registers the reference hint from explicit user text
 * before preferred tools are resolved, so primitive tools remain available
 * in the same turn.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'

function makeReferenceSkill(id: string, name: string): any {
  return {
    id,
    name,
    description: '',
    defaultAction: 'read_skill',
    executionMode: 'direct',
    managedPath: null,
    actions: [
      { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
    ],
  }
}

test('rememberExplicitReferenceSkillHint registers hints for explicit reference-runtime skills', () => {
  _resetLastReferenceSkillHintsForTests()
  const skill = makeReferenceSkill('video-expert-analyzer', 'Video Expert Analyzer (VNext)')
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skill],
    resolveSkillToolByAction: () => null,
  })
  assert.equal(orch.rememberExplicitReferenceSkillHint('@[Video Expert Analyzer (VNext)] 分析一下', 'session-A'), true)
  assert.equal(getLastReferenceSkill('session-A')?.id, 'video-expert-analyzer')
})

test('rememberExplicitReferenceSkillHint ignores non-reference actions', () => {
  _resetLastReferenceSkillHintsForTests()
  const pythonOnlySkill: any = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer',
    description: '',
    defaultAction: 'run_pipeline',
    executionMode: 'direct',
    managedPath: null,
    actions: [
      { name: 'run_pipeline', visibility: 'public', runtime: 'python', params: [] },
    ],
  }
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [pythonOnlySkill],
    resolveSkillToolByAction: () => null,
  })
  assert.equal(orch.rememberExplicitReferenceSkillHint('@[Video Expert Analyzer] 分析一下', 'session-B'), false)
  assert.equal(getLastReferenceSkill('session-B'), null, 'non-reference defaultAction must not register')
})

test('rememberExplicitReferenceSkillHint is a no-op without sessionId (boot/static callers)', () => {
  _resetLastReferenceSkillHintsForTests()
  const skill = makeReferenceSkill('s', 'Skill Alias')
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skill],
    resolveSkillToolByAction: () => null,
  })
  // Must not throw
  assert.equal(orch.rememberExplicitReferenceSkillHint('@[Skill Alias]', undefined), false)
})

test('armed explicit reference hint keeps primitives in the preferred tool list', () => {
  _resetLastReferenceSkillHintsForTests()
  const skill = makeReferenceSkill('video-expert-analyzer', 'Video Expert Analyzer (VNext)')
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skill],
    resolveSkillToolByAction: () => null,
  })
  orch.rememberExplicitReferenceSkillHint('@[Video Expert Analyzer (VNext)] 分析一下', 'session-C')
  const tools = orch.buildPreferredSkillToolNames('继续', 'session-C')
  assert.ok(tools.includes('skill_run_shell'))
  assert.ok(tools.includes('skill_ask_user'))
})
