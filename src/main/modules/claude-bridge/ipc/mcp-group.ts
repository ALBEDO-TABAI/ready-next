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

import {
  bootstrapMcpServersFromSettings,
  getMcpRuntimeStatus,
  MCP_SERVERS_SETTING_KEY,
  parseMcpServersConfig,
  reloadMcpServersFromSettings,
} from '../../mcp/bootstrap'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

export interface McpGroupDeps {
  getDatabase: () => {
    getSetting(key: string): string | undefined
    setSetting(key: string, value: string): void
  }
  log: (message: string) => void
}

const CHANNELS = ['mcp:status', 'mcp:saveConfig', 'mcp:reload'] as const

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
      const payload = (rawPayload || {}) as { json?: unknown }
      const json = typeof payload.json === 'string' ? payload.json : ''
      const trimmed = json.trim()
      const parsed = parseMcpServersConfig(trimmed)
      if (trimmed && parsed.configs.length === 0 && parsed.skipped.length > 0) {
        // 整份配置没有任何有效条目 —— 拒绝保存（防手滑清空），原因原样返回
        return {
          success: false,
          error: '配置里没有任何有效的 server 条目，未保存。',
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
        })
        return { success: true, outcomes }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
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
  })
}
