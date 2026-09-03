/**
 * Stage T PR-T5 — MCP tool dispatcher.
 *
 * The model-visible MCP tool list is gated by `mcp/registry.isMcpToolReady`
 * (see `tool-registry.ts`). Once a `mcp_*` tool name is exposed AND the
 * model invokes it, dispatch routes here. We look up the owning server,
 * forward to the matching `McpClient.callTool`, and translate the
 * structured `McpToolCallResult` into a `ToolExecutionOutput` so the
 * model sees a uniform structured shape.
 */

import { ToolDomainError } from './tool-errors'
import { MCP_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { getMcpClient } from '../mcp/client'
import { getMcpServerForTool, isMcpToolReady } from '../mcp/registry'

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
    throw new ToolDomainError(
      MCP_TOOL_ERROR_KINDS.toolUnregistered.code,
      `MCP tool ${toolName} is not registered against any server`,
    )
  }
  // Recheck the connected catalog at execution time so a stale prepared
  // surface cannot call a server that has since been removed.
  if (!isMcpToolReady(toolName)) {
    throw new ToolDomainError(
      MCP_TOOL_ERROR_KINDS.toolUnregistered.code,
      `MCP tool ${toolName} is no longer registered`,
      { serverId, toolName, sessionId: ctx.sessionId, scopeId: ctx.scopeId },
    )
  }
  const client = getMcpClient(serverId)
  if (!client) {
    throw new ToolDomainError(
      MCP_TOOL_ERROR_KINDS.clientMissing.code,
      `No MCP client connected for server ${serverId}`,
      { serverId, toolName },
    )
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
    throw new ToolDomainError(
      MCP_TOOL_ERROR_KINDS.toolFailed.code,
      err instanceof Error ? err.message : String(err),
      { serverId, toolName },
    )
  }

  if (!result.ok) {
    const kind = result.error?.kind || MCP_TOOL_ERROR_KINDS.toolFailed.code
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
