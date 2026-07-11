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
  toolName?: string
  detail?: string
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

// ---------------------------------------------------------------------------
// Timeline items — one entry per tool invocation (call+result paired), used
// by the collapsed activity capsule's disclosure timeline. Same serial
// pairing assumption as `deriveToolTraceRows` (maxFunctionToolConcurrency: 1).
// ---------------------------------------------------------------------------

export type ToolTimelineStatus = 'running' | 'done' | 'error'

export interface ToolTimelineItem {
  /** Stable identity: the call event id (or the orphan result id). */
  id: string
  /** `toolName(argKeys)` line from the call event; null for orphan results. */
  callText: string | null
  /** Result text (already truncated main-side); null while running. */
  resultText: string | null
  status: ToolTimelineStatus
  durationLabel?: string
  /** 工具名（富事件携带；L3 详情标题）。 */
  toolName?: string
  /** L3 入参 JSON 预览（call 事件 detail）。 */
  callDetail?: string
  /** L3 输出全文（result 事件 detail）。 */
  resultDetail?: string
}

const TOOL_RESULT_ERROR_PATTERN = /失败|错误|error|failed/i

export function deriveToolTimelineItems(events: ReadonlyArray<ToolTraceRowInput>): ToolTimelineItem[] {
  const items: ToolTimelineItem[] = []
  const unpaired: Array<{ index: number; timestamp: Date }> = []
  for (const event of events) {
    if (event.kind === 'call') {
      unpaired.push({ index: items.length, timestamp: event.timestamp })
      items.push({
        id: event.id,
        callText: event.text,
        resultText: null,
        status: 'running',
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.detail ? { callDetail: event.detail } : {}),
      })
      continue
    }
    const open = unpaired.pop()
    if (!open) {
      items.push({
        id: event.id,
        callText: null,
        resultText: event.text,
        status: TOOL_RESULT_ERROR_PATTERN.test(event.text) ? 'error' : 'done',
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.detail ? { resultDetail: event.detail } : {}),
      })
      continue
    }
    const item = items[open.index]
    item.resultText = event.text
    item.status = TOOL_RESULT_ERROR_PATTERN.test(event.text) ? 'error' : 'done'
    if (!item.toolName && event.toolName) item.toolName = event.toolName
    if (event.detail) item.resultDetail = event.detail
    const durationLabel = formatToolTraceDuration(event.timestamp.getTime() - open.timestamp.getTime())
    if (durationLabel) item.durationLabel = durationLabel
  }
  return items
}
