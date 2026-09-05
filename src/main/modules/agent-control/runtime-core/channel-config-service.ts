// Owns persisted remote-channel configuration and binding state. All adapter
// changes share one per-channel queue and read the latest committed settings.
import { createHash, randomInt, randomUUID } from 'crypto'
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

type WechatLoginState = {
  sessionKey: string | null
  status: 'pending' | 'connected' | 'error'
  error?: string
  accountId?: string
  userId?: string
  bindingId?: string
}

export class ChannelConfigService {
  private readonly channelMirrors = new Map<string, Promise<unknown>>()
  private readonly mutationGenerations = new Map<string, number>()
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

    const readyIds = new Set(this.listChannels().filter(channel => channel.type === type && channel.enabled && channel.credentialState === 'ready').map(channel => channel.id))
    const heartbeatAdapter = this.deps.heartbeat.adapters.find((adapter) => readyIds.has(adapter.id) && adapter.healthy)
    if (!heartbeatAdapter) return false
    return (
      heartbeatAdapter.healthy &&
      heartbeatAdapter.status !== 'error' &&
      heartbeatAdapter.status !== 'stopped'
    )
  }

  async upsertChannel(payload: UpsertChannelPayload): Promise<AgentChannelConfig> {
    const id = payload.id || `channel-${randomUUID()}`
    const generation = this.nextMutationGeneration(id)
    const existing = this.deps.db.getAgentChannel(id)
    if (existing?.last_error === CHANNEL_DELETE_PENDING_ERROR) throw new Error('连接正在删除，请稍后再试')
    if (existing && existing.type !== payload.type) throw new Error('既有连接不能改为另一种通讯类型')
    const previousConfig = existing
      ? tryParseJson<Record<string, unknown>>(existing.config_json, {})
      : {}
    const nextConfig = { ...toPublicChannelConfig(previousConfig, channelCredentialOwner(id)).config, ...(payload.config || {}) }
    const appChanged = existing?.type === 'feishu-app' && nextConfig.appId !== previousConfig.appId
    if (appChanged) {
      nextConfig.allowedSenderId = null
      nextConfig.bindingId = null
      nextConfig.defaultChatId = null
      nextConfig.remoteAssistantEnabled = false
    }
    const preparedConfig = await prepareChannelConfigUpdate(
      nextConfig,
      channelCredentialOwner(id),
      previousConfig,
    )
    let row: AgentChannelRecord
    try {
      const current = this.deps.db.getAgentChannel(id)
      if (this.mutationGenerations.get(id) !== generation || current?.config_json !== existing?.config_json || current?.enabled !== existing?.enabled) {
        throw new Error('连接设置已发生变化，请重新操作')
      }
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

    if (row.enabled && !this.deps.sidecar.isRunning()) await this.deps.startSidecar()
    if (this.deps.sidecar.isRunning()) await this.syncChannel(id)
    return this.mapChannelRow(row)
  }

  async deleteChannel(id: string): Promise<boolean> {
    this.nextMutationGeneration(id)
    const existing = this.deps.db.getAgentChannel(id)
    if (!existing) return false
    this.deps.db.setSetting(`wechat_login:${id}`, '')
    this.deps.db.setSetting(`channel_pairing:${id}`, '')
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
    this.nextMutationGeneration(id)
    const existing = this.deps.db.getAgentChannel(id)
    if (existing?.last_error === CHANNEL_DELETE_PENDING_ERROR) throw new Error('连接正在删除，请稍后再试')
    if (!enabled) {
      this.deps.db.setSetting(`wechat_login:${id}`, '')
    }
    if (enabled && existing && this.mapChannelRow(existing).credentialState !== 'ready') {
      throw new Error('channel_credential_recovery_required')
    }
    const row = this.deps.db.setAgentChannelEnabled(id, enabled)
    if (!row) return null
    if (enabled && !this.deps.sidecar.isRunning()) await this.deps.startSidecar()
    if (this.deps.sidecar.isRunning()) await this.syncChannel(id)
    return this.mapChannelRow(row)
  }

  async sendChannelProbe(id: string, text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    const channel = this.deps.db.getAgentChannel(id)
    if (!channel) return { success: false, error: `Channel not found: ${id}` }
    if (!channel.enabled || this.mapChannelRow(channel).credentialState !== 'ready') return { success: false, error: '请先启用并完成绑定' }
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
    const row = this.deps.db.getAgentChannel(channelId)
    if (!row || row.last_error === CHANNEL_DELETE_PENDING_ERROR) return
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
      return normalizeChannelDeliveryResult(response, '连接测试未得到确认')
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async startWechatLogin(payload: { id?: string; force?: boolean }): Promise<Record<string, unknown>> {
    const id = payload.id || 'channel-wechat-openclaw-default'
    const generation = this.nextMutationGeneration(id)
    const existing = this.deps.db.getAgentChannel(id)
    if (existing?.last_error === CHANNEL_DELETE_PENDING_ERROR) throw new Error('连接正在删除，请稍后再试')
    if (existing && existing.type !== 'wechat-openclaw') throw new Error('请选择微信连接')
    const sessionKey = randomUUID()
    this.deps.db.upsertAgentChannel({ id, type: 'wechat-openclaw', name: existing?.name || '微信', enabled: false,
      configJson: existing?.config_json || '{}' })
    this.deps.db.setSetting(`wechat_login:${id}`, JSON.stringify({ sessionKey, status: 'pending' }))
    if (!this.deps.sidecar.isRunning()) await this.deps.startSidecar()
    return this.serializeChannelMirror(id, async () => {
      if (this.mutationGenerations.get(id) !== generation) return { success: false, error: '绑定已取消或设置已变更' }
      const row = this.deps.db.getAgentChannel(id)
      if (!row) return { success: false, error: '连接已删除' }
      const config = this.mapRuntimeChannelRow(row).config
      delete config.defaultTarget
      const mirrored = await this.deps.sidecar.upsertChannel({ id, type: 'wechat-openclaw', name: row.name, enabled: false, config })
      if (mirrored.success !== true) throw new Error(String(mirrored.error || '连接设置未生效'))
      const result = await this.deps.sidecar.startWechatLogin(id, payload.force ?? true, sessionKey)
      if (this.readWechatLoginState(id)?.sessionKey !== sessionKey) return { success: false, error: '绑定已取消或设置已变更' }
      return result
    })
  }

  async getWechatLoginStatus(channelId: string, sessionKey: string): Promise<Record<string, unknown>> {
    const state = this.readWechatLoginState(channelId)
    if (state?.sessionKey !== sessionKey) return { success: false, status: 'cancelled', error: '绑定已取消或已更新' }
    if (state.status === 'error') return { ...state, success: false }
    if (state.status === 'connected') {
      const row = this.deps.db.getAgentChannel(channelId)
      const config = tryParseJson<Record<string, unknown>>(row?.config_json || '{}', {})
      return row?.enabled && config.bindingId === state.bindingId
        ? { success: true, ...state }
        : { success: false, status: 'cancelled', error: '绑定已取消或已更新' }
    }
    if (!this.deps.sidecar.isRunning()) await this.deps.startSidecar()
    const result = await this.deps.sidecar.getWechatLoginStatus(channelId, sessionKey)
    if (result.status === 'connected' || result.status === 'already_connected') {
      await this.completeWechatBinding({ ...result, channelId, sessionKey })
      const completed = this.readWechatLoginState(channelId)
      const row = this.deps.db.getAgentChannel(channelId)
      const config = tryParseJson<Record<string, unknown>>(row?.config_json || '{}', {})
      return completed?.sessionKey === sessionKey && completed.status === 'connected' && row?.enabled && config.bindingId === completed.bindingId
        ? { success: true, ...completed }
        : { success: false, status: 'cancelled', error: '绑定已取消或已更新' }
    }
    return result
  }

  async submitWechatLoginVerifyCode(channelId: string, sessionKey: string, code: string): Promise<Record<string, unknown>> {
    const state = this.readWechatLoginState(channelId)
    if (state?.sessionKey !== sessionKey || state.status !== 'pending') return { success: false, error: '绑定已取消或已完成' }
    if (!this.deps.sidecar.isRunning()) {
      await this.deps.startSidecar()
    }
    return this.deps.sidecar.submitWechatLoginVerifyCode(channelId, sessionKey, code)
  }

  async completeWechatBinding(payload: Record<string, unknown>): Promise<void> {
    await this.persistWechatBinding(payload)
  }

  private async persistWechatBinding(payload: Record<string, unknown>): Promise<void> {
    const id = String(payload.channelId || '')
    const row = this.deps.db.getAgentChannel(id)
    if (!row || row.type !== 'wechat-openclaw') return
    const config = tryParseJson<Record<string, unknown>>(row.config_json, {})
    const pendingSession = this.readWechatLoginState(id)
    const restoring = payload.restored === true && row.enabled && pendingSession?.status !== 'pending'
      && config.accountId === payload.accountId && !config.allowedSenderId
    if (!restoring && (!payload.sessionKey || pendingSession?.status !== 'pending' || pendingSession.sessionKey !== payload.sessionKey)) return
    const accountId = String(payload.accountId || '')
    const owner = String(payload.userId || '')
    if (!accountId || !owner) {
      const error = '微信没有返回完整的账号身份，请重新绑定'
      this.deps.db.setAgentChannelError(id, error)
      this.deps.db.setSetting(`wechat_login:${id}`, JSON.stringify({ sessionKey: pendingSession?.sessionKey || null, status: 'error', error }))
      return
    }
    const restoredBindingId = `restored-${createHash('sha256').update(`${id}:${accountId}:${owner}`).digest('hex').slice(0, 32)}`
    if (restoring && payload.bindingId !== restoredBindingId) return
    const bindingId = restoring ? restoredBindingId : randomUUID()
    const raw = this.deps.db.getRawDb()
    if (!raw) throw new Error('Database not available')
    raw.exec('BEGIN IMMEDIATE')
    try {
      this.deps.db.upsertAgentChannel({ id, type: 'wechat-openclaw', name: row.name, enabled: true,
        configJson: JSON.stringify({ ...config, accountId, allowedSenderId: owner, bindingId, remoteAssistantEnabled: true }) })
      this.deps.db.setSetting(`wechat_login:${id}`, JSON.stringify({ sessionKey: restoring ? null : payload.sessionKey,
        status: 'connected', accountId, userId: owner, bindingId }))
      raw.exec('COMMIT')
    } catch (error) {
      if (raw.inTransaction) raw.exec('ROLLBACK')
      throw error
    }
    this.nextMutationGeneration(id)
    if (this.deps.sidecar.isRunning()) await this.syncChannel(id)
  }

  startChannelPairing(id: string): { code: string; expiresAt: string } {
    const channel = this.deps.db.getAgentChannel(id)
    if (!channel || channel.type !== 'feishu-app' || !channel.enabled) throw new Error('请先连接飞书应用')
    const code = String(randomInt(100000, 1000000))
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    this.deps.db.setSetting(`channel_pairing:${id}`, JSON.stringify({
      digest: createHash('sha256').update(`${id}:${code}`).digest('hex'), expiresAt, attempts: 0,
      appId: tryParseJson<Record<string, unknown>>(channel.config_json, {}).appId,
    }))
    return { code, expiresAt }
  }

  async consumeChannelPairing(payload: Record<string, unknown>): Promise<boolean> {
    const text = String(payload.text || '').trim()
    if (!/^\/bind(?:\s|$)/i.test(text)) return false
    const id = String(payload.channelId || '')
    const row = this.deps.db.getAgentChannel(id)
    if (!row || row.type !== 'feishu-app' || !row.enabled) return true
    const meta = payload.meta as Record<string, unknown> | undefined
    if (meta?.chatType !== 'p2p') return true
    const state = tryParseJson<Record<string, unknown>>(this.deps.db.getSetting(`channel_pairing:${id}`) || '{}', {})
    const code = text.match(/^\/bind\s+(\d{6})$/i)?.[1]
    const attempts = Number(state.attempts || 0)
    if (state.appId !== tryParseJson<Record<string, unknown>>(row.config_json, {}).appId) return true
    if (!state.digest || Date.parse(String(state.expiresAt)) < Date.now() || attempts >= 5) return true
    this.deps.db.setSetting(`channel_pairing:${id}`, JSON.stringify({ ...state, attempts: attempts + 1 }))
    if (!code || createHash('sha256').update(`${id}:${code}`).digest('hex') !== state.digest) return true
    const sender = String(payload.sender || '')
    const thread = String(payload.thread || '')
    if (!sender || !thread) return true
    // Consume before any asynchronous channel reconfiguration: one owner wins.
    this.deps.db.setSetting(`channel_pairing:${id}`, '')
    await this.upsertChannel({ id, type: row.type, name: row.name, enabled: true,
      config: { allowedSenderId: sender, defaultChatId: thread, bindingId: randomUUID(), remoteAssistantEnabled: true } })
    return true
  }

  private nextMutationGeneration(id: string): number {
    const generation = (this.mutationGenerations.get(id) || 0) + 1
    this.mutationGenerations.set(id, generation)
    return generation
  }

  private readWechatLoginState(id: string): WechatLoginState | null {
    return tryParseJson<WechatLoginState | null>(this.deps.db.getSetting(`wechat_login:${id}`) || 'null', null)
  }

  private async serializeChannelMirror<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.channelMirrors.get(id) || Promise.resolve()).catch(() => undefined).then(operation)
    this.channelMirrors.set(id, pending)
    try { return await pending } finally { if (this.channelMirrors.get(id) === pending) this.channelMirrors.delete(id) }
  }

  async syncChannel(id: string): Promise<void> {
    return this.serializeChannelMirror(id, async () => {
      const row = this.deps.db.getAgentChannel(id)
      if (!row || row.last_error === CHANNEL_DELETE_PENDING_ERROR || this.mapChannelRow(row).credentialState !== 'ready') {
        const result = await this.deps.sidecar.deleteChannel(id)
        if (result.success !== true) throw new Error(String(result.error || '通道停止失败'))
        return
      }
      const channel = this.mapRuntimeChannelRow(row)
      const result = await this.deps.sidecar.upsertChannel({ id, type: row.type, name: row.name,
        enabled: Boolean(row.enabled), config: channel.config })
      if (result.success !== true) throw new Error(String(result.error || '连接设置未生效'))
      const current = this.deps.db.getAgentChannel(id)
      if (!current || current.last_error === CHANNEL_DELETE_PENDING_ERROR || current.config_json !== row.config_json || current.enabled !== row.enabled) return
      await this.applyChannelState(id, Boolean(row.enabled))
    })
  }

  private async applyChannelState(id: string, enabled: boolean): Promise<void> {
    const response = enabled ? await this.deps.sidecar.startChannel(id) : await this.deps.sidecar.stopChannel(id)
    const result = normalizeChannelDeliveryResult(response, enabled ? '通道启动失败' : '通道停止失败')
    if (this.deps.db.getAgentChannel(id)?.last_error !== CHANNEL_DELETE_PENDING_ERROR) {
      this.deps.db.setAgentChannelError(id, result.success ? null : result.error || '连接失败')
    }
    if (!result.success) throw new Error(result.error)
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
    return this.serializeChannelMirror(id, () => this.finishPendingDeleteAtMirror(id))
  }

  private async finishPendingDeleteAtMirror(id: string): Promise<boolean> {
    const existing = this.deps.db.getAgentChannel(id)
    if (!existing) return true
    await clearChannelCredentials(
      tryParseJson<Record<string, unknown>>(existing.config_json, {}),
      channelCredentialOwner(id),
    )
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.stopChannel(id)
      const deleted = await this.deps.sidecar.deleteChannel(id)
      if (deleted.success !== true) {
        throw new Error(String(deleted.error || CHANNEL_DELETE_PENDING_ERROR))
      }
    }
    return this.deps.db.deleteAgentChannel(id)
  }
}
