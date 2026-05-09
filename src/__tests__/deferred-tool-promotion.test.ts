/**
 * Stage T PR-T5 — deferred MCP tool promotion goes through `isAuthorized`
 * AND resets at turn end.
 *
 * Behaviour we lock in:
 *   1. Marking a tool active does NOT bypass authorization — promote()
 *      filters out any tool that fails `isAuthorized`.
 *   2. Active set persists across promote() calls within the same turn.
 *   3. `reset()` clears the active set so the next turn starts cold.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deferredRegistry,
  markDeferredToolActive,
} from '../main/modules/mcp/deferred-filter'
import {
  authorizeMcpToolForScope,
  registerMcpServer,
  __resetMcpRegistryForTests,
} from '../main/modules/mcp/registry'
import {
  setCachedMcpOAuthToken,
  __resetMcpOAuthForTests,
} from '../main/modules/mcp/oauth'

function reset() {
  __resetMcpRegistryForTests()
  __resetMcpOAuthForTests()
  deferredRegistry.reset()
}

// Round-1 (Codex) — `isAuthorized` now requires BOTH (session, scope) consent
// AND a non-expired cached OAuth token. Helper to seed the latter so the
// behaviour under test (deferred-tool promotion + scope-based filtering)
// stays the same.
function seedToken(serverId: string): void {
  setCachedMcpOAuthToken(serverId, {
    accessToken: `tok-${serverId}`,
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
}

test('promoteActive: only authorized tools are promoted', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-1',
    toolNames: ['mcp_srv_1_a', 'mcp_srv_1_b'],
    requiresAuthorization: true,
  })
  seedToken('srv-1')
  // Authorize only the first tool for (session, scope).
  authorizeMcpToolForScope('srv-1', 'mcp_srv_1_a', 'sess-1', 'scope-1')
  markDeferredToolActive('mcp_srv_1_a')
  markDeferredToolActive('mcp_srv_1_b')
  const promoted = deferredRegistry.promoteActive({
    sessionId: 'sess-1',
    scopeId: 'scope-1',
  })
  assert.deepEqual(promoted, ['mcp_srv_1_a'])
})

test('promoteActive: unknown tools are filtered out (never bypass auth)', () => {
  reset()
  // No registered server → name unknown.
  markDeferredToolActive('mcp_ghost_tool')
  const promoted = deferredRegistry.promoteActive({
    sessionId: 'sess-1',
    scopeId: 'scope-1',
  })
  assert.deepEqual(promoted, [])
})

test('promoteActive: different (sessionId, scopeId) tuples see different sets', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-2',
    toolNames: ['mcp_srv_2_x'],
    requiresAuthorization: true,
  })
  seedToken('srv-2')
  authorizeMcpToolForScope('srv-2', 'mcp_srv_2_x', 'sess-A', 'scope-A')
  markDeferredToolActive('mcp_srv_2_x')
  // Authorized tuple → tool surfaces.
  assert.deepEqual(
    deferredRegistry.promoteActive({ sessionId: 'sess-A', scopeId: 'scope-A' }),
    ['mcp_srv_2_x'],
  )
  // Different tuple → filtered out.
  assert.deepEqual(
    deferredRegistry.promoteActive({ sessionId: 'sess-A', scopeId: 'scope-B' }),
    [],
  )
})

test('reset: clears active set so next turn starts cold', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-3',
    toolNames: ['mcp_srv_3_op'],
    requiresAuthorization: false,
  })
  markDeferredToolActive('mcp_srv_3_op')
  assert.deepEqual(deferredRegistry.listActive(), ['mcp_srv_3_op'])
  deferredRegistry.reset()
  assert.deepEqual(deferredRegistry.listActive(), [])
  // Promote after reset returns empty.
  assert.deepEqual(
    deferredRegistry.promoteActive({ sessionId: 'sess-1', scopeId: 'scope-1' }),
    [],
  )
})

test('reset is idempotent (calling twice is safe)', () => {
  reset()
  deferredRegistry.reset()
  deferredRegistry.reset()
  assert.deepEqual(deferredRegistry.listActive(), [])
})
