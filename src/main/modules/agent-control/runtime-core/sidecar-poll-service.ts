// B8-D R4 — SidecarPollService: the DB→sidecar mirror sync, the 3s poll loop
// (heartbeat refresh / channel-state cache refresh / cron-trigger + inbound
// event pull), and the errored-adapter revive pass with its restart backoff,
// extracted from AgentControlRuntime (runtime.ts) as a delegated sub-service.
// Method bodies are mechanical moves; the only substitutions are
// `this.db` / `this.sidecar` / `this.heartbeat` → `this.deps.*`, the runtime
// hub calls (`listChannels` / `listSchedules` / `getSettingBool` /
// `startSidecar` / `schedules.executeSchedule` / `handleInboundChannel`)
// becoming injected callbacks, and the `channelStateCache` whole-object
// reassignment becoming two in-place property writes so the runtime-owned
// cache object (read by `getRuntimeStatus`, which stays on the runtime) keeps
// its identity. The timer fields (`pollTimer`, `lastSidecarRestartAttemptAt`,
// `lastAdapterRestartAttemptAt`) are cluster-exclusive and migrate in;
// `stopPollLoop()` houses the exact clear-block that previously lived inline
// in `runtime.stop()`. `handleInboundChannel` is the remote-channel cluster's
// entry point (that cluster stays on the runtime until the next batch); the
// callback binds the runtime method, so when the cluster migrates the
// delegation re-binds automatically.
import type { AgentScheduleRecord, DatabaseManager } from '../../database'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentChannelConfig, ChannelAdapterType, CronTask, HeartbeatSnapshot } from '../contracts/types'
import type { ScheduleTriggerSource } from './schedule-execution'

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
  /** Bound to `ScheduleService.listSchedules` via the runtime delegate. */
  listSchedules: () => CronTask[]
  /** Bound to `ScheduleService.executeSchedule` — cron triggers pulled from
   *  the sidecar event stream. */
  executeSchedule: (
    schedule: AgentScheduleRecord,
    triggerSource: ScheduleTriggerSource
  ) => Promise<{ success: boolean; error?: string }>
  /** Bound to the runtime `handleInboundChannel` — remote-channel cluster
   *  entry (migrates in the next batch; the callback re-binds through it). */
  handleInboundChannel: (payload: Record<string, unknown>) => Promise<void>
}

export class SidecarPollService {
  private pollTimer: NodeJS.Timeout | null = null
  private lastSidecarRestartAttemptAt = 0
  private readonly lastAdapterRestartAttemptAt = new Map<string, number>()

  constructor(private readonly deps: SidecarPollServiceDeps) {}

  async syncDatabaseToSidecar(): Promise<void> {
    if (!this.deps.sidecar.isRunning()) return
    const channels = this.deps.listChannels()
    for (const channel of channels) {
      await this.deps.sidecar.upsertChannel({
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        config: channel.config
      })
      if (channel.enabled) {
        await this.deps.sidecar.startChannel(channel.id).catch(() => undefined)
      } else {
        await this.deps.sidecar.stopChannel(channel.id).catch(() => undefined)
      }
    }
    const schedules = this.deps.listSchedules()
    for (const schedule of schedules) {
      await this.deps.sidecar.upsertSchedule({
        id: schedule.id,
        name: schedule.name,
        cronExpr: schedule.cronExpr,
        prompt: schedule.prompt,
        channelId: schedule.channelId,
        enabled: schedule.enabled,
        payload: schedule.payload || {}
      })
    }
  }

  ensurePollLoop(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollSidecarEvents()
    }, 3_000)
  }

  /** Exact clear-block previously inline in `runtime.stop()`. */
  stopPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pollSidecarEvents(): Promise<void> {
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
        const evtType = String(evt.type || '')
        if (evtType === 'schedule.trigger') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          const scheduleId = String(payload.scheduleId || '')
          if (!scheduleId) continue
          const schedule = this.deps.db.getAgentSchedule(scheduleId)
          if (!schedule || schedule.enabled === 0) continue
          await this.deps.executeSchedule(schedule, 'cron')
          continue
        }
        if (evtType === 'channel.inbound') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          await this.deps.handleInboundChannel(payload)
        }
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
        .filter((item) => item.enabled)
        .map((item) => item.id)
    )
    const now = Date.now()
    for (const adapter of this.deps.heartbeat.adapters) {
      if (!adapter.id || !enabledChannelIds.has(adapter.id)) continue
      const shouldRestart =
        adapter.status === 'error' ||
        adapter.status === 'stopped' ||
        (adapter.healthy === false && adapter.status !== 'starting')
      if (!shouldRestart) continue
      const lastAttempt = this.lastAdapterRestartAttemptAt.get(adapter.id) || 0
      if (now - lastAttempt < 15_000) continue
      this.lastAdapterRestartAttemptAt.set(adapter.id, now)
      await this.deps.sidecar.stopChannel(adapter.id).catch(() => undefined)
      await this.deps.sidecar.startChannel(adapter.id).catch(() => undefined)
    }
  }
}
