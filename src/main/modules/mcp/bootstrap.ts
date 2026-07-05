/**
 * Phase M（2026-07-05）—— MCP 启动装配点（调研块 3：此前注册/发现全家
 * 生产代码零调用，registry 恒空）。
 *
 * 配置来源：settings 键 `mcp_servers_json`——JSON 数组：
 *   [{ "id": "filesystem", "transport": "stdio", "command": "npx",
 *      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *      "env": {...}, "enabled": true, "requiresAuthorization": false }]
 *
 * 装配链：config → new McpClient → discoverToolsFromServer →
 * applyDiscoveryResult + registerMcpClient。逐 server 容错：单个失败记
 * 结果不炸启动；被预算裁剪的工具名必须落日志（no silent caps）。
 * stdio 之外的 transport 本阶段跳过（websocket/OAuth 属第二阶段）。
 */

import { McpClient } from './client'
import {
  listMcpClients,
  registerMcpClient,
  resetMcpClientRegistryForReload,
} from './client'
import {
  listMcpServerRegistrations,
  resetMcpServerRegistryForReload,
} from './registry'
import { applyDiscoveryResult, discoverToolsFromServer } from './tool-discovery'

export interface McpServerConfig {
  id: string
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
  /** stdio 本地 server 默认免 OAuth（server-filesystem 路径）；显式 true 才要求。 */
  requiresAuthorization: boolean
}

export interface McpConfigParseResult {
  configs: McpServerConfig[]
  /** 被跳过的原始条目与原因（可观测，不静默）。 */
  skipped: Array<{ raw: unknown; reason: string }>
}

/** settings JSON → 校验后的 server 配置；坏条目逐条跳过并留原因。 */
export function parseMcpServersConfig(raw: string | null | undefined): McpConfigParseResult {
  const skipped: Array<{ raw: unknown; reason: string }> = []
  const text = String(raw || '').trim()
  if (!text) return { configs: [], skipped }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      configs: [],
      skipped: [{ raw: text.slice(0, 120), reason: `invalid_json: ${error instanceof Error ? error.message : String(error)}` }],
    }
  }
  if (!Array.isArray(parsed)) {
    return { configs: [], skipped: [{ raw: parsed, reason: 'not_an_array' }] }
  }
  const configs: McpServerConfig[] = []
  const seenIds = new Set<string>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      skipped.push({ raw: entry, reason: 'not_an_object' })
      continue
    }
    const e = entry as Record<string, unknown>
    const id = String(e.id || '').trim()
    if (!id) {
      skipped.push({ raw: entry, reason: 'missing_id' })
      continue
    }
    if (seenIds.has(id)) {
      skipped.push({ raw: entry, reason: `duplicate_id: ${id}` })
      continue
    }
    const transport = String(e.transport || 'stdio')
    if (transport !== 'stdio') {
      skipped.push({ raw: entry, reason: `unsupported_transport_phase_m: ${transport}` })
      continue
    }
    const command = String(e.command || '').trim()
    if (!command) {
      skipped.push({ raw: entry, reason: 'missing_command' })
      continue
    }
    const args = Array.isArray(e.args) ? e.args.map((a) => String(a)) : []
    const env = e.env && typeof e.env === 'object' && !Array.isArray(e.env)
      ? Object.fromEntries(Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined
    seenIds.add(id)
    configs.push({
      id,
      transport: 'stdio',
      command,
      args,
      ...(env ? { env } : {}),
      enabled: e.enabled !== false,
      requiresAuthorization: e.requiresAuthorization === true,
    })
  }
  return { configs, skipped }
}

export interface McpBootstrapServerOutcome {
  serverId: string
  ok: boolean
  toolCount: number
  dropped: string[]
  error?: string
}

export interface McpBootstrapDeps {
  /** settings 读口（生产接 DatabaseManager.getSetting）。 */
  getSetting: (key: string) => string | null | undefined
  log?: (line: string) => void
  /** 测试注入：替换真实 client 构造（默认 new McpClient + registerMcpClient）。 */
  connectAndDiscover?: (config: McpServerConfig) => Promise<{
    tools: number
    dropped: string[]
  }>
}

export const MCP_SERVERS_SETTING_KEY = 'mcp_servers_json'

async function defaultConnectAndDiscover(config: McpServerConfig): Promise<{ tools: number; dropped: string[] }> {
  const client = new McpClient({
    serverId: config.id,
    transport: 'stdio',
    endpoint: config.command,
    args: config.args,
    env: config.env,
    requiresAuthorization: config.requiresAuthorization,
  })
  const discovery = await discoverToolsFromServer(client)
  if (discovery.error) {
    await client.close().catch(() => undefined)
    throw new Error(`${discovery.error.kind}: ${discovery.error.message}`)
  }
  applyDiscoveryResult(discovery, { requiresAuthorization: config.requiresAuthorization })
  registerMcpClient(client)
  return { tools: discovery.tools.length, dropped: discovery.dropped ?? [] }
}

