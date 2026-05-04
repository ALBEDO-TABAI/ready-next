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

function normalizeActiveChildRun(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  const record = row as Record<string, unknown>
  const progress = record.progress && typeof record.progress === 'object' && !Array.isArray(record.progress)
    ? record.progress as Record<string, unknown>
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
    const data = runtime!.listActiveChildRuns()
    return {
      success: true,
      data: Array.isArray(data)
        ? data.map(normalizeActiveChildRun)
        : data ?? [],
    }
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
