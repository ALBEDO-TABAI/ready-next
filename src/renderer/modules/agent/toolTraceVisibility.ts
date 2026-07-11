import type { ToolTraceEvent } from './types'

const INTERNAL_TRACE_PATTERNS = [
  /^技能执行\s*[·:：-]/,
  /^技能上下文\b/,
  /^技能步骤(已完成|进行中|失败|已停止)?$/,
  /^正在执行技能步骤$/,
  /^执行技能步骤$/,
  /^读取技能参考$/,
  /^正在读取.*?参考内容$/,
  /^正在根据参考内容整理方案$/,
  /^写入方案草稿$/,
  /^正在写入方案草稿$/,
  /^方案草稿已写入/,
  /^保存到目标文件夹$/,
  /^正在保存到目标文件夹$/,
  /^已保存到目标文件夹$/,
  /^确认任务状态$/,
  /^任务状态已确认$/,
  /Artifact not found/i,
  /Provide .*?(output|run|artifact)/i,
  /\boutputDir\b/i,
  /\brun_state\b/i,
  /"(returned|degraded|items|success|note)"\s*:/,
  /^\s*\{[\s\S]*(?:"returned"|"degraded"|"items"|"success"|"note")[\s\S]*\}\s*$/,
]

function formatSkillToolTraceText(raw: string): string | null {
  const callMatch = raw.match(/^(skill_[a-z0-9_]+)\(([^)]*)\)$/i)
  if (callMatch) {
    const args = callMatch[2].trim()
    return args ? `${callMatch[1]}(${args})` : `${callMatch[1]}()`
  }
  const resultMatch = raw.match(/^(skill_[a-z0-9_]+)\s*[:：]\s*([\s\S]*)$/i)
  if (!resultMatch) return null
  const toolName = resultMatch[1]
  const detail = resultMatch[2].trim()
  if (/失败|错误|error|failed/i.test(detail)) return `${toolName}: 失败`
  if (toolName === 'skill_read_artifact') return `${toolName}: 已读取`
  if (toolName === 'skill_write_artifact') return `${toolName}: 已写入`
  if (toolName === 'skill_export_artifact') return `${toolName}: 已导出`
  if (toolName === 'skill_inspect_run_state') return `${toolName}: 已确认`
  if (!detail) return `${toolName}: 已完成`
  if (/^Artifact written\.?$/i.test(detail)) return `${toolName}: 已写入`
  if (/^Artifact read\.?$/i.test(detail)) return `${toolName}: 已读取`
  if (/^Artifact exported\.?$/i.test(detail)) return `${toolName}: 已导出`
  const cleaned = detail
    .replace(/^已保存到目标文件夹[:：]\s*/i, '已保存到 ')
    .replace(/^Artifact (?:written|read|exported)[:：]?\s*/i, '')
    .trim()
  return cleaned ? `${toolName}: ${cleaned}` : `${toolName}: 已完成`
}

function isInternalToolTraceText(text: string): boolean {
  const raw = String(text || '').trim()
  if (!raw) return true
  if (formatSkillToolTraceText(raw)) return false
  return INTERNAL_TRACE_PATTERNS.some((pattern) => pattern.test(raw))
}

function publicToolTraceText(text: string): string {
  const raw = String(text || '').trim()
  return formatSkillToolTraceText(raw) || raw
}

export function filterUserVisibleToolTraceEvents<T extends Pick<ToolTraceEvent, 'text'>>(events: T[]): T[] {
  const visible: T[] = []
  const keptIndexByKey = new Map<string, number>()
  for (const event of events) {
    if (isInternalToolTraceText(event.text)) continue
    const text = publicToolTraceText(event.text)
    const key = `${'kind' in event ? String((event as { kind?: unknown }).kind) : ''}:${text}`
    const keptIndex = keptIndexByKey.get(key)
    if (keptIndex != null) {
      // 同一工具事件有两个生产者（SDK executor 带 toolName/detail 的富事件、
      // orchestrator 输出流的瘦事件），按 kind:text 去重时把富字段回填到已
      // 保留的条目上，避免「先到的瘦事件吃掉后到的富事件」。
      const kept = visible[keptIndex] as T & Pick<ToolTraceEvent, 'toolName' | 'detail'>
      const duplicate = event as T & Pick<ToolTraceEvent, 'toolName' | 'detail'>
      if (!kept.toolName && duplicate.toolName) kept.toolName = duplicate.toolName
      if (!kept.detail && duplicate.detail) kept.detail = duplicate.detail
      continue
    }
    keptIndexByKey.set(key, visible.length)
    visible.push({ ...event, text })
  }
  return visible
}

export function sanitizeInternalAgentDisplayText(text: string | null | undefined, fallback: string): string {
  const raw = String(text || '').trim()
  if (!raw) return fallback
  return isInternalToolTraceText(raw) ? fallback : raw
}
