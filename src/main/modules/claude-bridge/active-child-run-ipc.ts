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

export function listActiveChildRunsForIpc(
  runtime: Pick<ActiveChildRunRuntimeLike, 'listActiveChildRuns'> | null,
): ChildRunIpcResponse {
  try {
    return { success: true, data: runtime!.listActiveChildRuns() }
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
