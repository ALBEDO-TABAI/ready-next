export interface ParallelToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ParallelToolGroup {
  mode: 'parallel' | 'serial'
  toolCalls: ParallelToolCall[]
}

const PARALLEL_SAFE_TOOL_NAMES = new Set([
  'document_list_widgets',
  'memory_search',
  'memory_list_recent',
  'session_search',
  'rss_capture_session',
  'skill_get_state',
  'skill_rss_status',
  'skill_rss_list',
  'skill_rss_stats',
])

export function isParallelSafeTool(toolName: string): boolean {
  return PARALLEL_SAFE_TOOL_NAMES.has(String(toolName || '').trim())
}

export function groupParallelSafeToolCalls(toolCalls: ParallelToolCall[]): ParallelToolGroup[] {
  const groups: ParallelToolGroup[] = []
  let safeBuffer: ParallelToolCall[] = []

  const flushSafeBuffer = () => {
    if (safeBuffer.length === 0) return
    groups.push({
      mode: safeBuffer.length > 1 ? 'parallel' : 'serial',
      toolCalls: safeBuffer,
    })
    safeBuffer = []
  }

  for (const toolCall of toolCalls) {
    if (isParallelSafeTool(toolCall.name)) {
      safeBuffer.push(toolCall)
      continue
    }
    flushSafeBuffer()
    groups.push({
      mode: 'serial',
      toolCalls: [toolCall],
    })
  }

  flushSafeBuffer()
  return groups
}
