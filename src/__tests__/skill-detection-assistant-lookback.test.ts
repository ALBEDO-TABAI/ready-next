import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSkillDetectionInputs,
  collectRecentAssistantSkillToolUses,
} from '../main/modules/agent-control/skills/skill-detection-inputs'

// skill-resume plan A2 — when the user's current input is a bare retry intent
// ("继续"), skill detection now also scans recent assistant tool_use blocks
// for `skill_*` names, so the orchestrator can re-arm the reference-skill
// hint based on what was being used before. Closes the gap where the
// in-memory hint had been lost (e.g. after a Ready restart) AND user text
// alone doesn't mention any skill.

describe('collectRecentAssistantSkillToolUses', () => {
  it('returns empty for empty messages', () => {
    assert.deepEqual(collectRecentAssistantSkillToolUses([]), [])
  })

  it('extracts Anthropic-style tool_use blocks from assistant content array', () => {
    const messages = [
      { role: 'user', content: 'do video work' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'starting' },
          { type: 'tool_use', id: 't1', name: 'skill_video_expert_pipeline', input: {} },
        ],
      },
    ]
    const result = collectRecentAssistantSkillToolUses(messages)
    assert.deepEqual(result, ['skill_video_expert_pipeline'])
  })

  it('extracts text-bridge style skill_* names from assistant string content', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'I will call skill_run_shell with python3 scripts/run.py and then skill_video_expert_pipeline',
      },
    ]
    const result = collectRecentAssistantSkillToolUses(messages)
    // dedup preserves first-seen order
    assert.deepEqual(result, ['skill_run_shell', 'skill_video_expert_pipeline'])
  })

  it('walks newest → oldest and respects limit', () => {
    const messages = [
      { role: 'assistant', content: 'skill_a_old' },        // oldest, idx 0
      { role: 'assistant', content: 'skill_b_mid' },
      { role: 'assistant', content: 'skill_c_recent' },     // newest, idx 2
    ]
    const result = collectRecentAssistantSkillToolUses(messages, 2)
    assert.deepEqual(result, ['skill_c_recent', 'skill_b_mid'])
  })

  it('dedupes repeated skill names across multiple messages', () => {
    const messages = [
      { role: 'assistant', content: 'skill_run_shell' },
      { role: 'assistant', content: 'skill_run_shell' },
      { role: 'assistant', content: 'skill_run_shell' },
    ]
    const result = collectRecentAssistantSkillToolUses(messages)
    assert.deepEqual(result, ['skill_run_shell'])
  })

  it('ignores non-assistant messages', () => {
    const messages = [
      { role: 'user', content: 'skill_video_expert_pipeline' },  // user mention is NOT a real call
      { role: 'tool', content: 'skill_run_shell' },
      { role: 'assistant', content: 'skill_actual_use' },
    ]
    const result = collectRecentAssistantSkillToolUses(messages)
    assert.deepEqual(result, ['skill_actual_use'])
  })

  it('ignores non-skill_ tool names', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'file_search' },
          { type: 'tool_use', name: 'memory_search' },
          { type: 'tool_use', name: 'skill_run_shell' },
        ],
      },
    ]
    const result = collectRecentAssistantSkillToolUses(messages)
    assert.deepEqual(result, ['skill_run_shell'])
  })
})

describe('buildSkillDetectionInputs with previousAssistantSkillToolUses', () => {
  it('on bare-retry intent: appends prior skill tool names to detection batch', () => {
    const result = buildSkillDetectionInputs({
      contextualUserInput: '继续',
      primaryInstruction: '继续',
      pureUserText: '继续',
      previousPureUserInputs: ['help me with video-expert task'],
      previousAssistantSkillToolUses: ['skill_video_expert_pipeline', 'skill_run_shell'],
    })
    assert.ok(result.includes('继续'), 'current input retained')
    assert.ok(result.includes('help me with video-expert task'), 'prior user input included')
    assert.ok(result.includes('skill_video_expert_pipeline'), 'prior skill tool name appended')
    assert.ok(result.includes('skill_run_shell'), 'prior primitive name appended')
  })

  it('on non-retry intent: does NOT append prior skill tool names', () => {
    const result = buildSkillDetectionInputs({
      contextualUserInput: 'please make a new RSS card',
      primaryInstruction: 'please make a new RSS card',
      pureUserText: 'please make a new RSS card',
      previousPureUserInputs: ['some prior'],
      previousAssistantSkillToolUses: ['skill_video_expert_pipeline'],
    })
    assert.ok(!result.includes('skill_video_expert_pipeline'),
      'non-retry intent does NOT inherit prior skill names')
  })

  it('caps at 5 prior skill tool names even if more provided', () => {
    const result = buildSkillDetectionInputs({
      contextualUserInput: '继续',
      previousAssistantSkillToolUses: [
        'skill_a_one', 'skill_a_two', 'skill_a_three', 'skill_a_four',
        'skill_a_five', 'skill_a_six', 'skill_a_seven',
      ],
    })
    const skillEntries = result.filter(s => s.startsWith('skill_a_'))
    assert.equal(skillEntries.length, 5, 'limited to 5')
  })
})
