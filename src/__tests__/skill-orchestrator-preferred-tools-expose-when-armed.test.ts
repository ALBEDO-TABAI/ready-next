import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'

// skill-resume G6 — when the user fires a retry intent, G3 synthesizes a
// skillContextInjectionText so findExplicitlyRequestedSkills succeeds. That
// in turn calls buildPreferredSkillToolNames, which then becomes the narrow
// allowlist for `filterPreferredSkillAnthropicTools` downstream. If the
// internal-but-whitelisted typed actions (declared in
// `host_requirements.expose_when_hint_armed`) are not in this preference
// set, the filter strips them — which is the bug we hit in production:
// `skill_video_expert_pipeline` disappeared from allowedToolNames and the
// LLM had no choice but to fork pipeline_enhanced.py via skill_run_shell.

const VEA_SKILL = {
  id: 'video-expert-analyzer',
  name: 'Video Expert Analyzer (VNext)',
  executionMode: 'advisory' as const,
  hostRequirements: {
    expose_when_hint_armed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
  },
  actions: [
    { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
    { name: 'video_expert_pipeline', visibility: 'internal', runtime: 'subprocess', params: [] },
    { name: 'video_expert_ai_analyze', visibility: 'internal', runtime: 'subprocess', params: [] },
  ],
}

function makeOrchestrator() {
  return new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [VEA_SKILL] as never,
    resolveSkillToolByAction: (skillId, actionName) => ({
      name: `skill_${skillId.replace(/-/g, '_')}_${actionName}`,
      action: actionName,
      params: [],
    }),
  })
}

describe('skill-resume G6 — buildPreferredSkillToolNames honors expose_when_hint_armed', () => {
  beforeEach(() => {
    _resetLastReferenceSkillHintsForTests()
  })

  it('includes whitelisted internal actions when hint is armed for that skill', () => {
    const sessionId = 'session-vea'
    rememberLastReferenceSkill(sessionId, { id: 'video-expert-analyzer', name: VEA_SKILL.name })

    const orchestrator = makeOrchestrator()
    // Simulate the synthesized text from G3 (turn-engine after rearm)
    const tools = orchestrator.buildPreferredSkillToolNames(
      `用户希望继续使用 skill "${VEA_SKILL.name}"`,
      sessionId,
    )
    assert.ok(
      tools.includes('skill_video_expert_analyzer_video_expert_pipeline'),
      'whitelisted internal pipeline action must be in preference set',
    )
    assert.ok(
      tools.includes('skill_video_expert_analyzer_video_expert_ai_analyze'),
      'whitelisted internal ai_analyze action must be in preference set',
    )
    // Internal action NOT in whitelist (read_skill) stays out
    assert.equal(
      tools.includes('skill_video_expert_analyzer_read_skill'),
      false,
      'non-whitelisted internal action stays excluded',
    )
    // Primitives are always included
    assert.ok(tools.includes('skill_run_shell'))
    assert.ok(tools.includes('skill_ask_user'))
  })

  it('does NOT include the whitelisted action when hint is armed for a DIFFERENT skill', () => {
    const sessionId = 'session-other'
    rememberLastReferenceSkill(sessionId, { id: 'lets-go-rss', name: 'lets-go-rss' })

    const orchestrator = makeOrchestrator()
    const tools = orchestrator.buildPreferredSkillToolNames(
      `用户希望继续使用 skill "${VEA_SKILL.name}"`,
      sessionId,
    )
    assert.equal(
      tools.includes('skill_video_expert_analyzer_video_expert_pipeline'),
      false,
      'hint armed for unrelated skill must not unlock this skill\'s internal action',
    )
  })

  it('does NOT include internal actions when no hint is armed', () => {
    const orchestrator = makeOrchestrator()
    const tools = orchestrator.buildPreferredSkillToolNames(
      `用户希望继续使用 skill "${VEA_SKILL.name}"`,
      'session-no-hint',
    )
    assert.equal(
      tools.includes('skill_video_expert_analyzer_video_expert_pipeline'),
      false,
    )
    // Primitives still present
    assert.ok(tools.includes('skill_run_shell'))
  })

  it('preserves the existing public-action path (no regression)', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [{
        id: 'lets-go-rss',
        name: 'lets-go-rss',
        executionMode: 'subprocess' as const,
        actions: [
          { name: 'rss_add', visibility: 'public', runtime: 'subprocess', params: [] },
          { name: 'rss_update', visibility: 'public', runtime: 'subprocess', params: [] },
        ],
      }] as never,
      resolveSkillToolByAction: (skillId, actionName) => ({
        name: `skill_${skillId.replace(/-/g, '_')}_${actionName}`,
        action: actionName,
        params: [],
      }),
    })
    const tools = orchestrator.buildPreferredSkillToolNames('使用 lets-go-rss', 'sess')
    assert.ok(tools.includes('skill_lets_go_rss_rss_add'))
    assert.ok(tools.includes('skill_lets_go_rss_rss_update'))
  })
})
