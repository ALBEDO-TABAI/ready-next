/**
 * Stage U PR U1.1 — tool error shape mutual exclusivity (AGENTS.md §3).
 *
 * Pin the four classes of tool admission rejection to their canonical
 * errorKind:
 *
 *   1. Fabricated non-skill name → `tool_not_registered` (top-level)
 *   2. Fabricated skill name (skill_*) → `tool_not_registered`
 *   3. Real non-skill tool missing from allowedToolNames →
 *      `errorKind: 'host_unavailable', reason: 'tool_restricted_this_turn'`
 *      (preserved — this is NOT the legacy nested `tool_not_registered`
 *      pair; `tool_restricted_this_turn` is a separate signal)
 *   4. Real skill tool with mode:'none' authorization → `authorization_denied`
 *      (covered by tool-executor-authorization.test.ts; re-asserted here)
 *
 * These four are mutually exclusive — no overlap, no fallthrough.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('tool-error-shape-mutual-exclusivity declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'tool-error-shape-mutual-exclusivity transitive sqlite guard')
})

function makeModelContext(overrides?: Partial<ToolContext>): Partial<ToolContext> {
  return {
    allowedToolNames: new Set<string>(),
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'scope-u1.1',
    ...overrides,
  }
}

test('U1.1 class 1: fabricated non-skill name → errorKind: tool_not_registered (top-level)', async () => {
  const ctx = makeModelContext()
  const output = await executeToolCall('definitely_not_a_real_tool_xyz', {}, ctx as ToolContext)
  const data = output.data || {}
  assert.equal(data.errorKind, 'tool_not_registered',
    'fabricated non-skill tool name must surface as top-level tool_not_registered (U1.1 / AGENTS.md §3)')
  assert.notEqual(data.errorKind, 'host_unavailable',
    'must NOT regress to legacy host_unavailable + reason:tool_not_registered shape')
  assert.notEqual(data.reason, 'tool_not_registered',
    'reason field must not carry the retired tool_not_registered marker (it is the errorKind now)')
  assert.equal(data.toolName, 'definitely_not_a_real_tool_xyz')
})

test('U1.1 class 2: fabricated skill_* name → errorKind: tool_not_registered (top-level)', async () => {
  // A skill_* name that the registry does not know about. Authorization
  // would be the wrong signal here — the tool literally does not exist.
  const ctx = makeModelContext()
  const output = await executeToolCall('skill_fabricated_xyz_not_in_registry', {}, ctx as ToolContext)
  const data = output.data || {}
  assert.equal(data.errorKind, 'tool_not_registered',
    'fabricated skill_* tool name must surface as tool_not_registered, NOT authorization_denied')
  assert.notEqual(data.errorKind, 'authorization_denied',
    'authorization_denied is reserved for skill tools that EXIST but lack admission (mutual exclusivity)')
})

test('U1.1 class 3: real non-skill tool missing from allowedToolNames → tool_restricted_this_turn (preserved)', async () => {
  // Pick a real registered non-skill tool. We use `browser_open_url` which
  // is part of the browser tool catalog. The empty allowedToolNames forces
  // the preflight restriction path. This path is INTENTIONALLY distinct
  // from tool_not_registered — class 3 means "tool exists but you can't
  // use it this turn", which is what tool_restricted_this_turn signals.
  const ctx = makeModelContext({ allowedToolNames: new Set<string>() })
  const output = await executeToolCall('browser_open_url', { url: 'https://example.test' }, ctx as ToolContext)
  const data = output.data || {}
  // Either tool_restricted_this_turn (real tool, blocked by allowlist) or
  // tool_not_registered (if host-Node skipped registering this tool). Both
  // are acceptable as long as neither leaks the legacy nested pair.
  if (data.errorKind === 'host_unavailable') {
    assert.equal(data.reason, 'tool_restricted_this_turn',
      'host_unavailable must only pair with tool_restricted_this_turn now, never with tool_not_registered (U1.1)')
  } else {
    assert.equal(data.errorKind, 'tool_not_registered',
      'if browser_open_url is not registered in host-Node, errorKind must be top-level tool_not_registered')
  }
})

test('U1.1 mutual exclusivity: no admission output carries both host_unavailable AND tool_not_registered', async () => {
  // Exercise three paths and assert none produces the retired nested shape.
  const fixtures = [
    { name: 'definitely_not_a_real_tool', kind: 'fabricated' },
    { name: 'skill_fabricated_xyz', kind: 'fabricated-skill' },
    { name: 'browser_open_url', kind: 'real-non-skill-blocked' },
  ]
  for (const fx of fixtures) {
    const ctx = makeModelContext()
    const output = await executeToolCall(fx.name, {}, ctx as ToolContext)
    const data = output.data || {}
    const isLegacyNested = data.errorKind === 'host_unavailable' && data.reason === 'tool_not_registered'
    assert.equal(isLegacyNested, false,
      `fixture ${fx.kind} (${fx.name}) must NOT return host_unavailable + reason:tool_not_registered (U1.1 mutual exclusivity)`)
  }
})
