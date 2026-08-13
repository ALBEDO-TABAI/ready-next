const INFRASTRUCTURE_TIMEOUT_REPORT_ACK_MS = 5_000

export type InfrastructureTimeoutMainReport =
  | {
      kind: 'authoritative'
      state: 'active' | 'stale' | 'not_found' | 'paused_user_input'
      activeRunId: string | null
    }
  | { kind: 'unreachable' }
  | { kind: 'invalid_response' }

export async function reportInfrastructureTimeoutToMain(
  scopeId: string,
  requestId: string,
  elapsedMs: number,
): Promise<InfrastructureTimeoutMainReport> {
  const report = typeof window !== 'undefined'
    ? window.electronAPI?.agent?.reportInfrastructureTimeout
    : undefined
  if (typeof report !== 'function') return { kind: 'unreachable' }
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const response = await Promise.race<unknown>([
      report({ scopeId, requestId, elapsedMs }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), INFRASTRUCTURE_TIMEOUT_REPORT_ACK_MS)
      }),
    ])
    if (!response || typeof response !== 'object') return { kind: 'unreachable' }
    const record = response as {
      success?: unknown
      data?: { state?: unknown; activeRunId?: unknown }
    }
    if (record.success !== true) return { kind: 'unreachable' }
    const state = record.data?.state
    if (
      state !== 'active'
      && state !== 'stale'
      && state !== 'not_found'
      && state !== 'paused_user_input'
    ) return { kind: 'invalid_response' }
    const activeRunId = typeof record.data?.activeRunId === 'string'
      && record.data.activeRunId.trim()
      ? record.data.activeRunId.trim()
      : null
    if (state === 'stale' ? !activeRunId : Boolean(activeRunId)) {
      return { kind: 'invalid_response' }
    }
    return { kind: 'authoritative', state, activeRunId }
  } catch {
    return { kind: 'unreachable' }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
