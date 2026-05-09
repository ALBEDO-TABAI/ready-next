/**
 * Stage T PR-T5 — MCP tool schema discovery (placeholder).
 *
 * Plan v18 §6.2 — pulls the tool schema list from each registered
 * MCP server via the standard `tools/list` MCP method, normalises
 * to OpenAI / Anthropic tool schema shape, and feeds the result back
 * into `registry.registerMcpServer({ toolNames })`.
 *
 * For PR-T5 we ship the contract surface only; the live discovery
 * call lands in a follow-up. Today the registry is populated by
 * `registerMcpServer` directly (e.g. from settings / static config).
 */

import { type McpClient } from './client'
import { registerMcpServer } from './registry'

export interface DiscoveredMcpTool {
  /** Canonical tool name (`mcp_<server>_<action>`). */
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpToolDiscoveryResult {
  serverId: string
  tools: DiscoveredMcpTool[]
  error?: { kind: string; message: string }
}

/**
 * Pull the tool catalogue from one MCP server. Skeleton: returns an
 * empty result; gate `check-mcp-tools-go-through-authorization.cjs`
 * does not enforce wire calls, only registration shape.
 */
export async function discoverToolsFromServer(
  client: McpClient,
): Promise<McpToolDiscoveryResult> {
  return {
    serverId: client.serverId,
    tools: [],
    error: { kind: 'not_implemented', message: 'mcp.tool-discovery skeleton' },
  }
}

/**
 * Helper used by initial bootstrap: take a discovery result, register
 * the server with the registry so `isAuthorized` can resolve future
 * tool names.
 */
export function applyDiscoveryResult(
  result: McpToolDiscoveryResult,
  options?: { requiresAuthorization?: boolean },
): void {
  registerMcpServer({
    serverId: result.serverId,
    toolNames: result.tools.map((tool) => tool.name),
    requiresAuthorization: options?.requiresAuthorization ?? true,
  })
}
