import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { deriveTaskProjectionCanResume } from '../task-projection/task-projection-resume'
import {
  finalizeRunOutcome,
  type RunMetaRepositoryLike,
  type RunOutcome,
  writeRunCloseMetric,
} from './run-finalizer'

export const STALE_WITHOUT_HANDLE_CLOSEOUT_MS = 30 * 60 * 1000

type StaleProjectionFinalize = typeof finalizeRunOutcome

interface StaleProjectionStore {
  get(taskId: string): TaskProjectionRecord | null
  update(
    taskId: string,
    patch: Partial<TaskProjectionRecord>,
    options?: { silent?: boolean; reasonHint?: 'create' | 'update' | 'delete' | 'reset' | 'hydrate' },
  ): void | Promise<void>
}

export interface StaleProjectionFinalizerParams {
  scopeId: string
  records: TaskProjectionRecord[]
  taskProjectionStore: StaleProjectionStore
  runMetaRepository?: RunMetaRepositoryLike | null
  hasActiveRun: () => boolean
  now?: string | Date | number
  finalize?: StaleProjectionFinalize
  graceMs?: number
}

const STALE_CLOSEOUT_STATUSES = new Set<TaskProjectionRecord['status']>([
  'running',
  'queued',
  'blocked',
  'recoverable_paused',
  'budget_paused',
])

function timestampMs(value: string | Date | number | null | undefined): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : 0
  }
  return 0
}

function staleWithoutHandleProjectionPatch(
  record: TaskProjectionRecord,
  now: string,
): Partial<TaskProjectionRecord> {
  return {
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskSummary: record.taskSummary || '任务已收口，缺少可继续的进度句柄。',
    blockedReason: '任务状态已过期，缺少可续跑句柄',
    degradationReason: 'stale_paused',
    resumableActions: ['none'],
    continuationRef: null,
    updatedAt: now,
  }
}

export function shouldFinalizeStaleWithoutHandleProjection(
  record: TaskProjectionRecord,
  nowMs: number,
  graceMs = STALE_WITHOUT_HANDLE_CLOSEOUT_MS,
): boolean {
  if (!STALE_CLOSEOUT_STATUSES.has(record.status)) return false
  if (!record.runId) return false
  if (deriveTaskProjectionCanResume(record).canResume === true) return false
  return nowMs - timestampMs(record.updatedAt) > graceMs
}

export async function finalizeStaleWithoutHandleProjections(
  params: StaleProjectionFinalizerParams,
): Promise<number> {
  const finalize = params.finalize ?? finalizeRunOutcome
  const nowMs = timestampMs(params.now ?? new Date())
  const now = new Date(nowMs).toISOString()
  let finalized = 0

  for (const record of params.records) {
    if (!shouldFinalizeStaleWithoutHandleProjection(record, nowMs, params.graceMs)) continue
    if (params.hasActiveRun()) break
    const projectionPatch = staleWithoutHandleProjectionPatch(record, now)
    const durationMs = Math.max(0, nowMs - timestampMs(record.createdAt))
    const outcome: RunOutcome = {
      kind: 'interrupted',
      runId: record.runId,
      taskId: record.taskId,
      scopeId: params.scopeId,
      durationMs,
      toolCallsUsed: 0,
      initiator: 'stale_without_handle_closeout',
      terminalReason: 'stale_without_handle',
      projectionPatch,
    }
    await finalize(outcome, {
      runMetaRepository: params.runMetaRepository ?? null,
      taskProjectionStore: params.taskProjectionStore,
      writeProjectionTerminalPatch: async (patch) => {
        if (!patch) return
        await params.taskProjectionStore.update(
          record.taskId,
          patch as Partial<TaskProjectionRecord>,
          { reasonHint: 'update' },
        )
      },
      writeRunCloseMetric,
    })
    finalized += 1
  }

  return finalized
}
