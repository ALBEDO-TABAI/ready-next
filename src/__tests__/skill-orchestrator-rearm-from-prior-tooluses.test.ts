import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { SkillContextOrchestrator } from '../main/modules/agent-control/skill-context-orchestrator'
import {
  getLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'

// skill-resume G2 — orchestrator must reverse-resolve `skill_*` tool names from
// prior assistant tool_use blocks back to the owning skill, then arm the
// reference-skill hint. Without this, A2 lookback feeds tool names like
// `skill_video_expert_pipeline` into substring-matching code that never finds
// the skill id `video-expert-analyzer` (the words don't share a substring).

describe('skill-resume G2 — rememberReferenceSkillFromPriorToolUses', () => {
  beforeEach(() => {
    _resetLastReferenceSkillHintsForTests()
  })

  it('arms hint when prior tool_use resolves to an advisory (reference-like) skill', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [{
        id: 'video-expert-analyzer',
        name: 'video-expert-analyzer',
        executionMode: 'advisory',
        actions: [
          { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
          { name: 'video_expert_pipeline', visibility: 'internal', runtime: 'subprocess', params: [] },
        ],
      }] as never,
      resolveSkillToolByAction: (skillId, actionName) => ({
        name: `skill_${skillId}_${actionName}`,
        action: actionName,
        params: [],
      }),
      // Real production resolver (`findSkillToolByName`) returns a SkillToolDef
      // with a `.skillId` field. Mimic that shape.
      resolveSkillToolByName: (toolName) => {
        if (toolName === 'skill_video_expert_pipeline') {
          return { name: toolName, action: 'video_expert_pipeline', skillId: 'video-expert-analyzer', params: [] } as never
        }
        return null
      },
    })

    const result = orchestrator.rememberReferenceSkillFromPriorToolUses(
      ['skill_video_expert_pipeline'],
      'session-1',
    )
    assert.equal(result.armed, true)
    assert.equal(result.skillId, 'video-expert-analyzer')
    assert.equal(result.skillName, 'video-expert-analyzer')

    const live = getLastReferenceSkill('session-1')
    assert.ok(live, 'in-memory hint set')
    assert.equal(live!.id, 'video-expert-analyzer')
  })

  it('arms hint when skill has a reference-runtime action (not necessarily advisory mode)', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [{
        id: 'lets-go-rss',
        name: 'lets-go-rss',
        executionMode: 'subprocess',
        actions: [
          { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
          { name: 'rss_add', visibility: 'public', runtime: 'subprocess', params: [] },
        ],
      }] as never,
      resolveSkillToolByAction: () => null,
      resolveSkillToolByName: (toolName) => {
        if (toolName === 'skill_lets_go_rss_rss_add') {
          return { name: toolName, action: 'rss_add', skillId: 'lets-go-rss', params: [] } as never
        }
        return null
      },
    })

    const result = orchestrator.rememberReferenceSkillFromPriorToolUses(
      ['skill_lets_go_rss_rss_add'],
      'session-rss',
    )
    assert.equal(result.armed, true, 'reference-action presence is enough')
    assert.equal(result.skillId, 'lets-go-rss')
  })

  it('does NOT arm hint when the resolved skill is not reference-like', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [{
        id: 'plain-skill',
        name: 'plain-skill',
        executionMode: 'subprocess',
        actions: [
          { name: 'do_thing', visibility: 'public', runtime: 'subprocess', params: [] },
        ],
      }] as never,
      resolveSkillToolByAction: () => null,
      resolveSkillToolByName: (toolName) => {
        if (toolName === 'skill_plain_skill_do_thing') {
          return { name: toolName, action: 'do_thing', skillId: 'plain-skill', params: [] } as never
        }
        return null
      },
    })

    const result = orchestrator.rememberReferenceSkillFromPriorToolUses(
      ['skill_plain_skill_do_thing'],
      'session-2',
    )
    assert.equal(result.armed, false)
    assert.equal(getLastReferenceSkill('session-2'), null, 'hint stays null')
  })

  it('returns no-op for empty input or missing sessionId', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [],
      resolveSkillToolByAction: () => null,
      resolveSkillToolByName: () => null,
    })

    assert.equal(orchestrator.rememberReferenceSkillFromPriorToolUses([], 'session-x').armed, false)
    assert.equal(orchestrator.rememberReferenceSkillFromPriorToolUses(['skill_anything'], undefined).armed, false)
  })

  it('skips tool names that do not resolve to any skill', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [],
      resolveSkillToolByAction: () => null,
      resolveSkillToolByName: () => null,
    })

    const result = orchestrator.rememberReferenceSkillFromPriorToolUses(
      ['skill_unknown_tool'],
      'session-3',
    )
    assert.equal(result.armed, false)
  })

  it('falls through silently when resolveSkillToolByName dep is omitted', () => {
    const orchestrator = new SkillContextOrchestrator({
      extractPrimaryUserInstruction: (raw) => raw,
      listSkills: () => [],
      resolveSkillToolByAction: () => null,
      // resolveSkillToolByName intentionally omitted to verify back-compat with
      // existing test mocks that don't supply the lookback resolver.
    })
    const result = orchestrator.rememberReferenceSkillFromPriorToolUses(
      ['skill_video_expert_pipeline'],
      'session-4',
    )
    assert.equal(result.armed, false)
  })
})
