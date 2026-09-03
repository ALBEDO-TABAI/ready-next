/**
 * Phase M 管理面（2026-07-05）—— MCP 设置页 IPC group。
 *
 * 三个通道：
 *   - `mcp:status`      — 配置 + 注册表 + 最近装配结果三源状态（含 rawConfig 供编辑器回显）
 *   - `mcp:saveConfig`  — 校验并保存 `mcp_servers_json`（校验用主进程同一 parser，坏条目
 *                         逐条返回原因，绝不静默丢弃）；保存 ≠ 生效，生效走 reload
 *   - `mcp:reload`      — 关闭现有客户端 → 清注册表（受控例外）→ 按当前配置重连
 *
 * 遵循 IpcChannelGroup 形状（Stage V V2.0）：register 返回 dispose，dev reload 先摘再挂。
 */
import type { IpcMain } from 'electron'
import { createHash } from 'node:crypto'

import {
  bootstrapMcpServersFromSettings,
  getMcpRuntimeStatus,
  MCP_SERVERS_SETTING_KEY,
  parseMcpServersConfig,
  reloadMcpServersFromSettings,
} from '../../mcp/bootstrap'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'
import { getMcpClient } from '../../mcp/client'
import { getMcpServerRegistration } from '../../mcp/registry'

export interface McpGroupDeps {
  getDatabase: () => {
    getSetting(key: string): string | undefined
    setSetting(key: string, value: string): void
  }
  log: (message: string) => void
  dataRoot: string
}

const CHANNELS = [
  'mcp:status',
  'mcp:saveConfig',
  'mcp:reload',
  'mcp:listResources',
  'mcp:readResource',
] as const

export const mcpGroup: IpcChannelGroup<McpGroupDeps> = {
  namespace: 'mcp',

  register(ipcMain: IpcMain, deps: McpGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      ipcMain.removeHandler(channel)
    }

    ipcMain.handle('mcp:status', () => {
      return getMcpRuntimeStatus((key) => deps.getDatabase().getSetting(key))
    })

    ipcMain.handle('mcp:saveConfig', (_event, rawPayload: unknown) => {
      const payload = (rawPayload || {}) as { servers?: unknown }
      if (!Array.isArray(payload.servers)) {
        return { success: false, error: '配置必须是 server 列表。' }
      }
      const existing = parseMcpServersConfig(deps.getDatabase().getSetting(MCP_SERVERS_SETTING_KEY)).configs
      const existingEnv = new Map(existing.map((config) => [config.id, config.env || {}]))
      const normalized = payload.servers.map((raw) => {
        const server = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const id = String(server.id || '').trim()
        const envEntries = Array.isArray(server.envEntries) ? server.envEntries : []
        const env = Object.fromEntries(envEntries.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const value = entry as Record<string, unknown>
          const key = String(value.key || '').trim()
          if (!key) return []
          const explicit = typeof value.value === 'string' ? value.value : ''
          const stored = existingEnv.get(id)?.[key]
          return explicit ? [[key, explicit]] : stored !== undefined ? [[key, stored]] : []
        }))
        return {
          id,
          displayName: String(server.displayName || id).trim(),
          transport: 'stdio',
          command: String(server.command || '').trim(),
          args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [],
          enabled: server.enabled !== false,
          approvalMode: String(server.approvalMode || 'writes'),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        }
      })
      const trimmed = JSON.stringify(normalized)
      const parsed = parseMcpServersConfig(trimmed)
      if (normalized.length > 0 && parsed.configs.length !== normalized.length) {
        // 整份配置没有任何有效条目 —— 拒绝保存（防手滑清空），原因原样返回
        return {
          success: false,
          error: '有 server 配置不完整，未保存。',
          skipped: parsed.skipped.map((item) => ({ reason: item.reason })),
        }
      }
      try {
        deps.getDatabase().setSetting(MCP_SERVERS_SETTING_KEY, trimmed)
      } catch (error) {
        return {
          success: false,
          error: `保存失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      return {
        success: true,
        configuredCount: parsed.configs.length,
        skipped: parsed.skipped.map((item) => ({ reason: item.reason })),
      }
    })

    ipcMain.handle('mcp:reload', async () => {
      try {
        const outcomes = await reloadMcpServersFromSettings({
          getSetting: (key) => deps.getDatabase().getSetting(key),
          log: deps.log,
          dataRoot: deps.dataRoot,
        })
        return { success: true, outcomes }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })

    ipcMain.handle('mcp:listResources', (_event, payload: { serverId?: unknown }) => {
      const serverId = String(payload?.serverId || '').trim()
      const registration = getMcpServerRegistration(serverId)
      if (!registration) return { success: false, error: 'mcp_server_not_ready' }
      return {
        success: true,
        data: {
          serverId,
          catalogGeneration: registration.catalogGeneration,
          catalogDigest: registration.catalogDigest,
          resources: registration.resources || [],
          resourceTemplates: registration.resourceTemplates || [],
        },
      }
    })

    ipcMain.handle('mcp:readResource', async (_event, payload: {
      serverId?: unknown
      uri?: unknown
      catalogGeneration?: unknown
    }) => {
      const serverId = String(payload?.serverId || '').trim()
      const uri = String(payload?.uri || '').trim()
      const registration = getMcpServerRegistration(serverId)
      if (!registration
        || registration.catalogGeneration !== payload?.catalogGeneration
        || !registration.resources?.some((resource) => resource.uri === uri)) {
        return { success: false, error: 'mcp_resource_identity_mismatch' }
      }
      const client = getMcpClient(serverId)
      if (!client) return { success: false, error: 'mcp_client_not_connected' }
      try {
        const content = await client.readResource(uri)
        return {
          success: true,
          data: {
            serverId,
            uri,
            catalogGeneration: registration.catalogGeneration,
            catalogDigest: registration.catalogDigest,
            content,
            contentDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
          },
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    let disposed = false
    return {
      dispose() {
        if (disposed) return
        disposed = true
        for (const channel of CHANNELS) {
          ipcMain.removeHandler(channel)
        }
      },
    }
  },
}

/** 首次装配复用同一 deps 形状（setupAgentIPC 的 boot 段调用）。 */
export async function runMcpBoot(deps: McpGroupDeps): Promise<void> {
  await bootstrapMcpServersFromSettings({
    getSetting: (key) => deps.getDatabase().getSetting(key),
    log: deps.log,
    dataRoot: deps.dataRoot,
  })
}
