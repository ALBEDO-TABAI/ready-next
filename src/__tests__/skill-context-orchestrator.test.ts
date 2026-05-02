import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'
import {
  getLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'

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
    executeTool: async (_tool, _args) => 'STDOUT:\n技能说明',
  })
}

test('SkillContextOrchestrator keeps tools available for explicit skill only (Phase 4: no active-execution fallback)', () => {
  const orchestrator = createOrchestrator()

  assert.equal(orchestrator.shouldKeepToolsWithVideo('使用 video copy analyzer skill', undefined), true)
  // Phase 4: the active-execution stub branch is gone; generic text without a
  // skill/python signal no longer keeps skill tools alive just because the
  // session had a running execution.
  assert.equal(orchestrator.shouldKeepToolsWithVideo('普通视频分析', 'scope-1'), false)
  assert.equal(orchestrator.shouldKeepToolsWithVideo('普通视频分析', 'scope-2'), false)
})

test('SkillContextOrchestrator builds preferred skill tool names from explicit skills', () => {
  const orchestrator = createOrchestrator()

  const toolNames = orchestrator.buildPreferredSkillToolNames('使用 video copy analyzer skill', 'scope-1')

  for (const retired of [
    'skill_get_state',
    'skill_submit_input',
    'skill_submit_confirmation',
    'skill_submit_agent_result',
    'skill_restart_from_step',
    'skill_cancel_execution',
  ]) {
    assert.equal(toolNames.includes(retired), false, `${retired} must stay retired`)
  }
  assert.ok(toolNames.includes('skill_video_copy_analyze'))
  for (const primitive of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
  ]) {
    assert.ok(toolNames.includes(primitive), `${primitive} should be preferred for explicit reference-skill turns`)
  }
})

test('SkillContextOrchestrator does not prefer the legacy embedded-python runner for reference skills', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: 'video analysis',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const toolNames = orchestrator.buildPreferredSkillToolNames('再重试使用 Video Expert Analyzer (VNext)', 'scope-1')

  assert.equal(toolNames.includes('system_run_embedded_python'), false)
  assert.equal(toolNames.includes('skill_video_expert_analyzer_read_skill'), false)
  for (const primitive of [
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
  ]) {
    assert.ok(toolNames.includes(primitive), `${primitive} should stay available for reference skills`)
  }
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

test('SkillContextOrchestrator recognizes uppercase acronyms as skill aliases', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: 'video analysis',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills('VEA 继续')

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'video-expert-analyzer')
})

test('SkillContextOrchestrator prefers explicitly named skills over fuzzy description matches', () => {
  _resetLastReferenceSkillHintsForTests()
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'video-expert-analyzer',
        name: 'Video Expert Analyzer (VNext)',
        description: '长视频深度分析与场景评分',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
      {
        id: 'video-copy-analyzer',
        name: 'Video Copy Analyzer',
        description: '视频分析与文案拆解',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      },
    ] as any,
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })
  const sessionId = 'explicit-skill-outranks-fuzzy'
  const userText = '用 @[Video Expert Analyzer (VNext)]分析@[Inside Notion SF Office - YouTube]，输出到@[测试]'

  const matched = orchestrator.findExplicitlyRequestedSkills(userText)
  assert.deepEqual(matched.map((skill) => skill.id), ['video-expert-analyzer'])

  assert.equal(orchestrator.rememberExplicitReferenceSkillHint(userText, sessionId), true)
  assert.equal(getLastReferenceSkill(sessionId)?.id, 'video-expert-analyzer')
})

test('SkillContextOrchestrator can match concrete tasks through skill descriptions', () => {
  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [
      {
        id: 'media-scene-review',
        name: 'Media Scene Review',
        description: '长视频深度分析与场景评分',
        defaultAction: 'read_skill',
        executionMode: 'advisory',
        actions: [{ name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] }],
      } as any,
    ],
    resolveSkillToolByAction: (_skillId, action) => ({ name: `skill_${action}`, action }) as any,
  })

  const matched = orchestrator.findExplicitlyRequestedSkills(
    '分析这个视频 https://www.youtube.com/watch?v=4qkyxm4jppc，输出到 /Users/me/测试',
  )

  assert.equal(matched.length, 1)
  assert.equal(matched[0]?.id, 'media-scene-review')
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
    executeTool: async () => 'STDOUT:\n技能说明',
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
