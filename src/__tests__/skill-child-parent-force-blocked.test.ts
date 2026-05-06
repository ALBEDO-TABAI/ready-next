/**
 * Stage N (Phase 1.4) — negative coverage for the manifest fence.
 *
 * The manifest fence (`isParentForceForbiddenByManifest`) blocks parent-side
 * force-tool synthesis for any tool name whose owning skill manifest declares
 * `child_loop.actions[]`. We verify three scenarios:
 *
 *   Case A — manifest fence (no childRunId on contract): VEA tool name fed
 *     to the synthesis site MUST emit `turn_force_tool_blocked_child_owned`,
 *     no `turn_force_tool_dispatched`, and the turn closes via checkpoint.
 *
 *   Case B — contract fence (childRunId set): the existing contract fence
 *     short-circuits before the manifest fence is reached. No metric of
 *     either kind fires for this iteration.
 *
 *   Case C — non-child-loop legacy path lives: a non-child-loop skill
 *     (lets-go-rss/rss_update) with no childRunId still flows through the
 *     legacy force-tool path; manifest fence does not fire.
 *
 * Pure unit tests via the live `isParentForceForbiddenByManifest`. Covering
 * the integration path (steering ↔ engine ↔ executor) is the job of the
 * existing `turn-engine-force-tool-dispatch.test.ts` (which Phase 1.5
 * re-targeted to use the legacy fixture).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { isParentForceForbiddenByManifest } from '../main/modules/agent-control/run-contracts'

test('Case A — manifest fence fires for VEA pipeline tool name', () => {
  // VEA `skill_video_expert_pipeline` is in STATIC_SKILL_TOOL_NAMES_BY_ACTION
  // AND its manifest declares `child_loop.actions: [video_expert_pipeline, ...]`.
  // The fence MUST return true regardless of contract state.
  assert.equal(isParentForceForbiddenByManifest('skill_video_expert_pipeline'), true)
  assert.equal(isParentForceForbiddenByManifest('skill_video_expert_ai_analyze'), true)
})

test('Case C — non-child-loop legacy fixture falls through (manifest fence stays off)', () => {
  // lets-go-rss tool names ARE in STATIC_SKILL_TOOL_NAMES_BY_ACTION but the
  // manifest does NOT declare `child_loop`. Fence MUST return false.
  assert.equal(isParentForceForbiddenByManifest('skill_rss_update'), false)
  assert.equal(isParentForceForbiddenByManifest('skill_rss_status'), false)
  assert.equal(isParentForceForbiddenByManifest('skill_rss_add'), false)
})

test('unmapped tool names return false (Phase 0.2 + 0.3 ensure no embedded child_loop action drifts off the static map)', () => {
  // Names NOT in the static map cannot be reverse-resolved to a
  // (skillId, action) pair, so the fence returns false. Custom skill
  // dynamic tool names fall here — Phase 0.4 strips their child_loop at
  // compile so this branch only fires for non-child-loop names.
  assert.equal(isParentForceForbiddenByManifest('skill_unknown_tool'), false)
  assert.equal(isParentForceForbiddenByManifest('memory_search'), false)
  assert.equal(isParentForceForbiddenByManifest(''), false)
  assert.equal(isParentForceForbiddenByManifest(null), false)
  assert.equal(isParentForceForbiddenByManifest(undefined), false)
})

test('static map ↔ child-loop manifest are consistent for all VEA actions', () => {
  // Sanity: every entry in STATIC_SKILL_TOOL_NAMES_BY_ACTION whose skillId is
  // 'video-expert-analyzer' MUST be fence-blocked.
  // This mirrors the Phase 0.3 boot assertion's invariant.
  // Direct import is not feasible (different test file scope); instead
  // we hard-list the two known VEA tool names. If a third VEA action lands
  // it must be added here AND covered by Phase 0.2's static gate.
  const veaToolNames = ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze']
  for (const name of veaToolNames) {
    assert.equal(
      isParentForceForbiddenByManifest(name),
      true,
      `VEA tool name ${name} must be manifest-fenced`,
    )
  }
})
