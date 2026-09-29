/**
 * Stage 5 — `TurnFramePatch` merge / apply contract.
 *
 * Patches let tools surface structured updates that the turn engine merges
 * across a single batch and applies to the next iteration's frame. The
 * apply rules:
 *   - `discoveredHandles` is ADDITIVE — only fills empty fields on the
 *     skill slice, so a higher-priority resolver win is never clobbered.
 *   - `skillStatusUpdates` is OVERRIDE — every key replaces the
 *     corresponding skill slice field.
 *   - `livenessHint` only upgrades concrete, non-terminal liveness states.
 *   - Empty patch returns the input frame unchanged.
 *   - `mergeTurnFramePatches` keeps last-write-wins for scalars and
 *     concat-and-dedupe for `activeArtifactRoots`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRAME_PATCH_EMITTING_TOOL_NAMES,
  isFramePatchEmittingToolName,
} from '../main/modules/agent-control/contracts/run-contracts'
import {
  getToolResourceTag,
  isParallelSafeTool,
} from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'

// ──────────────────────────────────────────────────────────────────────────
// Step D9 — parallelism gate regression + deterministic merge by tool-call
// order. These tests guard the producer-side invariants Gamma owns.
// ──────────────────────────────────────────────────────────────────────────

test('D9: framePatch-emitting tools are never read-only parallel-safe', () => {
  // The static primitives in `FRAME_PATCH_EMITTING_TOOL_NAMES` plus the
  // dynamic `skill_<id>_<action>` typed actions (matched via
  // `isFramePatchEmittingToolName`) must all be flagged as `interactive`
  // (non-parallel-safe) by the parallelism policy. A regression here would
  // let two contract-emitting tools join the same parallel batch and
  // overwrite each other's runContract patches.
  for (const toolName of FRAME_PATCH_EMITTING_TOOL_NAMES) {
    const tag = getToolResourceTag(toolName)
    assert.equal(
      tag.accessMode,
      'interactive',
      `Static primitive ${toolName} must be interactive (non-parallel-safe)`,
    )
    assert.equal(
      isParallelSafeTool(toolName),
      false,
      `Static primitive ${toolName} must NOT be parallel-safe`,
    )
  }

  // Dynamic typed action wrapper — `skill_<id>_<action>` shape. Use a
  // synthetic name guaranteed not to collide with a real primitive.
  const dynamicTypedActionName = 'skill_video_expert_analyzer_score_batch'
  assert.equal(isFramePatchEmittingToolName(dynamicTypedActionName), true)
  const dynamicTag = getToolResourceTag(dynamicTypedActionName)
  assert.equal(
    dynamicTag.accessMode,
    'interactive',
    'Dynamic typed action wrapper must be interactive (non-parallel-safe)',
  )

  // Sanity check — actually-read-only skill tools (RSS reads) stay read-only
  // via the explicit `READ_ONLY_SKILL_TOOL_NAMES` override list. The static
  // `FRAME_PATCH_EMITTING_TOOL_NAMES` and the read-only set must never
  // overlap (enforced by the parallelism policy's module-load invariant),
  // so these stay parallel-safe even though Beta's catch-all predicate is
  // permissive about dynamic typed actions.
  for (const readOnlyName of ['skill_rss_status', 'skill_rss_list', 'skill_rss_stats']) {
    assert.equal(
      FRAME_PATCH_EMITTING_TOOL_NAMES.includes(readOnlyName),
      false,
      `${readOnlyName} must NOT be in the canonical FRAME_PATCH_EMITTING_TOOL_NAMES list`,
    )
    assert.equal(
      getToolResourceTag(readOnlyName).accessMode,
      'read',
      `${readOnlyName} must remain read-only parallel-safe`,
    )
  }
})