/** 最近一次装配/重载的逐 server 结果（设置页状态面读口）。 */
let lastBootstrapOutcomes: McpBootstrapServerOutcome[] = []

export function getLastMcpBootstrapOutcomes(): McpBootstrapServerOutcome[] {
  return lastBootstrapOutcomes
}

/**
 * 启动装配入口（setupAgentIPC 一次性调用；幂等由调用方 module flag 保证）。
 * 永不 throw：逐 server 结果收集返回，失败/裁剪都可观测。
 */
export async function bootstrapMcpServersFromSettings(
  deps: McpBootstrapDeps,
): Promise<McpBootstrapServerOutcome[]> {
  const log = deps.log ?? (() => {})
  let rawSetting: string | null | undefined = null
  try {
    rawSetting = deps.getSetting(MCP_SERVERS_SETTING_KEY)
  } catch (error) {
    log(`mcp bootstrap: settings read failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const { configs, skipped } = parseMcpServersConfig(rawSetting)
  for (const skip of skipped) {
    log(`mcp bootstrap: skipped config entry (${skip.reason})`)
  }
  const outcomes: McpBootstrapServerOutcome[] = []
  const connect = deps.connectAndDiscover ?? defaultConnectAndDiscover
  for (const config of configs) {
    if (!config.enabled) {
      log(`mcp bootstrap: server ${config.id} disabled — skipped`)
      continue
    }
    try {
      const result = await connect(config)
      if (result.dropped.length > 0) {
        // no silent caps —— 被预算裁剪的工具必须可观测
        log(`mcp bootstrap: server ${config.id} tool cap dropped ${result.dropped.length}: ${result.dropped.join(', ')}`)
      }
      log(`mcp bootstrap: server ${config.id} registered with ${result.tools} tool(s)`)
      outcomes.push({ serverId: config.id, ok: true, toolCount: result.tools, dropped: result.dropped })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`mcp bootstrap: server ${config.id} failed: ${message}`)
      outcomes.push({ serverId: config.id, ok: false, toolCount: 0, dropped: [], error: message })
    }
  }
  lastBootstrapOutcomes = outcomes
  return outcomes
}

/**
 * 设置页驱动的重载（Phase M 管理面）：关闭全部 stdio 客户端、清空注册表、
 * 按当前 settings 重新装配。这是"mid-session 不重置"不变量的**唯一受控
 * 例外**——由用户在设置页显式点击触发，工具面变化对下一个 run 生效。
 */
export async function reloadMcpServersFromSettings(
  deps: McpBootstrapDeps,
): Promise<McpBootstrapServerOutcome[]> {
  const log = deps.log ?? (() => {})
  for (const client of listMcpClients()) {
    await client.close().catch((error) => {
      log(`mcp reload: close ${client.serverId} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  resetMcpClientRegistryForReload()
  resetMcpServerRegistryForReload()
  return bootstrapMcpServersFromSettings(deps)
}

export interface McpRuntimeServerStatus {
  serverId: string
  toolCount: number
  toolNames: string[]
  requiresAuthorization: boolean
  clientConnected: boolean
  lastError?: string
}

export interface McpRuntimeStatus {
  rawConfig: string
  configuredCount: number
  skipped: Array<{ reason: string }>
  servers: McpRuntimeServerStatus[]
}

/** 设置页状态读口：配置 + 注册表 + 最近装配结果三源合一。 */
export function getMcpRuntimeStatus(getSetting: (key: string) => string | null | undefined): McpRuntimeStatus {
  let raw = ''
  try {
    raw = String(getSetting(MCP_SERVERS_SETTING_KEY) || '')
  } catch {
    // silent-catch: settings 读取失败按空配置展示，状态面仍可用
    raw = ''
  }
  const { configs, skipped } = parseMcpServersConfig(raw)
  const registrations = new Map(listMcpServerRegistrations().map((item) => [item.serverId, item]))
  const clients = new Set(listMcpClients().map((client) => client.serverId))
  const outcomes = new Map(lastBootstrapOutcomes.map((item) => [item.serverId, item]))
  const servers: McpRuntimeServerStatus[] = configs.map((config) => {
    const registration = registrations.get(config.id)
    const outcome = outcomes.get(config.id)
    return {
      serverId: config.id,
      toolCount: registration?.toolNames.length ?? 0,
      toolNames: (registration?.toolNames ?? []).slice(0, 6),
      requiresAuthorization: registration?.requiresAuthorization ?? config.requiresAuthorization,
      clientConnected: clients.has(config.id),
      ...(outcome && !outcome.ok && outcome.error ? { lastError: outcome.error } : {}),
      ...(config.enabled ? {} : { lastError: '已禁用（enabled=false）' }),
    }
  })
  return {
    rawConfig: raw,
    configuredCount: configs.length,
    skipped: skipped.map((item) => ({ reason: item.reason })),
    servers,
  }
}
