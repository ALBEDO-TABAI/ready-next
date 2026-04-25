import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { shouldExposeSkillAction } from '../main/modules/tools/skills-tools'

// skill-resume B2 — internal-visibility actions can be exposed to the LLM when
// (a) reference-skill hint armed AND (b) skill.id matches AND (c) action.name in
// host_requirements.expose_when_hint_armed. All three conditions must hold.

describe('shouldExposeSkillAction (B2 visibility filter)', () => {
  it('non-internal action: always exposed regardless of hint state', () => {
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'public',
        actionName: 'rss_update',
        skillId: 'lets-go-rss',
        referenceHintSkillId: null,
        exposeWhenHintArmed: [],
      }),
      true,
      'public action with no hint exposed',
    )
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'public',
        actionName: 'rss_update',
        skillId: 'lets-go-rss',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: [],
      }),
      true,
      'public action with foreign hint still exposed',
    )
  })

  it('internal action with NO hint armed: hidden', () => {
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: null,
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
      'no hint = hidden even if whitelisted',
    )
  })

  it('internal action + hint armed for SAME skill + action whitelisted: EXPOSED (the resume case)', () => {
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      }),
      true,
    )
  })

  it('internal action + hint armed for DIFFERENT skill: hidden (cross-skill leakage prevented)', () => {
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'lets-go-rss',
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
    )
  })

  it('internal action + hint matches BUT action NOT in whitelist: hidden', () => {
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_secret_internal',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline'], // does not include the secret
      }),
      false,
    )
  })

  it('internal action + hint matches BUT skill has empty whitelist: hidden', () => {
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: [], // empty
      }),
      false,
    )
  })

  it('read_skill internal action (advisory skill) — covered by same rule', () => {
    // read_skill is a common internal action across all reference skills.
    // It is NOT in expose_when_hint_armed by default → stays hidden. The plan
    // specifically does NOT expose read_skill (the inline-injection mechanism
    // delivers SKILL.md content; LLM doesn't need to re-call read_skill).
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'read_skill',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
    )
  })
})
