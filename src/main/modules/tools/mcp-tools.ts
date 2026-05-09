/**
 * Stage T PR-T5 — MCP tool dispatcher.
 *
 * The model-visible MCP tool list is gated by `mcp/registry.isAuthorized`
 * (see `tool-registry.ts`). Once a `mcp_*` tool name is exposed AND the
 * model invokes it, dispatch routes here. We look up the owning server,
 * forward to the matching `McpClient.callTool`, and translate the
 * structured `McpToolCallResult` into a `ToolExecutionOutput` so the
 * model sees a uniform structured shape.
 */

import { ToolDomainError } from './tool-errors'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tool-result-types'
import { getMcpClient } from '../mcp/client'
import { getMcpServerForTool } from '../mcp/registry'

export interface McpToolContext {
  abortSignal?: AbortSignal
  sessionId?: string
  scopeId?: string
}

export async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<ToolExecutionOutput> {
  const serverId = getMcpServerForTool(toolName)
  if (!serverId) {
    throw new ToolDomainError('mcp_tool_unregistered', `MCP tool ${toolName} is not registered against any server`)
  }
  const client = getMcpClient(serverId)
  if (!client) {
    throw new ToolDomainError('mcp_client_missing', `No MCP client connected for server ${serverId}`, { serverId, toolName })
  }

  let result
  try {
    result = await client.callTool({
      toolName,
      arguments: args,
      signal: ctx.abortSignal,
    })
  } catch (err) {
    if (err instanceof ToolDomainError) throw err
    throw new ToolDomainError('mcp_tool_failed', err instanceof Error ? err.message : String(err), { serverId, toolName })
  }

  if (!result.ok) {
    const kind = result.error?.kind || 'mcp_tool_failed'
    const message = result.error?.message || `MCP tool ${toolName} returned a non-ok result`
    throw new ToolDomainError(kind, message, { serverId, toolName })
  }

  return createToolExecutionOutput(`mcp ok: ${serverId}/${toolName}`, {
    shape: 'json',
    data: {
      ok: true,
      serverId,
      toolName,
      output: (result.output ?? null) as unknown as Record<string, unknown> | null,
    },
  })
}
