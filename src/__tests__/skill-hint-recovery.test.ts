import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { findSkillHintInCapsuleTexts } from '../main/modules/agent-control/skill-hint-recovery'

// skill-resume G4 — last-recourse hint recovery from auto-attached capsule
// text. Tests the pure helper without any IO or runtime-manager wiring.

describe('skill-resume G4 — findSkillHintInCapsuleTexts', () => {
  it('returns the resolved skill when the capsule text mentions a canonical skill_* tool name', () => {
    const recovered = findSkillHintInCapsuleTexts(
      [
        '上次跑到 step 3 的 skill_video_expert_pipeline，输出了 8 个素材片段',
      ],
      {
        resolveToolByName: (name) => {
          if (name === 'skill_video_expert_pipeline') return { skillId: 'video-expert-analyzer' }
          return null
        },
        listSkills: () => [{
          id: 'video-expert-analyzer',
          name: 'video-expert-analyzer',
          executionMode: 'advisory',
          actions: [{ runtime: 'reference' }],
        }],
      },
    )
    assert.deepEqual(recovered, { skillId: 'video-expert-analyzer', skillName: 'video-expert-analyzer' })
  })

  it('returns null when no canonical skill_* pattern appears in the texts', () => {
    const recovered = findSkillHintInCapsuleTexts(
      ['普通的会话摘要，没有任何工具名信息'],
      {
        resolveToolByName: () => null,
        listSkills: () => [],
      },
    )
    assert.equal(recovered, null)
  })

  it('returns null when the matched tool name does not resolve to a skill', () => {
    const recovered = findSkillHintInCapsuleTexts(
      ['agent 调用了 skill_unknown_action 后失败'],
      {
        resolveToolByName: () => null,
        listSkills: () => [{
          id: 'whatever',
          name: 'whatever',
          actions: [],
        }],
      },
    )
    assert.equal(recovered, null)
  })

  it('returns null when the resolved skill is NOT reference-like (no advisory mode, no reference runtime)', () => {
    const recovered = findSkillHintInCapsuleTexts(
      ['agent 调用了 skill_plain_skill_do_thing'],
      {
        resolveToolByName: (name) => {
          if (name === 'skill_plain_skill_do_thing') return { skillId: 'plain-skill' }
          return null
        },
        listSkills: () => [{
          id: 'plain-skill',
          name: 'plain-skill',
          executionMode: 'subprocess',
          actions: [{ runtime: 'subprocess' }],
        }],
      },
    )
    assert.equal(recovered, null, 'hint must not be armed for non-reference skills')
  })

  it('scans across multiple text inputs and returns the first valid match', () => {
    const recovered = findSkillHintInCapsuleTexts(
      [
        null,
        '没有 skill 名',
        '此前用过 skill_lets_go_rss_rss_add 添加订阅',
        '又用了 skill_video_expert_pipeline',
      ],
      {
        resolveToolByName: (name) => {
          if (name === 'skill_lets_go_rss_rss_add') return { skillId: 'lets-go-rss' }
          if (name === 'skill_video_expert_pipeline') return { skillId: 'video-expert-analyzer' }
          return null
        },
        listSkills: () => [
          {
            id: 'lets-go-rss',
            name: 'lets-go-rss',
            actions: [{ runtime: 'reference' }],
          },
          {
            id: 'video-expert-analyzer',
            name: 'video-expert-analyzer',
            executionMode: 'advisory',
            actions: [{ runtime: 'reference' }],
          },
        ],
      },
    )
    // Texts are scanned in order; the first reference-like match wins
    assert.deepEqual(recovered, { skillId: 'lets-go-rss', skillName: 'lets-go-rss' })
  })

  it('handles empty inputs gracefully', () => {
    assert.equal(
      findSkillHintInCapsuleTexts([], { resolveToolByName: () => null, listSkills: () => [] }),
      null,
    )
    assert.equal(
      findSkillHintInCapsuleTexts(
        ['skill_anything'],
        { resolveToolByName: () => null, listSkills: () => [] },
      ),
      null,
      'no skills registered → no recovery possible',
    )
  })

  it('only matches the canonical `skill_<id>_<action>` shape, not bare "skill" mentions', () => {
    const recovered = findSkillHintInCapsuleTexts(
      ['用户提到了 skill 这个词，但没有具体工具名'],
      {
        resolveToolByName: () => {
          throw new Error('should not be called for bare "skill" word')
        },
        listSkills: () => [{ id: 'x', name: 'x', actions: [{ runtime: 'reference' }] }],
      },
    )
    assert.equal(recovered, null)
  })
})
