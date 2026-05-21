/**
 * Stage N (Phase 1.4) — predicate-level coverage for the manifest fence.
 *
 * Scope: this file covers the **pure helper** `isParentForceForbiddenByManifest`
 * directly. We verify the helper's truth table for VEA (child-loop), lets-go-rss
 * (non-child-loop, real static map entry), and unmapped names. We do NOT test
 * the engine integration path (metric emission, system reminder push,
 * checkpoint terminal) here — that is owned by:
 *   - `turn-engine-force-tool-dispatch.test.ts` (Phase 1.5 re-target):
 *     the legacy regression with non-child-loop fixtures, asserting
 *     `turn_force_tool_dispatched` still fires AND
 *     `turn_force_tool_blocked_child_owned` does NOT.
 *   - `turn-engine-route.test.ts` (Stage N regression update):
 *     the refresh-after-inspect path, asserting at least one
 *     `turn_force_tool_blocked_child_owned` fires for VEA without childRunId.
 *   - `agent-vea-resume-probe.test.cjs`:
 *     the closed-loop smoke that exercises the full steering → engine
 *     → checkpoint path under the manifest fence.
 *
 * Splitting predicate vs. integration coverage keeps each test focused and
 * lets the predicate test stay pure-helper (no DB, no full engine spin-up).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { isParentForceForbiddenByManifest } from '../main/modules/agent-control/contracts/run-contracts'

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
