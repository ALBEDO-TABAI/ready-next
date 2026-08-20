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
import type { AgentChannelRecord, AgentChannelType, DatabaseManager } from '../../database'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentChannelConfig, ChannelAdapterType, HeartbeatSnapshot } from '../contracts/types'
import {
  clearChannelCredentials,
  decryptChannelConfig,
  prepareChannelConfigUpdate,
  toPublicChannelConfig,
} from '../memory/secret-storage'
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

function channelCredentialOwner(id: string): string {
  return `channel:${id}`
}

const CHANNEL_CREDENTIAL_MIGRATION_SETTING = 'agent_channel_credential_migration_v1'
const CHANNEL_DELETE_PENDING_ERROR = 'channel_delete_pending'

function resolveChannelCredentialState(
  type: AgentChannelType,
  config: Record<string, unknown>,
  secretStatus: AgentChannelConfig['secretStatus'],
): AgentChannelConfig['credentialState'] {
  const states = Object.values(secretStatus).map((item) => item.state)
  if (states.includes('vault_unavailable')) return 'vault_unavailable'
  if (states.includes('recovery_required')) return 'recovery_required'
  if (type === 'telegram-bot') {
    return secretStatus.token?.state === 'ready' || secretStatus.botToken?.state === 'ready'
      ? 'ready'
      : 'missing'
  }
  if (type === 'feishu-app') {
    return typeof config.appId === 'string'
      && config.appId.trim()
      && secretStatus.appSecret?.state === 'ready'
      ? 'ready'
      : 'missing'
  }
  return 'ready'
}

export class ChannelConfigService {
  constructor(private readonly deps: ChannelConfigServiceDeps) {}

  listChannels(): AgentChannelConfig[] {
    const rows = this.deps.db.listAgentChannels()
    return rows.map((row) => this.mapChannelRow(row))
  }

  listRuntimeChannels(): AgentChannelConfig[] {
    return this.deps.db.listAgentChannels().map((row) => this.mapRuntimeChannelRow(row))
  }

  async migrateStoredCredentialsOnce(): Promise<{
    migrated: number
    unresolved: number
    alreadyDone: boolean
  }> {
    if (this.deps.db.getSetting(CHANNEL_CREDENTIAL_MIGRATION_SETTING)) {
      return { migrated: 0, unresolved: 0, alreadyDone: true }
    }
    let unresolved = 0
    for (const row of this.deps.db.listAgentChannels()) {
      const owner = channelCredentialOwner(row.id)
      const storedConfig = tryParseJson<Record<string, unknown>>(row.config_json, {})
      const status = toPublicChannelConfig(storedConfig, owner).secretStatus
      unresolved += Object.values(status).filter((item) => item.state === 'recovery_required').length
    }
    this.deps.db.setSetting(CHANNEL_CREDENTIAL_MIGRATION_SETTING, JSON.stringify({
      attemptedAt: new Date().toISOString(),
      migrated: 0,
      unresolved,
    }))
    return { migrated: 0, unresolved, alreadyDone: false }
  }

