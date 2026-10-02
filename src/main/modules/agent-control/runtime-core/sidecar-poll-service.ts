// Polls transport health and acknowledges inbound events only after Main
// has persisted them. ChannelConfigService owns every adapter mutation.
import type { DatabaseManager } from '../../database'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentChannelConfig, ChannelAdapterType, HeartbeatSnapshot } from '../contracts/types'

export interface SidecarPollServiceDeps {
  db: DatabaseManager
  sidecar: SidecarManager
  /** Runtime-owned heartbeat snapshot (shared with lifecycle/status and
   *  ChannelConfigService). Mutated in place — properties are reassigned but
   *  the object itself never is, so holding the reference keeps
   *  `getRuntimeStatus` reads live. */
  heartbeat: HeartbeatSnapshot
  /** Runtime-owned channel connected/error cache (read by `getRuntimeStatus`
   *  on the Settings render path). Mutated in place — see the header note. */
  channelStateCache: { connected: number; errors: number }
  /** Bound to the runtime lifecycle `startSidecar()` — poll-loop autostart
   *  recovery when the sidecar is found stopped (30s backoff). */
  startSidecar: () => Promise<void>
  getSettingBool: (key: string, fallback: boolean) => boolean
  /** Bound to `ChannelConfigService.listChannels` via the runtime delegate. */
  listChannels: () => AgentChannelConfig[]
  syncChannel: (id: string) => Promise<void>
  /** Bound to the runtime `handleInboundChannel` — remote-channel cluster
   *  entry (migrates in the next batch; the callback re-binds through it). */
  handleInboundChannel: (payload: Record<string, unknown>) => Promise<void>
  completeWechatBinding: (payload: Record<string, unknown>) => Promise<void>
}

export class SidecarPollService {
  private polling = false
  private stopped = false
  private pollTimer: NodeJS.Timeout | null = null
  private lastSidecarRestartAttemptAt = 0
  private readonly lastAdapterRestartAttemptAt = new Map<string, number>()

  constructor(private readonly deps: SidecarPollServiceDeps) {}

  async syncDatabaseToSidecar(): Promise<void> {
    if (!this.deps.sidecar.isRunning()) return
    const channels = this.deps.listChannels()
    for (const channel of channels) {
      try { await this.deps.syncChannel(channel.id) }
      catch (error) {
        if (this.deps.db.channels.getAgentChannel(channel.id)?.last_error !== 'channel_delete_pending') {
          this.deps.db.channels.setAgentChannelError(channel.id, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  ensurePollLoop(): void {
    if (this.pollTimer) return
    this.stopped = false
    this.pollTimer = setInterval(() => {
      void this.pollSidecarEvents()
    }, 3_000)
  }

  /** Exact clear-block previously inline in `runtime.stop()`. */
  stopPollLoop(): void {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pollSidecarEvents(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      await this.pollOnce()
    } catch (error) {
      // silent-catch: failed startup is published to the runtime health surface and retried by the owned poll loop.
      this.deps.heartbeat.sidecar.status = 'error'
      this.deps.heartbeat.sidecar.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.deps.sidecar.isRunning()) {
      const sidecarEnabled = this.deps.getSettingBool('remote_channels_enabled', true)
      const autostart = this.deps.getSettingBool('sidecar_autostart', true)
      const now = Date.now()
      if (sidecarEnabled && autostart && now - this.lastSidecarRestartAttemptAt > 30_000) {
        this.lastSidecarRestartAttemptAt = now
        await this.deps.startSidecar()
      }
      return
    }
    try {
      const heart = await this.deps.sidecar.heartbeat()
      this.deps.heartbeat.sidecar.lastBeatAt = new Date().toISOString()
      this.deps.heartbeat.sidecar.status = 'running'
      delete this.deps.heartbeat.sidecar.error
      const adapters = Array.isArray((heart as { adapters?: unknown[] }).adapters)
        ? ((heart as { adapters?: unknown[] }).adapters as Array<Record<string, unknown>>)
        : []
      this.deps.heartbeat.adapters = adapters.map((item) => ({
        id: String(item.id || ''),
        type: String(item.type || 'local-debug') as ChannelAdapterType,
        healthy: Boolean(item.healthy),
        status:
          typeof item.status === 'string'
            ? (item.status as 'starting' | 'running' | 'stopped' | 'error')
            : undefined,
        lastBeatAt: typeof item.lastBeatAt === 'string' ? item.lastBeatAt : undefined,
        error: typeof item.error === 'string' ? item.error : undefined
      }))
      await this.reviveErroredAdapters()

      const channelState = await this.deps.sidecar.getChannelState().catch(() => null)
      if (channelState) {
        this.deps.channelStateCache.connected = Number(
          (channelState as { connected?: number }).connected || 0
        )
        this.deps.channelStateCache.errors = Number(
          (channelState as { errors?: number }).errors || 0
        )
      }

      const events = await this.deps.sidecar.pullEvents(24)
      for (const evt of events) {
        if (this.stopped) return
        const evtType = String(evt.type || '')
        if (evtType === 'channel.inbound') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          await this.deps.handleInboundChannel(payload)
        } else if (evtType === 'channel.wechat-bound' || evtType === 'channel.wechat-restored') {
          await this.deps.completeWechatBinding((evt.payload || {}) as Record<string, unknown>)
        }
        await this.deps.sidecar.acknowledgeEvents([String(evt.id)])
      }
    } catch (error) {
      // silent-catch: poll failure lands on heartbeat.sidecar status/error for the health surface
      this.deps.heartbeat.sidecar.status = 'error'
      this.deps.heartbeat.sidecar.error = error instanceof Error ? error.message : String(error)
    }
  }

  private async reviveErroredAdapters(): Promise<void> {
    const enabledChannelIds = new Set(
      this.deps.listChannels()
        .filter((item) => item.enabled && item.credentialState === 'ready')
        .map((item) => item.id)
    )
    const now = Date.now()
    for (const adapter of this.deps.heartbeat.adapters) {
      if (!adapter.id || !enabledChannelIds.has(adapter.id)) continue
      const shouldRestart = adapter.status === 'stopped'
      if (!shouldRestart) continue
      const lastAttempt = this.lastAdapterRestartAttemptAt.get(adapter.id) || 0
      if (now - lastAttempt < 15_000) continue
      this.lastAdapterRestartAttemptAt.set(adapter.id, now)
      await this.deps.syncChannel(adapter.id).catch(() => undefined)
    }
  }
}
