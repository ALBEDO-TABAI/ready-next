import { logAgentMetric } from '../agent-control/metrics'

export interface ChildRunIpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
}

interface ActiveChildRunRuntimeLike {
  listActiveChildRuns: () => unknown
  cancelChildRun: (childRunId: string, options: { source: 'ui_button' }) => Promise<unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MAX_DROPPED_SAMPLES_PER_CALL = 5

interface NormalizationContext {
  droppedCount: number
  emittedSamples: number
}

function emitDroppedSample(
  ctx: NormalizationContext,
  reason: 'not_an_object' | 'missing_child_run_id',
  sampleKeys: string[],
): void {
  ctx.droppedCount += 1
  if (ctx.emittedSamples >= MAX_DROPPED_SAMPLES_PER_CALL) return
  ctx.emittedSamples += 1
  logAgentMetric('active_child_run_row_dropped', {
    reason,
    sampleKeys,
  })
}

function normalizeActiveChildRun(
  row: unknown,
  ctx: NormalizationContext,
): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    emitDroppedSample(ctx, 'not_an_object', [])
    return null
  }
  const record = row as Record<string, unknown>
  const childRunIdRaw = record.childRunId
  const childRunId =
    typeof childRunIdRaw === 'string' && childRunIdRaw.trim().length > 0
      ? childRunIdRaw
      : null
  if (!childRunId) {
    emitDroppedSample(ctx, 'missing_child_run_id', Object.keys(record).slice(0, 12))
    return null
  }
  const progress =
    record.progress && typeof record.progress === 'object' && !Array.isArray(record.progress)
      ? (record.progress as Record<string, unknown>)
      : {}
  return {
    ...record,
    progress: {
      stage: progress.stage ?? null,
      completed: progress.completed ?? null,
      total: progress.total ?? null,
      coverage: progress.coverage ?? null,
      overallCoverage: progress.overallCoverage ?? null,
      fingerprint: progress.fingerprint ?? null,
      updatedAt: progress.updatedAt ?? null,
      lastError: progress.lastError ?? null,
      detail: progress.detail ?? null,
      activityUpdatedAt: progress.activityUpdatedAt ?? null,
      handoff: progress.handoff ?? null,
    },
    blockedReason: record.blockedReason ?? null,
    liveness: Object.prototype.hasOwnProperty.call(record, 'liveness') ? record.liveness : 'background',
    closeStatus: record.closeStatus ?? null,
  }
}

export function listActiveChildRunsForIpc(
  runtime: Pick<ActiveChildRunRuntimeLike, 'listActiveChildRuns'> | null,
): ChildRunIpcResponse {
  try {
    const raw = runtime!.listActiveChildRuns()
    if (!Array.isArray(raw)) {
      return { success: false, error: 'invalid_payload_shape' }
    }
    const ctx: NormalizationContext = { droppedCount: 0, emittedSamples: 0 }
    const data = raw
      .map((row) => normalizeActiveChildRun(row, ctx))
      .filter((row): row is Record<string, unknown> => row !== null)
    return { success: true, data }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

export async function cancelChildRunForIpc(
  runtime: Pick<ActiveChildRunRuntimeLike, 'cancelChildRun'> | null,
  payload: { childRunId?: string },
): Promise<ChildRunIpcResponse> {
  try {
    const childRunId = String(payload?.childRunId || '').trim()
    if (!childRunId) return { success: false, error: 'childRunId is required' }
    const close = await runtime!.cancelChildRun(childRunId, { source: 'ui_button' })
    return { success: true, data: close }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}
