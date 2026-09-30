import type { AgentChannelRecord, AgentChannelType } from '../../database/records'
// B8-D R3 — ChannelConfigService: remote-IM channel config CRUD (encrypted
// config rows mirrored to sidecar adapters while it is running), availability
// probing, delivery-result bookkeeping, connection tests, and the WeChat
// login handshake, extracted from AgentControlRuntime (runtime.ts) as a
// delegated sub-service. Method bodies are mechanical moves; the only
// substitutions are `this.db` / `this.sidecar` → `this.deps.*`, the runtime
// lifecycle call `this.startSidecar()` becoming the injected `startSidecar`
// callback, and `this.heartbeat.adapters` becoming the injected runtime-owned
// heartbeat snapshot (mutated in place by the poll loop, never reassigned).
// The service owns no state — `channelStateCache` was verified to be owned by
// the lifecycle (`getRuntimeStatus`) + sidecar-poll clusters, not this one,
// and stays on the runtime. `mapChannelRow` is public here (was private on
// the runtime) because `ensureChannelScope` (conversation-scope cluster,
// stays on the runtime) also maps channel rows.
import { randomUUID } from 'crypto'
import type { DatabaseManager } from '../../database'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentChannelConfig, ChannelAdapterType, HeartbeatSnapshot } from '../contracts/types'
import { decryptChannelConfig, encryptChannelConfig } from '../memory/secret-storage'
import { normalizeChannelDeliveryResult } from './channel-delivery-result'
import { tryParseJson, type UpsertChannelPayload } from './runtime-helpers'

export interface ChannelConfigServiceDeps {
  db: DatabaseManager
  sidecar: SidecarManager
  /** Bound to the runtime lifecycle `startSidecar()` — probe/test/WeChat-login
   *  flows lazily boot the sidecar before talking to it. */
  startSidecar: () => Promise<void>
  /** Runtime-owned heartbeat snapshot. The runtime poll loop replaces
   *  `heartbeat.adapters` in place; the object itself is never reassigned, so
   *  holding the reference keeps `isChannelTypeAvailable` reads live. */
  heartbeat: HeartbeatSnapshot
}

export class ChannelConfigService {
  constructor(private readonly deps: ChannelConfigServiceDeps) {}

  listChannels(): AgentChannelConfig[] {
    const rows = this.deps.db.channels.listAgentChannels()
    return rows.map((row) => this.mapChannelRow(row))
  }

  isChannelTypeAvailable(type: AgentChannelType): boolean {
    const hasEnabledChannel = this.listChannels().some(
      (channel) => channel.type === type && channel.enabled
    )
    if (!hasEnabledChannel) return false

    const heartbeatAdapter = this.deps.heartbeat.adapters.find((adapter) => adapter.type === type)
    if (!heartbeatAdapter) return true
    return (
      heartbeatAdapter.healthy &&
      heartbeatAdapter.status !== 'error' &&
      heartbeatAdapter.status !== 'stopped'
    )
  }

  async upsertChannel(payload: UpsertChannelPayload): Promise<AgentChannelConfig> {
    const id = payload.id || `channel-${randomUUID()}`
    const encryptedConfig = encryptChannelConfig(payload.config || {})
    const row = this.deps.db.channels.upsertAgentChannel({
      id,
      type: payload.type as AgentChannelType,
      name: payload.name.trim() || id,
      enabled: payload.enabled ?? true,
      configJson: JSON.stringify(encryptedConfig)
    })

    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.upsertChannel({
        id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(encryptedConfig)
      })
      if (row.enabled) {
        await this.deps.sidecar.startChannel(id).catch(() => undefined)
      } else {
        await this.deps.sidecar.stopChannel(id).catch(() => undefined)
      }
    }
    return this.mapChannelRow(row)
  }

  async deleteChannel(id: string): Promise<boolean> {
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.stopChannel(id).catch(() => undefined)
      await this.deps.sidecar.deleteChannel(id).catch(() => undefined)
    }
    return this.deps.db.channels.deleteAgentChannel(id)
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<AgentChannelConfig | null> {
    const row = this.deps.db.channels.setAgentChannelEnabled(id, enabled)
    if (!row) return null
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.upsertChannel({
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(
          tryParseJson<Record<string, unknown>>(row.config_json, {})
        )
      })
      if (enabled) {
        await this.deps.sidecar.startChannel(id).catch(() => undefined)
      } else {
        await this.deps.sidecar.stopChannel(id).catch(() => undefined)
      }
    }
    return this.mapChannelRow(row)
  }

  async sendChannelProbe(id: string, text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    const channel = this.deps.db.channels.getAgentChannel(id)
    if (!channel) return { success: false, error: `Channel not found: ${id}` }
    try {
      const response = await this.deps.sidecar.sendChannel({
        id,
        text: text.trim() || 'Ready 连接测试成功'
      })
      const result = normalizeChannelDeliveryResult(response, '远程 IM 连接测试发送失败')
      this.recordChannelDeliveryResult(id, result)
      return result
    } catch (error) {
      // silent-catch: probe errors are returned to the caller and persisted on the channel row.
      const result = { success: false, error: error instanceof Error ? error.message : String(error) }
      this.recordChannelDeliveryResult(id, result)
      return result
    }
  }

  recordChannelDeliveryResult(
    channelId: string,
    result: { success: boolean; error?: string }
  ): void {
    if (!this.deps.db.channels.getAgentChannel(channelId)) return
    if (result.success) {
      this.deps.db.channels.setAgentChannelError(channelId, null)
      this.deps.db.channels.markAgentChannelSeen(channelId)
      return
    }
    this.deps.db.channels.setAgentChannelError(channelId, result.error || '远程 IM 发送失败')
  }

  async testChannel(payload: UpsertChannelPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    try {
      const response = await this.deps.sidecar.testChannel({
        id: payload.id || `temp-${randomUUID()}`,
        type: payload.type,
        name: payload.name,
        enabled: payload.enabled ?? true,
        config: payload.config || {}
      })
      if (response.success === false) {
        return { success: false, error: String(response.error || 'channel test failed') }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async startWechatLogin(payload: {
    id?: string
    force?: boolean
  }): Promise<Record<string, unknown>> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    const id = payload.id || 'channel-wechat-openclaw-default'
    const existing = this.deps.db.channels.getAgentChannel(id)
    const existingConfig = existing
      ? decryptChannelConfig(tryParseJson<Record<string, unknown>>(existing.config_json, {}))
      : {}
    const config: Record<string, unknown> = {
      ...existingConfig,
    }
    delete config.defaultTarget
    await this.deps.sidecar.upsertChannel({
      id,
      type: 'wechat-openclaw',
      name: existing?.name || '微信',
      enabled: false,
      config,
    })
    return this.deps.sidecar.startWechatLogin(id, payload.force ?? true)
  }

  async getWechatLoginStatus(channelId: string, sessionKey: string): Promise<Record<string, unknown>> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    return this.deps.sidecar.getWechatLoginStatus(channelId, sessionKey)
  }

  async submitWechatLoginVerifyCode(channelId: string, sessionKey: string, code: string): Promise<Record<string, unknown>> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    return this.deps.sidecar.submitWechatLoginVerifyCode(channelId, sessionKey, code)
  }

  mapChannelRow(row: AgentChannelRecord): AgentChannelConfig {
    return {
      id: row.id,
      type: row.type as ChannelAdapterType,
      name: row.name,
      enabled: Boolean(row.enabled),
      config: decryptChannelConfig(tryParseJson<Record<string, unknown>>(row.config_json, {})),
      lastError: row.last_error,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
