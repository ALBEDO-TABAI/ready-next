/**
 * Stage T PR-T5 — MCP server registry + per-(session, scope) authorization.
 *
 * Plan v18 §6.2 + §6.5 — tools advertised by MCP servers are gated by
 * `isAuthorized(toolName, sessionId, scopeId)`. The model-visible tool
 * list resolver in `tool-registry.ts` calls this gate before exposing
 * any `mcp_*` tool to the model. The 3-arity (toolName + sessionId +
 * scopeId) is the contract enforced by
 * `check-mcp-tools-go-through-authorization.cjs`.
 */

import { getCachedMcpOAuthToken } from './oauth'

export interface McpServerRegistration {
  serverId: string
  /** Tools advertised by this server (canonical `mcp_<server>_<action>` names). */
  toolNames: string[]
  /** When true, every advertised tool requires OAuth before being exposed. */
  requiresAuthorization: boolean
  /**
   * Optional explicit per-(session, scope) allow list. When omitted,
   * the registry falls back to "OAuth token cached for serverId" as
   * the authorization signal.
   */
  scopedAllowlist?: Map<string, Set<string>>
}

const serverByTool = new Map<string, string>()
const servers = new Map<string, McpServerRegistration>()

export function registerMcpServer(registration: McpServerRegistration): void {
  servers.set(registration.serverId, registration)
  for (const toolName of registration.toolNames) {
    serverByTool.set(toolName, registration.serverId)
  }
}

export function listMcpServerRegistrations(): McpServerRegistration[] {
  return Array.from(servers.values())
}

export function listMcpToolNames(): string[] {
  return Array.from(serverByTool.keys())
}

export function getMcpServerForTool(toolName: string): string | null {
  return serverByTool.get(toolName) || null
}

function scopeKey(sessionId: string | undefined, scopeId: string | undefined): string {
  return `${sessionId || ''}::${scopeId || ''}`
}

/**
 * Gate enforced by `tool-registry.ts` model-visible list resolver +
 * tool-executor admission. Returns `true` only when:
 *   1. The tool is registered against an MCP server, AND
 *   2. (a) the server doesn't require auth, OR
 *      (b) the (session, scope) tuple has an allowed entry AND a
 *          non-expired OAuth token is cached for the server.
 *
 * The 3-arity signature is mandatory — `check-mcp-tools-go-through-
 * authorization.cjs` (D) requires `(toolName, sessionId, scopeId)`.
 *
 * Round-1 (Codex) fix — a cached OAuth token alone is NOT sufficient
 * authorization. A token is a per-server credential; without an explicit
 * `(sessionId, scopeId, toolName)` consent entry, the same token would
 * leak the tool into every conversation scope on the device. The gate
 * now requires both signals: the user has consented for THIS scope AND
 * the underlying OAuth token is still valid.
 */
export function isAuthorized(
  toolName: string,
  sessionId: string | undefined,
  scopeId: string | undefined,
): boolean {
  const serverId = serverByTool.get(toolName)
  if (!serverId) return false
  const server = servers.get(serverId)
  if (!server) return false
  if (!server.requiresAuthorization) return true

  // Per-(session, scope, tool) consent must be recorded explicitly via
  // `authorizeMcpToolForScope`. No allowlist or no entry → deny, even
  // if the server has a cached OAuth token from a different scope.
  const allowlist = server.scopedAllowlist
  if (!allowlist) return false
  const key = scopeKey(sessionId, scopeId)
  const entry = allowlist.get(key)
  if (!entry || !entry.has(toolName)) return false

  // Consent is recorded — the OAuth token must still be valid.
  const token = getCachedMcpOAuthToken(serverId)
  if (token && token.expiresAt > Date.now()) return true
  return false
}

/**
 * Authorize a specific (session, scope, tool) tuple. Used by the UI
 * when the user explicitly allows an MCP server / tool for a
 * conversation scope.
 */
export function authorizeMcpToolForScope(
  serverId: string,
  toolName: string,
  sessionId: string | undefined,
  scopeId: string | undefined,
): void {
  const server = servers.get(serverId)
  if (!server) return
  const allowlist = server.scopedAllowlist || new Map<string, Set<string>>()
  const key = scopeKey(sessionId, scopeId)
  const entry = allowlist.get(key) || new Set<string>()
  entry.add(toolName)
  allowlist.set(key, entry)
  server.scopedAllowlist = allowlist
}

export const __breaksInvariants = [
  'singleton.mcp-server-registry.never-reset-mid-session',
] as const

/** Test helper. */
export function __resetMcpRegistryForTests(): void {
  servers.clear()
  serverByTool.clear()
}
