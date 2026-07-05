/**
 * Stage T PR-T5 占位 → Phase M（2026-07-05）tools/list 实装。
 *
 * Plan v18 §6.2 — pulls the tool schema list from each registered
 * MCP server via the standard `tools/list` MCP method, normalises
 * to canonical `mcp_<server>_<action>` entries（含 schema/annotations），
 * and feeds the result back into `registry.registerMcpServer`。
 *
 * 工具面预算（调研块 7 最小版）：每 server 硬上限 MAX_TOOLS_PER_SERVER，
 * 超限裁剪且必须留下可观测记录（no silent caps）——被裁名单进
 * `McpToolDiscoveryResult.dropped`，由调用方落日志/metric。
 */

import { type McpClient } from './client'
import { registerMcpServer, type McpToolCatalogEntry } from './registry'

/** 每 server 暴露给模型的工具数硬上限（外部 server 动辄几十工具）。 */
export const MAX_TOOLS_PER_SERVER = 24

export type DiscoveredMcpTool = McpToolCatalogEntry

export interface McpToolDiscoveryResult {
  serverId: string
  tools: DiscoveredMcpTool[]
  /** 超出每 server 上限被裁剪的 canonical 名（no silent caps）。 */
  dropped?: string[]
  error?: { kind: string; message: string }
}

/**
 * Pull the tool catalogue from one MCP server（Phase M：stdio 真连）。
 * 失败以结构化 error 返回（kind=discovery_failed），不抛——调用方决定
 * 该 server 是否降级为未注册。
 */
export async function discoverToolsFromServer(
  client: McpClient,
): Promise<McpToolDiscoveryResult> {
  try {
    const listed = await client.listTools()
    const kept = listed.slice(0, MAX_TOOLS_PER_SERVER)
    const dropped = listed.slice(MAX_TOOLS_PER_SERVER).map((tool) => tool.name)
    return {
      serverId: client.serverId,
      tools: kept.map((tool) => ({
        name: tool.name,
        remoteName: tool.remoteName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
      ...(dropped.length > 0 ? { dropped } : {}),
    }
  } catch (error) {
    return {
      serverId: client.serverId,
      tools: [],
      error: {
        kind: 'discovery_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Helper used by initial bootstrap: take a discovery result, register
 * the server with the registry so `isAuthorized` can resolve future
 * tool names.（Phase M：目录 schema/annotations 一并入注册表，确认闸
 * 动态映射与 model-visible schema 都从这里读。）
 */
export function applyDiscoveryResult(
  result: McpToolDiscoveryResult,
  options?: { requiresAuthorization?: boolean },
): void {
  registerMcpServer({
    serverId: result.serverId,
    toolNames: result.tools.map((tool) => tool.name),
    requiresAuthorization: options?.requiresAuthorization ?? true,
    toolCatalog: new Map(result.tools.map((tool) => [tool.name, tool])),
  })
}
