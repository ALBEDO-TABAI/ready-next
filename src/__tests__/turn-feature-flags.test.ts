import assert from 'node:assert/strict'
import test from 'node:test'

import {
  snapshotTurnFeatureFlags,
  type TurnFeatureFlags,
} from '../main/modules/agent-control/runtime-core/turn-feature-flags'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { executeToolCall } from '../main/modules/tools/tool-executor'

test('snapshotTurnFeatureFlags returns a frozen stable snapshot', () => {
  const env = {
    READY_SKILL_CHILD_RESUME_ENABLED: '1',
    READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION: '0',
    READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED: 'off',
  }

  const snapshot = snapshotTurnFeatureFlags(env)
  env.READY_SKILL_CHILD_RESUME_ENABLED = '0'
  env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION = '1'
  env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED = '1'

  assert.equal(Object.isFrozen(snapshot), true)
  assert.deepEqual(snapshot, {
    childResumeEnabled: true,
    childInternalStrictAdmission: false,
    childRunCircuitBreakerEnabled: false,
    // Stage Q (Stage 11) — both default to true (env values absent).
    referencePrimitiveLifecycleFence: true,
    skillTaskRunInvariantEnforced: true,
  })
})

test('executeToolCall strict admission follows context snapshot after env mutation', async () => {
  const previous = process.env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION
  try {
    process.env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION = '0'
    const turnFeatureFlags: TurnFeatureFlags = snapshotTurnFeatureFlags(process.env as Record<string, string | undefined>)
    process.env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION = '1'

    const result = await executeToolCall('skill_video_expert_pipeline', { url: 'https://example.test/video' }, {
      allowedToolNames: new Set(['skill_video_expert_pipeline']),
      invoker: 'model',
      turnFeatureFlags,
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'video-expert-analyzer',
        allowedTypedActions: ['skill_video_expert_pipeline'],
        allowedPrimitives: [],
        source: 'explicit',
        reason: 'test_setup',
      }),
    })

    assert.notEqual(result.data?.reason, 'internal_tool_not_allowed')
  } finally {
    if (previous === undefined) {
      delete process.env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION
    } else {
      process.env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION = previous
    }
  }
})
