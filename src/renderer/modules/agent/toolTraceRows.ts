/**
 * P0-2 (2026-07-02 P0 visibility batch) — pure derivation for ToolTraceCard
 * rows: pairs each result event with its most recent unpaired call (tool
 * execution is serial — maxFunctionToolConcurrency: 1) and attaches a
 * human-readable duration label to result rows. Pure and IO-free so the
 * pairing/formatting contract is unit-testable.
 */

export interface ToolTraceRowInput {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: Date
}

export interface ToolTraceRow extends ToolTraceRowInput {
  durationLabel?: string
}

/** <100ms 不显示（噪声）；秒级一位小数；分钟级 m+s。 */
export function formatToolTraceDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 100) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) {
    const seconds = (ms / 1000).toFixed(1)
    return `${seconds.endsWith('.0') ? seconds.slice(0, -2) : seconds}s`
  }
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function deriveToolTraceRows(events: ReadonlyArray<ToolTraceRowInput>): ToolTraceRow[] {
  const unpairedCalls: ToolTraceRowInput[] = []
  return events.map((event) => {
    if (event.kind === 'call') {
      unpairedCalls.push(event)
      return { ...event }
    }
    const call = unpairedCalls.pop()
    if (!call) return { ...event }
    const durationLabel = formatToolTraceDuration(event.timestamp.getTime() - call.timestamp.getTime())
    return durationLabel ? { ...event, durationLabel } : { ...event }
  })
}
