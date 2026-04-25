import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  rememberLastReferenceSkill,
  snapshotLastReferenceSkill,
  restoreLastReferenceSkill,
  getLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'
import {
  collectRecentAssistantSkillToolUses,
  buildSkillDetectionInputs,
  isRetryOnlyTurn,
} from '../main/modules/agent-control/skill-detection-inputs'
import { shouldExposeSkillAction } from '../main/modules/tools/skills-tools'

// skill-resume F1 — narrative integration test that walks the full chain a
// resume bug walked in production:
//
// (1) User on conv-X did video-expert work — `skill_video_expert_pipeline`
//     was called, reference hint was armed.
// (2) User killed Ready (in-memory hint Map vanishes).
// (3) User re-opened, picked the same conv, and typed "继续之前任务".
// (4) Without these fixes: hint=null, primitive tools hidden, internal-vis
//     `skill_video_expert_pipeline` still hidden, agent saw only RSS skills
//     and looped through them.
//
// This test asserts each link in the chain produces what the next link needs.

describe('skill-resume end-to-end (F1)', () => {
  beforeEach(() => {
    _resetLastReferenceSkillHintsForTests()
  })

  it('persistence link: snapshot before kill → restore after restart preserves hint+TTL', () => {
    const sessionId = 'conv-aipf10'
    rememberLastReferenceSkill(sessionId, { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
    const live = getLastReferenceSkill(sessionId)
    assert.ok(live, 'live hint exists')

    // (kill) snapshot to "DB"
    const persisted = snapshotLastReferenceSkill(sessionId)
    assert.ok(persisted, 'snapshot succeeded')
    assert.equal(persisted!.id, 'video-expert-analyzer')

    // (restart) clear in-memory state
    _resetLastReferenceSkillHintsForTests()
    assert.equal(getLastReferenceSkill(sessionId), null, 'hint gone after restart')

    // (resume) replay from "DB"
    const restored = restoreLastReferenceSkill(sessionId, persisted)
    assert.equal(restored, true)
    const post = getLastReferenceSkill(sessionId)
    assert.ok(post)
    assert.equal(post!.id, 'video-expert-analyzer')
    assert.equal(post!.at, persisted!.at, 'preserved original `at` so TTL math survives restart')
  })

  it('lookback link: bare "继续" probes prior assistant tool_use for skill_*', () => {
    const userInput = '继续上次'
    assert.equal(isRetryOnlyTurn(userInput), true, 'detected as retry-only turn')

    const messages = [
      { role: 'user', content: '帮我分析视频' },
      { role: 'assistant', content: [
        { type: 'text', text: 'starting' },
        { type: 'tool_use', id: 't1', name: 'skill_video_expert_pipeline', input: {} },
      ] },
      { role: 'user', content: userInput },
    ]
    // exclude current input (last)
    const previousAssistantSkillToolUses = collectRecentAssistantSkillToolUses(
      messages.slice(0, -1) as Array<{ role?: string; content?: unknown }>,
    )
    assert.deepEqual(previousAssistantSkillToolUses, ['skill_video_expert_pipeline'])

    const inputs = buildSkillDetectionInputs({
      contextualUserInput: userInput,
      primaryInstruction: userInput,
      pureUserText: userInput,
      previousPureUserInputs: ['帮我分析视频'],
      previousAssistantSkillToolUses,
    })
    assert.ok(
      inputs.includes('skill_video_expert_pipeline'),
      'lookback fed the prior skill name into detection batch',
    )
  })

  it('exposure link: when hint armed, expose_when_hint_armed action becomes visible', () => {
    // hint-armed for unrelated skill: video-expert action stays internal
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'lets-go-rss',
        exposeWhenHintArmed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      }),
      false,
      'hint armed for a different skill does not unlock this skill\'s internal actions',
    )

    // hint-armed for video-expert AND action listed: visible
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      }),
      true,
      'matching hint + whitelisted action → exposed',
    )

    // hint-armed but action NOT listed: stays hidden
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'some_other_action',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
      'matching hint but action not whitelisted → hidden',
    )

    // no hint: internal stays hidden
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: null,
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
      'no hint armed → internal stays hidden even when whitelisted',
    )

    // public action: always exposed regardless of hint
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'public',
        actionName: 'rss_add',
        skillId: 'lets-go-rss',
        referenceHintSkillId: null,
        exposeWhenHintArmed: [],
      }),
      true,
      'public action stays public regardless of hint state',
    )
  })

  it('regression: a fresh "继续" turn (no prior video tool use) does NOT inherit unrelated skill names', () => {
    const userInput = '继续'
    const messages = [
      { role: 'user', content: 'add an RSS feed' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'skill_lets_go_rss_rss_add', input: {} },
      ] },
      { role: 'user', content: userInput },
    ]
    const previousAssistantSkillToolUses = collectRecentAssistantSkillToolUses(
      messages.slice(0, -1) as Array<{ role?: string; content?: unknown }>,
    )
    assert.deepEqual(previousAssistantSkillToolUses, ['skill_lets_go_rss_rss_add'])

    const inputs = buildSkillDetectionInputs({
      contextualUserInput: userInput,
      previousAssistantSkillToolUses,
    })
    assert.ok(inputs.includes('skill_lets_go_rss_rss_add'),
      'lookback correctly attributes to the actual prior skill, not a hardcoded one')
    assert.ok(!inputs.includes('skill_video_expert_pipeline'),
      'no leakage from other tests/sessions')
  })
})
