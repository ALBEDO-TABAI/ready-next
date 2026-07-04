// B8-D R3 — ScheduleService: agent cron-schedule CRUD (DB rows mirrored to
// the sidecar scheduler while it is running), the manual runScheduleNow
// trigger, and the executeSchedule bridge into `executeAgentSchedule`,
// extracted from AgentControlRuntime (runtime.ts) as a delegated sub-service.
// Method bodies are mechanical moves; the only substitutions are
// `this.db` / `this.sidecar` → `this.deps.*` and the run-dispatch hub calls
// (`this.sendScoped` / `this.orchestrator.send`) becoming the injected
// `sendScoped` / `sendUnscoped` callbacks. The service owns no state.
// `executeSchedule` is public here (was private on the runtime) because the
// sidecar-poll cluster, which stays on the runtime, fires cron triggers
// through it.
import { randomUUID } from 'crypto'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type { AgentScheduleRecord, DatabaseManager } from '../../database'
import type { SidecarManager } from '../sidecar-manager'
import type { CronTask } from '../contracts/types'
import {
  executeAgentSchedule,
  type ScheduleExecutionDeps,
  type ScheduleTriggerSource,
} from './schedule-execution'
import { tryParseJson, type UpsertSchedulePayload } from './runtime-helpers'

export interface ScheduleServiceDeps {
  db: DatabaseManager
  sidecar: SidecarManager
  /** Bound to the runtime run-dispatch hub `sendScoped()` — scoped schedule runs. */
  sendScoped: ScheduleExecutionDeps['sendScoped']
  /** Bound to `orchestrator.send(agent, message, undefined, requestId)` —
   *  legacy direct send used only when a schedule has no stored scope. */
  sendUnscoped: ScheduleExecutionDeps['sendUnscoped']
}

export class ScheduleService {
  constructor(private readonly deps: ScheduleServiceDeps) {}

  listSchedules(): CronTask[] {
    const rows = this.deps.db.listAgentSchedules()
    return rows.map((row) => this.mapScheduleRow(row))
  }

  async upsertSchedule(payload: UpsertSchedulePayload): Promise<CronTask> {
    const id = payload.id || `cron-${randomUUID()}`
    const row = this.deps.db.upsertAgentSchedule({
      id,
      name: payload.name.trim() || id,
      cronExpr: payload.cronExpr,
      prompt: payload.prompt,
      channelId: payload.channelId ?? null,
      enabled: payload.enabled ?? true,
      payloadJson: payload.payload ? JSON.stringify(payload.payload) : null
    })

    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.upsertSchedule({
        id,
        name: row.name,
        cronExpr: row.cron_expr,
        prompt: row.prompt,
        channelId: row.channel_id,
        enabled: Boolean(row.enabled),
        payload: payload.payload || {}
      })
    }
    return this.mapScheduleRow(row)
  }

  async pauseSchedule(id: string): Promise<CronTask | null> {
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.pauseSchedule(id)
    }
    const row = this.deps.db.setAgentScheduleEnabled(id, false)
    return row ? this.mapScheduleRow(row) : null
  }

  async resumeSchedule(id: string): Promise<CronTask | null> {
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.resumeSchedule(id)
    }
    const row = this.deps.db.setAgentScheduleEnabled(id, true)
    return row ? this.mapScheduleRow(row) : null
  }

  async deleteSchedule(id: string): Promise<boolean> {
    if (this.deps.sidecar.isRunning()) {
      await this.deps.sidecar.deleteSchedule(id)
    }
    return this.deps.db.deleteAgentSchedule(id)
  }

  async runScheduleNow(id: string): Promise<{ success: boolean; error?: string }> {
    const schedule = this.deps.db.getAgentSchedule(id)
    if (!schedule) return { success: false, error: `Schedule not found: ${id}` }
    return await this.executeSchedule(schedule, 'manual')
  }

  async executeSchedule(
    schedule: AgentScheduleRecord,
    triggerSource: ScheduleTriggerSource = 'cron'
  ): Promise<{ success: boolean; error?: string }> {
    return executeAgentSchedule(schedule, {
      parseJson: (value, fallback) => tryParseJson<Record<string, unknown>>(value, fallback),
      sendScoped: (payload) => this.deps.sendScoped(payload),
      sendUnscoped: (agent, message, requestId) =>
        this.deps.sendUnscoped(agent, message, requestId),
      markRun: (scheduleId) => this.deps.db.markAgentScheduleRun(scheduleId),
      appendLog: appendToolCapabilityLog,
    }, triggerSource)
  }

  private mapScheduleRow(row: AgentScheduleRecord): CronTask {
    return {
      id: row.id,
      name: row.name,
      cronExpr: row.cron_expr,
      prompt: row.prompt,
      channelId: row.channel_id,
      enabled: Boolean(row.enabled),
      payload: tryParseJson<Record<string, unknown>>(row.payload_json || '{}', {}),
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
