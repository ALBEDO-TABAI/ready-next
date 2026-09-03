/**
 * Ready-owned catalog for connected local stdio MCP servers.
 */

import { createHash } from 'node:crypto'
import type {
  McpListedResource,
  McpListedResourceTemplate,
  McpServerMetadata,
} from './client'

export type McpApprovalMode = 'always' | 'writes' | 'never'

/**
 * Phase M（2026-07-05）—— MCP 工具的治理提示（来自 server 的 tools/list
 * annotations）。确认闸的动态映射消费 readOnlyHint：外部工具声明只读才
 * 免确认，其余一律 M2 保守确认（静态表枚举不了外部工具名）。
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolCatalogEntry {
  /** Canonical `mcp_<server>_<action>` name（model 可见名）。 */
  name: string
  /** Server 侧原始工具名（tools/call 用它，不用 canonical 名）。 */
  remoteName: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: McpToolAnnotations
}

export interface McpServerRegistration {
  serverId: string
  /** Tools advertised by this server (canonical `mcp_<server>_<action>` names). */
  toolNames: string[]
  approvalMode: McpApprovalMode
  /** Phase M —— discovery 带回的完整目录（schema/annotations），按 canonical 名索引。 */
  toolCatalog?: Map<string, McpToolCatalogEntry>
  resources?: McpListedResource[]
  resourceTemplates?: McpListedResourceTemplate[]
  metadata?: McpServerMetadata
  catalogGeneration?: number
  catalogDigest?: string
}

const serverByTool = new Map<string, string>()
const servers = new Map<string, McpServerRegistration>()
let catalogGeneration = 0

function digestRegistration(registration: McpServerRegistration): string {
  return createHash('sha256').update(JSON.stringify({
    serverId: registration.serverId,
    approvalMode: registration.approvalMode,
    tools: [...(registration.toolCatalog?.values() || [])],
    resources: registration.resources || [],
    resourceTemplates: registration.resourceTemplates || [],
    metadata: registration.metadata || null,
  })).digest('hex')
}

export function registerMcpServer(registration: McpServerRegistration): void {
  if (new Set(registration.toolNames).size !== registration.toolNames.length) {
    throw new Error(`mcp_duplicate_canonical_tool:${registration.serverId}`)
  }
  for (const toolName of registration.toolNames) {
    const owner = serverByTool.get(toolName)
    if (owner && owner !== registration.serverId) {
      throw new Error(`mcp_cross_server_tool_collision:${toolName}`)
    }
  }
  const previous = servers.get(registration.serverId)
  for (const toolName of previous?.toolNames || []) serverByTool.delete(toolName)
  catalogGeneration += 1
  const next = {
    ...registration,
    catalogGeneration,
    catalogDigest: digestRegistration(registration),
  }
  servers.set(registration.serverId, next)
  for (const toolName of next.toolNames) {
    serverByTool.set(toolName, registration.serverId)
  }
}

/** Phase M —— canonical 名 → 目录条目（无 discovery 目录时返回 null）。 */
export function getMcpToolCatalogEntry(toolName: string): McpToolCatalogEntry | null {
  const serverId = serverByTool.get(toolName)
  if (!serverId) return null
  const server = servers.get(serverId)
  return server?.toolCatalog?.get(toolName) ?? null
}

/** Phase M —— 确认闸动态映射的读口（未知工具返回 null，调用方保守处理）。 */
export function getMcpToolAnnotations(toolName: string): McpToolAnnotations | null {
  return getMcpToolCatalogEntry(toolName)?.annotations ?? null
}

export function getMcpApprovalModeForTool(toolName: string): McpApprovalMode | null {
  const serverId = serverByTool.get(toolName)
  return serverId ? servers.get(serverId)?.approvalMode || null : null
}

export function getMcpCatalogSnapshot(): { generation: number; digest: string } {
  const entries = [...servers.values()].map((server) => ({
    serverId: server.serverId,
    generation: server.catalogGeneration,
    digest: server.catalogDigest,
  })).sort((left, right) => left.serverId.localeCompare(right.serverId))
  return {
    generation: catalogGeneration,
    digest: createHash('sha256').update(JSON.stringify({ generation: catalogGeneration, entries })).digest('hex'),
  }
}

export function listMcpServerRegistrations(): McpServerRegistration[] {
  return Array.from(servers.values())
}

export function getMcpServerRegistration(serverId: string): McpServerRegistration | null {
  return servers.get(serverId) || null
}

export function listMcpToolNames(): string[] {
  return Array.from(serverByTool.keys())
}

export function getMcpServerForTool(toolName: string): string | null {
  return serverByTool.get(toolName) || null
}

export function isMcpToolReady(toolName: string): boolean {
  const serverId = serverByTool.get(toolName)
  if (!serverId) return false
  return servers.has(serverId)
}

export const __breaksInvariants = [
  'singleton.mcp-server-registry.never-reset-mid-session',
] as const

/**
 * Phase M 管理面 —— "never-reset-mid-session" 不变量的唯一受控例外：
 * 用户在设置页显式触发的重载路径专用（见 bootstrap.reloadMcpServersFromSettings）。
 */
export function resetMcpServerRegistryForReload(): void {
  catalogGeneration += 1
  servers.clear()
  serverByTool.clear()
}

/** Test helper. */
export function __resetMcpRegistryForTests(): void {
  servers.clear()
  serverByTool.clear()
}
