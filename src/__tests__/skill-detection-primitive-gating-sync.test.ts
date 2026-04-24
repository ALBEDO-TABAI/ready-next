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
 * The fix adds `rememberDetectedReferenceSkills` on the orchestrator and
 * wires it between detection and prepareInitialRun. This test pins the
 * orchestrator method's contract; a source-level pin in turn-engine.ts
 * guards the call site ordering.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skill-reference-hints'

function makeReferenceSkill(id: string, name: string): any {
  return {
    id,
    name,
    description: '',
    defaultAction: 'read_skill',
    executionMode: 'advisory',
    managedPath: null,
    actions: [
      { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
    ],
  }
}

test('rememberDetectedReferenceSkills registers hints for reference-runtime skills', () => {
  _resetLastReferenceSkillHintsForTests()
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [],
    resolveSkillToolByAction: () => null,
  })
  orch.rememberDetectedReferenceSkills('session-A', [
    makeReferenceSkill('video-expert-analyzer', 'Video Expert Analyzer (VNext)'),
  ])
  assert.equal(getLastReferenceSkill('session-A')?.id, 'video-expert-analyzer')
})

test('rememberDetectedReferenceSkills ignores non-reference actions', () => {
  _resetLastReferenceSkillHintsForTests()
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [],
    resolveSkillToolByAction: () => null,
  })
  const pythonOnlySkill: any = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer',
    description: '',
    defaultAction: 'run_pipeline',
    executionMode: 'advisory',
    managedPath: null,
    actions: [
      { name: 'run_pipeline', visibility: 'public', runtime: 'python', params: [] },
    ],
  }
  orch.rememberDetectedReferenceSkills('session-B', [pythonOnlySkill])
  assert.equal(getLastReferenceSkill('session-B'), null, 'non-reference defaultAction must not register')
})

test('rememberDetectedReferenceSkills is a no-op without sessionId (boot/static callers)', () => {
  _resetLastReferenceSkillHintsForTests()
  const orch = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [],
    resolveSkillToolByAction: () => null,
  })
  // Must not throw
  orch.rememberDetectedReferenceSkills(undefined, [makeReferenceSkill('s', 'S')])
})

test('turn-engine registers the hint between skill detection and prepareInitialRun', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'),
    'utf8',
  )
  const rememberIdx = src.indexOf('rememberDetectedReferenceSkills(')
  const prepareIdx = src.indexOf('prepareInitialRun({')
  const detectionIdx = src.indexOf('[skill_detection]')
  assert.notEqual(rememberIdx, -1, 'turn-engine must call rememberDetectedReferenceSkills')
  assert.notEqual(prepareIdx, -1, 'turn-engine must call prepareInitialRun')
  assert.notEqual(detectionIdx, -1, 'turn-engine must emit the skill_detection log line')
  assert.ok(
    detectionIdx < rememberIdx,
    'rememberDetectedReferenceSkills must run AFTER skill detection',
  )
  assert.ok(
    rememberIdx < prepareIdx || src.indexOf('prepareInitialRun({', rememberIdx) > rememberIdx,
    'rememberDetectedReferenceSkills must run BEFORE prepareInitialRun builds the tool snapshot',
  )
})
