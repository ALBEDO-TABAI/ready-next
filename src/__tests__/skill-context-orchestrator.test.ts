/**
 * Orchestrator contract. B Phase 4 PR2 drops:
 *   - `listExecutions` dep (state machine retired)
 *   - `executeTool` dep from the constructor (it is passed per-call into
 *     `maybeInjectExplicitSkillContext`, not kept as a long-lived dep)
 *
 * `shouldKeepToolsWithVideo`, `findExplicitlyRequestedSkills`, and
 * `listRegisteredSkillTokens` still operate correctly against the reduced
 * dep shape.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'

function createOrchestrator() {
  return new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-copy-analyzer',
        name: 'Video Copy Analyzer',
        description: 'analyze copy',
        defaultAction: 'video_copy_analyze',
        actions: [{ name: 'video_copy_analyze', visibility: 'public' }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
}

test('shouldKeepToolsWithVideo returns true on explicit skill mentions, false otherwise', () => {
  const orchestrator = createOrchestrator()

  assert.equal(orchestrator.shouldKeepToolsWithVideo('使用 video copy analyzer skill', undefined), true)
  // Post-Phase 4 PR5 follow-up: the state machine is gone, so a non-matching
  // prompt in any session returns false regardless of sessionId.
  assert.equal(orchestrator.shouldKeepToolsWithVideo('普通视频分析', 'scope-1'), false)
  assert.equal(orchestrator.shouldKeepToolsWithVideo('普通视频分析', 'scope-2'), false)
})

test('buildPreferredSkillToolNames seeds with system_run_embedded_python + per-skill action tools', () => {
  const orchestrator = createOrchestrator()

  const toolNames = orchestrator.buildPreferredSkillToolNames('使用 video copy analyzer skill', 'scope-1')

  // Phase 4 PR2 — `skill_get_state` and the 5 submit/restart/cancel names
  // are retired from the preferred set.
  assert.ok(!toolNames.includes('skill_get_state'))
  assert.ok(!toolNames.includes('skill_submit_input'))
  assert.ok(toolNames.includes('system_run_embedded_python'))
  assert.ok(toolNames.includes('skill_video_copy_analyze'))
})

test('SkillContextOrchestrator also recognizes 用 xxx style explicit skill requests', () => {
  const orchestrator = createOrchestrator()

  const matched = orchestrator.findExplicitlyRequestedSkills('用 video copy analyzer 来做')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-copy-analyzer')
})

test('SkillContextOrchestrator recognizes 按 xxx 写 without explicit connector word', () => {
  const orchestrator = createOrchestrator()

  const matched = orchestrator.findExplicitlyRequestedSkills('按 video_copy_analyzer 为我写这段')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-copy-analyzer')
})

test('SkillContextOrchestrator recognizes bare skill id mentions without any connector', () => {
  const orchestrator = createOrchestrator()

  const matched = orchestrator.findExplicitlyRequestedSkills('video copy analyzer 续写这段')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-copy-analyzer')
})

test('SkillContextOrchestrator filters out short skill tokens below length threshold', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'rss',
        name: 'RSS',
        description: 'rss',
        defaultAction: 'run',
        actions: [{ name: 'run', visibility: 'public' }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills('rss 是一种格式')
  assert.equal(matched.length, 0)
})

test('SkillContextOrchestrator listRegisteredSkillTokens returns normalized dedup tokens ≥ 6 chars', () => {
  const orchestrator = createOrchestrator()

  const tokens = orchestrator.listRegisteredSkillTokens()

  assert.ok(tokens.includes('videocopyanalyzer'))
  assert.ok(tokens.every((token) => token.length >= 6))
  assert.equal(tokens.length, new Set(tokens).size)
})

