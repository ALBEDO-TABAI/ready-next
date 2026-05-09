/**
 * Stage T PR-T5 — MCP tool list is gated by `mcp.registry.isAuthorized`
 * with the 3-arity (toolName, sessionId, scopeId) contract.
 *
 * Round-1 (Codex) fix — a cached OAuth token alone is NOT sufficient.
 * Authorization requires BOTH (a) an explicit per-(session, scope, tool)
 * consent entry recorded via `authorizeMcpToolForScope`, AND (b) a
 * non-expired OAuth token cached for the server. Without (a), the same
 * device-wide token would leak the tool into every conversation scope.
 *
 * Behaviour we lock in:
 *   1. `isAuthorized` denies an unknown tool name.
 *   2. `isAuthorized` denies tools whose server requires auth and has no
 *      cached token + no explicit scope allowlist entry.
 *   3. Cached OAuth token alone (without scope consent) → DENY.
 *   4. Scope consent alone (without cached token) → DENY.
 *   5. Scope consent AND non-expired token together → allow.
 *   6. The tool-registry's mcp branch passes (sessionId, scopeId) into
 *      `isAuthorized`, so different scopes can disagree on visibility.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizeMcpToolForScope,
  isAuthorized,
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
}

test('isAuthorized: unknown tool → false', () => {
  reset()
  assert.equal(isAuthorized('mcp_unknown_tool', 'session-1', 'scope-1'), false)
})

test('isAuthorized: server requires auth, no token, no allowlist → false', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-a',
    toolNames: ['mcp_srv_a_search'],
    requiresAuthorization: true,
  })
  assert.equal(isAuthorized('mcp_srv_a_search', 'session-1', 'scope-1'), false)
})

test('isAuthorized: server doesn\'t require auth → true', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-public',
    toolNames: ['mcp_srv_public_ping'],
    requiresAuthorization: false,
  })
  assert.equal(isAuthorized('mcp_srv_public_ping', 'session-1', 'scope-1'), true)
})

test('isAuthorized: cached OAuth token alone (no scope consent) → false', () => {
  // Round-1 (Codex) — token alone must NOT authorize. The token is a
  // per-server credential; without an explicit (session, scope, tool)
  // consent entry, it would leak the tool into every conversation scope.
  reset()
  registerMcpServer({
    serverId: 'srv-b',
    toolNames: ['mcp_srv_b_query'],
    requiresAuthorization: true,
  })
  setCachedMcpOAuthToken('srv-b', {
    accessToken: 'tok-1',
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
  assert.equal(isAuthorized('mcp_srv_b_query', 'session-1', 'scope-1'), false)
})

test('isAuthorized: expired token + scope consent → false', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-c',
    toolNames: ['mcp_srv_c_run'],
    requiresAuthorization: true,
  })
  authorizeMcpToolForScope('srv-c', 'mcp_srv_c_run', 'session-1', 'scope-1')
  setCachedMcpOAuthToken('srv-c', {
    accessToken: 'tok-old',
    expiresAt: Date.now() - 1_000,
    scopes: ['read'],
  })
  assert.equal(isAuthorized('mcp_srv_c_run', 'session-1', 'scope-1'), false)
})

test('isAuthorized: scope consent alone (no token) → false', () => {
  // Round-1 (Codex) — consent recorded but the underlying server is no
  // longer authenticated → deny.
  reset()
  registerMcpServer({
    serverId: 'srv-d',
    toolNames: ['mcp_srv_d_action'],
    requiresAuthorization: true,
  })
  authorizeMcpToolForScope('srv-d', 'mcp_srv_d_action', 'session-1', 'scope-A')
  assert.equal(isAuthorized('mcp_srv_d_action', 'session-1', 'scope-A'), false)
})

test('isAuthorized: scope consent AND non-expired token → true', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-d2',
    toolNames: ['mcp_srv_d2_action'],
    requiresAuthorization: true,
  })
  setCachedMcpOAuthToken('srv-d2', {
    accessToken: 'tok-2',
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
  authorizeMcpToolForScope('srv-d2', 'mcp_srv_d2_action', 'session-1', 'scope-A')
  assert.equal(isAuthorized('mcp_srv_d2_action', 'session-1', 'scope-A'), true)
  // Different scope on same session → deny (no consent for scope-B even
  // though the same token is cached).
  assert.equal(isAuthorized('mcp_srv_d2_action', 'session-1', 'scope-B'), false)
  // Different session → deny.
  assert.equal(isAuthorized('mcp_srv_d2_action', 'session-2', 'scope-A'), false)
})

test('isAuthorized: 3-arity contract — sessionId AND scopeId both consulted', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-e',
    toolNames: ['mcp_srv_e_op'],
    requiresAuthorization: true,
  })
  setCachedMcpOAuthToken('srv-e', {
    accessToken: 'tok-e',
    expiresAt: Date.now() + 60_000,
    scopes: ['read'],
  })
  // Authorize only this tuple.
  authorizeMcpToolForScope('srv-e', 'mcp_srv_e_op', 'sess-X', 'scope-Y')
  // Exact match → true.
  assert.equal(isAuthorized('mcp_srv_e_op', 'sess-X', 'scope-Y'), true)
  // Same session, different scope → false (proves scopeId is consulted).
  assert.equal(isAuthorized('mcp_srv_e_op', 'sess-X', 'scope-Z'), false)
  // Different session, same scope → false (proves sessionId is consulted).
  assert.equal(isAuthorized('mcp_srv_e_op', 'sess-W', 'scope-Y'), false)
})

test('isAuthorized: undefined sessionId/scopeId still resolves (not throws)', () => {
  reset()
  registerMcpServer({
    serverId: 'srv-f',
    toolNames: ['mcp_srv_f_op'],
    requiresAuthorization: false,
  })
  // No-auth server: should be ok regardless of nullish ids.
  assert.equal(isAuthorized('mcp_srv_f_op', undefined, undefined), true)
})
