import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { snapshotTurnFeatureFlags } from '../main/modules/agent-control/runtime-core/turn-feature-flags'
import {
  __setSkillsRuntimeManagerForTests,
  type SkillsRuntimeManager,
  type SkillState,
} from '../main/modules/skills-runtime/runtime-manager'
import { executeSkillTool } from '../main/modules/tools/skills-tools'

// 2026-10-06: inside a Codex turn the context-compact skill's tool answered “Unknown skill primitive”, which the
// model relayed as “未知技能”. Compaction runs between turns, so the tool says so and points at the real entry.
test('skill_compact_context inside a Codex turn explains where compaction runs instead of failing as unknown', async () => {
  const skill = {
    id: 'context-compact', name: 'context-compact', description: '', version: '0.1.0',
    installed: true, installStatePath: '', source: 'embedded', manifestValid: true,
    runtime: 'reference', managedPath: '/nonexistent/context-compact',
    actions: [{ name: 'read_skill', runtime: 'reference' }],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({ listSkills: () => [skill] } as unknown as SkillsRuntimeManager)
  try {
    const result = await executeSkillTool('skill_compact_context', {}, 'session-compact', undefined, undefined, undefined, {
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'context-compact',
        allowedTypedActions: [],
        allowedPrimitives: ['skill_compact_context'],
        source: 'explicit',
        reason: 'test_codex_compact',
      }),
      turnFeatureFlags: snapshotTurnFeatureFlags({}),
      codexHostPrimitiveOnly: true,
    })
    const text = typeof result === 'string' ? result : JSON.stringify(result)
    assert.doesNotMatch(text, /Unknown skill/)
    assert.match(text, /compaction_runs_between_turns/)
    assert.match(text, /@\[context-compact\]/)
    assert.match(text, /压缩上下文/)
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})
