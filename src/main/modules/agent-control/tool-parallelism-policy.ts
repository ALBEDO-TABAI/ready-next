export interface ParallelToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ParallelToolGroup {
  mode: 'parallel' | 'serial'
  toolCalls: ParallelToolCall[]
}

export interface ToolResourceTag {
  domain: 'browser' | 'document' | 'file' | 'rss' | 'calendar' | 'feishu' | 'skill' | 'memory' | 'session' | 'system'
  accessMode: 'read' | 'write' | 'interactive'
}

const READ_ONLY_DOCUMENT_TOOL_NAMES = new Set([
  'document_list_widgets',
])

const READ_ONLY_RSS_TOOL_NAMES = new Set([
  'rss_capture_session',
])

const READ_ONLY_CALENDAR_TOOL_NAMES = new Set([
  'calendar_list_window',
])

const READ_ONLY_FEISHU_TOOL_NAMES = new Set([
  'feishu_doc_read',
  'feishu_doc_list',
  'feishu_message_get_context',
  'feishu_calendar_list_events',
  'feishu_chat_list',
  'feishu_chat_get_members',
  'feishu_chat_get_info',
  'feishu_file_download',
])

const READ_ONLY_SKILL_TOOL_NAMES = new Set([
  'skill_rss_status',
  'skill_rss_list',
  'skill_rss_stats',
])

const INTERACTIVE_SKILL_TOOL_NAMES = new Set([
  'skill_get_state',
  'skill_submit_input',
  'skill_submit_confirmation',
  'skill_submit_agent_result',
  'skill_restart_from_step',
  'skill_cancel_execution',
])

export function getToolResourceTag(toolName: string): ToolResourceTag {
  const normalized = String(toolName || '').trim()

  if (normalized.startsWith('browser_')) {
    return { domain: 'browser', accessMode: 'interactive' }
  }
  if (normalized.startsWith('document_')) {
    return {
      domain: 'document',
      accessMode: READ_ONLY_DOCUMENT_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('file_')) {
    const writeFileTools = new Set(['file_classify', 'file_rename', 'file_move'])
    return {
      domain: 'file',
      accessMode: writeFileTools.has(normalized) ? 'write' : 'read',
    }
  }
  if (normalized.startsWith('rss_')) {
    return {
      domain: 'rss',
      accessMode: READ_ONLY_RSS_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('calendar_')) {
    return {
      domain: 'calendar',
      accessMode: READ_ONLY_CALENDAR_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('feishu_')) {
    return {
      domain: 'feishu',
      accessMode: READ_ONLY_FEISHU_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('memory_')) {
    return { domain: 'memory', accessMode: 'read' }
  }
  if (normalized.startsWith('session_')) {
    return { domain: 'session', accessMode: 'read' }
  }
  if (normalized.startsWith('skill_')) {
    return {
      domain: 'skill',
      accessMode: INTERACTIVE_SKILL_TOOL_NAMES.has(normalized)
        ? 'interactive'
        : READ_ONLY_SKILL_TOOL_NAMES.has(normalized)
          ? 'read'
          : 'interactive',
    }
  }
  return { domain: 'system', accessMode: 'interactive' }
}

export function isParallelSafeTool(toolName: string): boolean {
  return getToolResourceTag(toolName).accessMode === 'read'
}

function canJoinParallelGroup(buffer: ParallelToolCall[], toolCall: ParallelToolCall): boolean {
  const candidate = getToolResourceTag(toolCall.name)
  if (candidate.accessMode === 'interactive') return false
  return buffer.every((existing) => {
    const current = getToolResourceTag(existing.name)
    if (current.accessMode === 'interactive') return false
    if (candidate.domain === current.domain && (candidate.accessMode === 'write' || current.accessMode === 'write')) {
      return false
    }
    return true
  })
}

export function groupParallelSafeToolCalls(toolCalls: ParallelToolCall[]): ParallelToolGroup[] {
  const groups: ParallelToolGroup[] = []
  let parallelBuffer: ParallelToolCall[] = []

  const flushParallelBuffer = () => {
    if (parallelBuffer.length === 0) return
    groups.push({
      mode: parallelBuffer.length > 1 ? 'parallel' : 'serial',
      toolCalls: parallelBuffer,
    })
    parallelBuffer = []
  }

  for (const toolCall of toolCalls) {
    if (canJoinParallelGroup(parallelBuffer, toolCall)) {
      parallelBuffer.push(toolCall)
      continue
    }
    flushParallelBuffer()
    const tag = getToolResourceTag(toolCall.name)
    if (tag.accessMode === 'interactive') {
      groups.push({
        mode: 'serial',
        toolCalls: [toolCall],
      })
      continue
    }
    parallelBuffer.push(toolCall)
  }

  flushParallelBuffer()
  return groups
}
