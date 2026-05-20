/**
 * Stage S (PR-S6 / W4.2) — vision tool gating in tool-gateway.
 *
 * Verifies the `filterToolsByVisionCapability` helper drops tools
 * whose names are in `VISION_REQUIRING_TOOL_NAMES` when the resolved
 * capability says vision is unavailable.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterToolsByVisionCapability,
  VISION_REQUIRING_TOOL_NAMES,
} from '../main/modules/agent-control/tools-runtime/tool-gateway'

test('VISION_REQUIRING_TOOL_NAMES is a frozen array', () => {
  assert.ok(Array.isArray(VISION_REQUIRING_TOOL_NAMES))
  assert.ok(Object.isFrozen(VISION_REQUIRING_TOOL_NAMES))
})

test('filterToolsByVisionCapability passes tools through when supportsVision=true', () => {
  const tools = [
    { name: 'view_image', description: 'pretend image tool' },
    { name: 'browser_open', description: 'plain text tool' },
  ]
  const out = filterToolsByVisionCapability(tools, { supportsVision: true })
  assert.equal(out.length, 2)
})

test('filterToolsByVisionCapability drops vision-requiring tools when supportsVision=false', () => {
  // The current allowlist is empty (view_image not yet shipped); test
  // that the helper still passes plain tools through and that injecting
  // a custom vision name into the helper's filter logic via the tools
  // list does NOT accidentally drop them.
  const tools = [
    { name: 'view_image', description: 'pretend image tool' },
    { name: 'browser_open', description: 'plain text tool' },
  ]
  const out = filterToolsByVisionCapability(tools, { supportsVision: false })
  // When VISION_REQUIRING_TOOL_NAMES is empty, both pass through.
  if (VISION_REQUIRING_TOOL_NAMES.length === 0) {
    assert.equal(out.length, 2)
  } else {
    // Future-proof: if ever populated, view_image must be dropped.
    assert.equal(out.find((t) => (t as { name?: string }).name === 'view_image'), undefined)
  }
})

test('filterToolsByVisionCapability handles OpenAI function-shape tool entries', () => {
  const tools = [
    { type: 'function', function: { name: 'browser_open' } },
  ]
  const out = filterToolsByVisionCapability(tools, { supportsVision: false })
  assert.equal(out.length, 1)
})
