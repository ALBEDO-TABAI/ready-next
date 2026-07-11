/**
 * 2026-07-10 activity-capsule L3 — 工具事件「详情」构建器（纯函数）。
 *
 * `ScopeRunTraceItem.text` 是单行预览（call 只有参数键名、result 截断 240
 * 字符），只够折叠态/时间线行使用；三级披露需要更完整的入参与输出。本模块
 * 把这两份 UI-facing 详情收敛到一个可测试的纯层：
 *   - call detail  = 过滤秘密键后的入参 JSON（值截断 + 数组/深度上限 + 总量上限）
 *   - result detail = 脱敏后的输出全文（上限 4000，仅在比预览多出信息时生成）
 *
 * 约束：
 *   - 秘密键过滤模式与 `formatToolCallTrace` 单一来源（本模块导出，调用侧引用）。
 *   - 所有产出经 `redactModelVisibleToolText`（宿主路径脱敏）后才离开 main。
 *   - 详情是展示层预览，不是档案：上限是硬编码常量，超限直接截断加省略号。
 */

import {
  normalizeToolExecutionOutput,
  type ToolExecutionResultLike,
} from '../tools-runtime/tool-result-types'
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'

/** 与 `formatToolCallTrace` 共用的秘密参数键过滤模式（单一来源）。 */
export const TOOL_TRACE_SECRET_KEY_PATTERN = /(?:key|token|secret|password|authorization)/i

const CALL_DETAIL_MAX_CHARS = 2000
const CALL_DETAIL_STRING_VALUE_MAX = 600
const CALL_DETAIL_ARRAY_MAX_ITEMS = 20
const CALL_DETAIL_MAX_DEPTH = 4
/** result 预览截断阈值 —— 与 `formatToolResultTrace` 的 slice(0, 240) 对齐。 */
const RESULT_PREVIEW_CHARS = 240
const RESULT_DETAIL_MAX_CHARS = 4000

function truncateString(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function sanitizeArgValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return truncateString(value, CALL_DETAIL_STRING_VALUE_MAX)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= CALL_DETAIL_MAX_DEPTH) return '…'
  if (Array.isArray(value)) {
    const head = value.slice(0, CALL_DETAIL_ARRAY_MAX_ITEMS).map((item) => sanitizeArgValue(item, depth + 1))
    if (value.length > CALL_DETAIL_ARRAY_MAX_ITEMS) head.push(`…(+${value.length - CALL_DETAIL_ARRAY_MAX_ITEMS} more)`)
    return head
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (TOOL_TRACE_SECRET_KEY_PATTERN.test(key)) continue
      out[key] = sanitizeArgValue(item, depth + 1)
    }
    return out
  }
  return String(value)
}

/**
 * 入参详情：过滤秘密键、逐值截断后 pretty-print。无可展示键时返回 null
 * （renderer 回退到 `name(argKeys)` 调用行）。
 */
export function buildToolCallDetail(args: Record<string, unknown>): string | null {
  const sanitized = sanitizeArgValue(args, 0) as Record<string, unknown>
  if (!sanitized || Object.keys(sanitized).length === 0) return null
  let serialized: string
  try {
    serialized = JSON.stringify(sanitized, null, 2)
  } catch {
    // silent-catch: non-serializable optional trace detail is omitted from the UI.
    return null
  }
  if (!serialized || serialized === '{}') return null
  return redactModelVisibleToolText(truncateString(serialized, CALL_DETAIL_MAX_CHARS))
}

/**
 * 输出详情：仅当全文比单行预览多出信息（超过预览截断长度或含换行）时生成，
 * 避免把 ≤240 字符的单行结果在事件里重复一遍。
 */
export function buildToolResultDetail(output: ToolExecutionResultLike): string | null {
  const text = redactModelVisibleToolText(String(normalizeToolExecutionOutput(output).text || '')).trim()
  if (!text) return null
  if (text.length <= RESULT_PREVIEW_CHARS && !text.includes('\n')) return null
  return truncateString(text, RESULT_DETAIL_MAX_CHARS)
}