  isChannelTypeAvailable(type: AgentChannelType): boolean {
    const hasEnabledChannel = this.listChannels().some(
      (channel) => channel.type === type && channel.enabled && channel.credentialState === 'ready'
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
    const existing = this.deps.db.getAgentChannel(id)
    const previousConfig = existing
      ? tryParseJson<Record<string, unknown>>(existing.config_json, {})
      : {}
    const preparedConfig = await prepareChannelConfigUpdate(
      payload.config || {},
      channelCredentialOwner(id),
      previousConfig,
    )
    let row: AgentChannelRecord
    try {
      row = this.deps.db.upsertAgentChannel({
        id,
        type: payload.type as AgentChannelType,
        name: payload.name.trim() || id,
        enabled: payload.enabled ?? true,
        configJson: JSON.stringify(preparedConfig.config)
      })
    } catch (error) {
      await preparedConfig.rollback().catch(() => undefined)
      throw error
    }
    await preparedConfig.commit().catch(() => undefined)

    if (this.deps.sidecar.isRunning()) {
      const runtimeChannel = this.mapRuntimeChannelRow(row)
      if (runtimeChannel.credentialState !== 'ready') {
        await this.deps.sidecar.stopChannel(id).catch(() => undefined)
      } else {
        await this.deps.sidecar.upsertChannel({
          id,
          type: row.type,
          name: row.name,
          enabled: Boolean(row.enabled),
          config: runtimeChannel.config,
        })
        if (row.enabled) {
          await this.deps.sidecar.startChannel(id).catch(() => undefined)
        } else {
          await this.deps.sidecar.stopChannel(id).catch(() => undefined)
        }
      }
    }
    return this.mapChannelRow(row)
  }

  async deleteChannel(id: string): Promise<boolean> {
    const existing = this.deps.db.getAgentChannel(id)
    if (!existing) return false
    this.deps.db.setAgentChannelEnabled(id, false)
    this.deps.db.setAgentChannelError(id, CHANNEL_DELETE_PENDING_ERROR)
    return this.finishPendingDelete(id)
  }

  async reconcilePendingDeletes(): Promise<void> {
    const pending = this.deps.db.listAgentChannels().filter(
      (row) => row.last_error === CHANNEL_DELETE_PENDING_ERROR,
    )
    for (const row of pending) {
      await this.finishPendingDelete(row.id).catch(() => undefined)
    }
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<AgentChannelConfig | null> {
    const existing = this.deps.db.getAgentChannel(id)
    if (enabled && existing && this.mapChannelRow(existing).credentialState !== 'ready') {
      throw new Error('channel_credential_recovery_required')
    }
    const row = this.deps.db.setAgentChannelEnabled(id, enabled)
    if (!row) return null
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.upsertChannel({
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(
          tryParseJson<Record<string, unknown>>(row.config_json, {}),
          channelCredentialOwner(row.id),
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
    const channel = this.deps.db.getAgentChannel(id)
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
    if (!this.deps.db.getAgentChannel(channelId)) return
    if (result.success) {
      this.deps.db.setAgentChannelError(channelId, null)
      this.deps.db.markAgentChannelSeen(channelId)
      return
    }
    this.deps.db.setAgentChannelError(channelId, result.error || '远程 IM 发送失败')
  }

  async testChannel(payload: UpsertChannelPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    try {
      const config = this.resolveChannelTestConfig(payload)
      const response = await this.deps.sidecar.testChannel({
        id: payload.id || `temp-${randomUUID()}`,
        type: payload.type,
        name: payload.name,
        enabled: payload.enabled ?? true,
        config
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
    const existing = this.deps.db.getAgentChannel(id)
    const existingConfig = existing
      ? decryptChannelConfig(
          tryParseJson<Record<string, unknown>>(existing.config_json, {}),
          channelCredentialOwner(existing.id),
        )
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
    const projection = toPublicChannelConfig(
      tryParseJson<Record<string, unknown>>(row.config_json, {}),
      channelCredentialOwner(row.id),
    )
    return {
      id: row.id,
      type: row.type as ChannelAdapterType,
      name: row.name,
      enabled: Boolean(row.enabled),
      config: projection.config,
      credentialState: resolveChannelCredentialState(row.type, projection.config, projection.secretStatus),
      secretStatus: projection.secretStatus,
      lastError: row.last_error,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapRuntimeChannelRow(row: AgentChannelRecord): AgentChannelConfig {
    const storedConfig = tryParseJson<Record<string, unknown>>(row.config_json, {})
    return {
      ...this.mapChannelRow(row),
      config: decryptChannelConfig(storedConfig, channelCredentialOwner(row.id)),
    }
  }

  private resolveChannelTestConfig(payload: UpsertChannelPayload): Record<string, unknown> {
    const config = { ...(payload.config || {}) }
    for (const value of Object.values(config)) {
      if (
        typeof value === 'string'
        && (
          value.startsWith('__enc__')
          || value.startsWith('__plain__')
          || value.startsWith('__ready_credential_v1__')
        )
      ) {
        throw new Error('legacy_secret_requires_reentry')
      }
    }
    if (!payload.id) return config
    const existing = this.deps.db.getAgentChannel(payload.id)
    if (!existing) return config
    const owner = channelCredentialOwner(existing.id)
    const storedConfig = tryParseJson<Record<string, unknown>>(existing.config_json, {})
    const projection = toPublicChannelConfig(storedConfig, owner)
    const resolved = decryptChannelConfig(storedConfig, owner)
    for (const [key, status] of Object.entries(projection.secretStatus)) {
      if (key in config) continue
      if (status.state === 'recovery_required') {
        throw new Error('channel_credential_recovery_required')
      }
      if (status.state === 'vault_unavailable') {
        throw new Error('channel_credential_vault_unavailable')
      }
      if (status.state === 'ready') config[key] = resolved[key]
    }
    return config
  }

  private async finishPendingDelete(id: string): Promise<boolean> {
    const existing = this.deps.db.getAgentChannel(id)
    if (!existing) return true
    await clearChannelCredentials(
      tryParseJson<Record<string, unknown>>(existing.config_json, {}),
      channelCredentialOwner(id),
    )
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.stopChannel(id)
      const deleted = await this.deps.sidecar.deleteChannel(id)
      if (deleted.success === false) {
        throw new Error(String(deleted.error || CHANNEL_DELETE_PENDING_ERROR))
      }
    }
    return this.deps.db.deleteAgentChannel(id)
  }
}
