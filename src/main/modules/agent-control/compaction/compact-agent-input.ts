import type { AgentInputItem } from '@openai/agents'
import {
  CONTEXT_SOFT_RATIO,
  estimateInputItemTokens,
} from '../../../../shared/context-budget-types'
import {
  CATALOG_HEADER as SKILL_CATALOG_HEADER,
  SKILL_CATALOG_REMINDER_MARKER,
} from '../system-reminders/skill-catalog-reminder'
import { kimiK3CompactionProviderData } from '../../../../shared/ai-providers/kimi-k3'
import { buildCompactionLedger } from './compaction-ledger'

export interface CompactOptions {
  windowTokens: number
  keepHeadCount?: number
  keepTailCount?: number
  maxToolResultTokens?: number
  force?: boolean
  summarize?: (earlier: AgentInputItem[]) => Promise<string> | string
}

export interface CompactResult {
  items: AgentInputItem[]
  compacted: boolean
  report: {
    beforeTokens: number
    afterTokens: number
    droppedItems: number
    truncatedToolResults: number
    summarized: boolean
  }
}

const DEFAULT_KEEP_TAIL_COUNT = 8
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 16_000

const CALL_RESULT_TYPES: Record<string, string> = {
  function_call: 'function_call_result',
  computer_call: 'computer_call_result',
  shell_call: 'shell_call_output',
  apply_patch_call: 'apply_patch_call_output',
  tool_search_call: 'tool_search_output',
}

const RESULT_CALL_TYPES: Record<string, string> = {
  ...Object.fromEntries(
  Object.entries(CALL_RESULT_TYPES).map(([callType, resultType]) => [resultType, callType]),
  ),
  // OpenAI Responses wire format. The SDK snapshot normally uses
  // function_call_result, but recovery checkpoints can be written after a
  // provider round-trip and must accept the lossless wire alias too.
  function_call_output: 'function_call',
}

/**
 * The same call/result contract used by compaction, exposed for durable
 * checkpoint validation. A clean boundary may not contain a pending call or
 * an orphan result because either shape makes the next provider request
 * ambiguous after restart.
 */
export function assertAgentInputToolPairIntegrity(items: readonly AgentInputItem[]): void {
  const pending = new Set<string>()
  for (const item of items) {
    const type = getItemType(item)
    if (!type) continue
    if (Object.hasOwn(CALL_RESULT_TYPES, type)) {
      const callId = getCallId(item, type)
      if (!callId) throw new Error('agent_input_tool_call_missing_id')
      const key = `${type}:${callId}`
      if (pending.has(key)) throw new Error('agent_input_duplicate_pending_tool_call')
      pending.add(key)
      continue
    }
    const callType = RESULT_CALL_TYPES[type]
    if (!callType) continue
    const callId = getCallId(item, type)
    if (!callId) throw new Error('agent_input_tool_result_missing_id')
    const key = `${callType}:${callId}`
    if (!pending.delete(key)) throw new Error('agent_input_orphan_tool_result')
  }
  if (pending.size > 0) throw new Error('agent_input_has_pending_tool_calls')
}

const IMAGE_EVICTED_PLACEHOLDER = '[ready:stale-screenshot-evicted] 历史截图为失效观察，已从上下文移除；需要当前页面视觉时重新截图。'

/**
 * 工具结果中的历史截图驱逐（2026-07-23 K3 HTTP 400 根因）：
 * input_image 的 base64 在语义估算里按 IMAGE_EST_TOKENS=1600 计，但按文本
 * 计 token 的 provider 会收全量字符（一张 1.4MB 截图 ≈ 1.05M tokens），
 * 单张即可超过 1M 硬顶且完全绕开软线判断。工具结果里的截图是即时观察，
 * 页面随后就变了——旧图无条件驱逐，keepNewest 时仅保留最新一张。
 * 只处理工具结果（function_call_result/computer_call_result 等）；
 * 用户消息里的图片附件是用户输入，不驱逐。
 */
export function evictStaleToolResultImages(
  items: AgentInputItem[],
  options: { keepNewest: boolean },
): { items: AgentInputItem[]; evictedImages: number } {
  let newestImageIndex = -1
  if (options.keepNewest) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (isToolResultItem(items[index]) && toolResultContainsInputImage(items[index])) {
        newestImageIndex = index
        break
      }
    }
  }
  let evictedImages = 0
  const output = items.map((item, index) => {
    if (index === newestImageIndex) return item
    if (!isToolResultItem(item) || !toolResultContainsInputImage(item)) return item
    evictedImages += 1
    return replaceToolResultImages(item)
  })
  return { items: evictedImages > 0 ? output : items, evictedImages }
}

function toolResultContainsInputImage(item: AgentInputItem): boolean {
  const output = (item as Record<string, unknown>).output
  if (!Array.isArray(output)) return false
  return output.some((part) => {
    if (!part || typeof part !== 'object') return false
    const record = part as Record<string, unknown>
    return record.type === 'input_image'
      || (record.type === 'computer_screenshot' && typeof record.data === 'string' && record.data.length > 1_000)
  })
}

function replaceToolResultImages(item: AgentInputItem): AgentInputItem {
  const record = item as Record<string, unknown>
  const output = record.output as unknown[]
  const replaced = output.map((part) => {
    if (!part || typeof part !== 'object') return part
    const partRecord = part as Record<string, unknown>
    if (partRecord.type === 'input_image') {
      return { type: 'input_text', text: IMAGE_EVICTED_PLACEHOLDER }
    }
    if (partRecord.type === 'computer_screenshot' && typeof partRecord.data === 'string' && partRecord.data.length > 1_000) {
      return { ...partRecord, data: IMAGE_EVICTED_PLACEHOLDER }
    }
    return part
  })
  return { ...record, output: replaced } as AgentInputItem
}

function isLegacySkillCatalogReminderItem(item: AgentInputItem): boolean {
  if (!item || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  if (record.role !== 'system') return false
  try {
    const content = JSON.stringify(record.content ?? '')
    return content.includes(SKILL_CATALOG_REMINDER_MARKER)
      && content.includes(SKILL_CATALOG_HEADER)
  } catch {
    // silent-catch: non-serializable content cannot match the versioned legacy catalog marker.
    return false
  }
}

export function stripLegacySkillCatalogReminderItems(items: AgentInputItem[]): {
  items: AgentInputItem[]
  droppedItems: number
} {
  const stripped = items.filter((item) => !isLegacySkillCatalogReminderItem(item))
  return { items: stripped, droppedItems: items.length - stripped.length }
}

export function compactAgentInputItems(
  items: AgentInputItem[],
  options: CompactOptions,
): CompactResult | Promise<CompactResult> {
  const windowTokens = normalizePositiveInteger(options.windowTokens, 1)
  const maxToolResultTokens = normalizePositiveInteger(
    options.maxToolResultTokens,
    DEFAULT_MAX_TOOL_RESULT_TOKENS,
  )
  const beforeTokens = estimateInputItemTokens(items)
  const legacyCatalogs = stripLegacySkillCatalogReminderItems(items)
  // 2026-07-23 K3 HTTP 400 根因修复：截图 base64 在语义估算里恒为 1600 tokens，
  // 但按文本计 token 的 provider（K3 coding 端点）会收全量字符（1.38M 字符
  // ≈ 1.05M tokens > 1M 硬顶）。工具结果里的历史截图按浏览器纪律本就是
  // 失效观察——无条件驱逐旧图、只保留最新一张，且最新一张也受物理上限约束。
  // 这是对 R1“低于软线不截断”合同的显式例外：R1 保护的是动作后的文本读回执，
  // 失效截图不属于该类。用户消息里的图片附件不在此列。
  const imageEviction = evictStaleToolResultImages(legacyCatalogs.items, { keepNewest: true })
  const sourceItems = imageEviction.items
  const sourceTokens = estimateInputItemTokens(sourceItems)

  // 2026-07-03 真机回归 R1 根因修复：单结果超限截断只允许在真实上下文压力
  // 下发生。此前无条件执行——59k/200k（远低于 0.8 软线）时也把两个 ~27k 的
  // page_map 读回执整体替换成占位符，模型在关键动作后拿到信息真空，直接
  // 盲宣告完成。低于软线时原样放行；到达软线（或 force）才进入截断+压缩。
  if (!options.force && sourceTokens <= windowTokens * CONTEXT_SOFT_RATIO) {
    return {
      items: sourceItems,
      compacted: legacyCatalogs.droppedItems > 0 || imageEviction.evictedImages > 0,
      report: {
        beforeTokens,
        afterTokens: sourceTokens,
        droppedItems: legacyCatalogs.droppedItems,
        truncatedToolResults: imageEviction.evictedImages,
        summarized: false,
      },
    }
  }

  const truncated = truncateOversizedToolResults(sourceItems, maxToolResultTokens)

  const workingItems = truncated.items
  const afterTruncateTokens = estimateInputItemTokens(workingItems)
  if (!options.force && afterTruncateTokens <= windowTokens * CONTEXT_SOFT_RATIO) {
    return buildResult({
      items: workingItems,
      beforeTokens,
      droppedItems: legacyCatalogs.droppedItems,
      truncatedToolResults: truncated.truncatedToolResults + imageEviction.evictedImages,
      summarized: false,
    })
  }

  const keepHeadCount = resolveKeepHeadCount(workingItems, options.keepHeadCount)
  const keepTailCount = Math.min(
    workingItems.length,
    normalizeNonNegativeInteger(options.keepTailCount, DEFAULT_KEEP_TAIL_COUNT),
  )
  const tailStart = Math.max(keepHeadCount, workingItems.length - keepTailCount)
  const initialKeep = workingItems.map((_, index) => index < keepHeadCount || index >= tailStart)
  const paired = applyToolPairIntegrity(workingItems, initialKeep)
  const droppedItems = workingItems.filter((_, index) => !paired.keep[index])

  if (droppedItems.length === 0) {
    return buildResult({
      items: workingItems,
      beforeTokens,
      droppedItems: legacyCatalogs.droppedItems,
      truncatedToolResults: truncated.truncatedToolResults + imageEviction.evictedImages,
      summarized: false,
    })
  }

  const summary = options.summarize?.(droppedItems) ?? buildDefaultSummary(droppedItems)
  if (isPromiseLike(summary)) {
    return summary.then((resolvedSummary) => buildCompactedResult({
      items: workingItems,
      keep: paired.keep,
      tailStart,
      summary: resolvedSummary,
      beforeTokens,
      droppedItems: legacyCatalogs.droppedItems + droppedItems.length,
      truncatedToolResults: truncated.truncatedToolResults + imageEviction.evictedImages,
    }))
  }

  return buildCompactedResult({
    items: workingItems,
    keep: paired.keep,
    tailStart,
    summary,
    beforeTokens,
    droppedItems: legacyCatalogs.droppedItems + droppedItems.length,
    truncatedToolResults: truncated.truncatedToolResults + imageEviction.evictedImages,
  })
}

export function normalizeSessionSnapshotForSeed(items: AgentInputItem[]): AgentInputItem[] {
  const legacyCatalogs = stripLegacySkillCatalogReminderItems(items)
  const normalized = applyToolPairIntegrity(
    legacyCatalogs.items,
    legacyCatalogs.items.map(() => true),
  )
  if (legacyCatalogs.droppedItems === 0 && normalized.droppedItems === 0) return items
  return legacyCatalogs.items.filter((_, index) => normalized.keep[index])
}

function buildCompactedResult(input: {
  items: AgentInputItem[]
  keep: boolean[]
  tailStart: number
  summary: string
  beforeTokens: number
  droppedItems: number
  truncatedToolResults: number
}): CompactResult {
  const headItems: AgentInputItem[] = []
  const tailItems: AgentInputItem[] = []
  for (let index = 0; index < input.items.length; index += 1) {
    if (!input.keep[index]) continue
    if (index < input.tailStart) {
      headItems.push(input.items[index])
    } else {
      tailItems.push(input.items[index])
    }
  }

  return buildResult({
    items: [...headItems, createSummaryItem(input.summary, input.items), ...tailItems],
    beforeTokens: input.beforeTokens,
    droppedItems: input.droppedItems,
    truncatedToolResults: input.truncatedToolResults,
    summarized: true,
  })
}

function buildResult(input: {
  items: AgentInputItem[]
  beforeTokens: number
  droppedItems: number
  truncatedToolResults: number
  summarized: boolean
}): CompactResult {
  return {
    items: input.items,
    compacted: input.droppedItems > 0 || input.truncatedToolResults > 0 || input.summarized,
    report: {
      beforeTokens: input.beforeTokens,
      afterTokens: estimateInputItemTokens(input.items),
      droppedItems: input.droppedItems,
      truncatedToolResults: input.truncatedToolResults,
      summarized: input.summarized,
    },
  }
}

function applyToolPairIntegrity(
  items: readonly AgentInputItem[],
  initialKeep: readonly boolean[],
): { keep: boolean[]; droppedItems: number } {
  const keep = [...initialKeep]
  const callsByKey = new Map<string, number[]>()
  const resultsByKey = new Map<string, number[]>()

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const key = getToolPairKey(item)
    if (!key) continue
    const target = isToolCallItem(item) ? callsByKey : resultsByKey
    target.set(key, [...(target.get(key) ?? []), index])
  }

  const keys = new Set([...callsByKey.keys(), ...resultsByKey.keys()])
  for (const key of keys) {
    const callIndices = callsByKey.get(key) ?? []
    const resultIndices = resultsByKey.get(key) ?? []
    const pairIndices = [...callIndices, ...resultIndices]
    const pairComplete = callIndices.length > 0 && resultIndices.length > 0
    const keptCount = pairIndices.filter((index) => keep[index]).length

    if (!pairComplete || (keptCount > 0 && keptCount < pairIndices.length)) {
      for (const index of pairIndices) {
        keep[index] = false
      }
    }
  }

  dropReasoningBeforeDroppedCalls(items, keep)

  return {
    keep,
    droppedItems: keep.reduce((count, isKept) => count + (isKept ? 0 : 1), 0),
  }
}

function dropReasoningBeforeDroppedCalls(items: readonly AgentInputItem[], keep: boolean[]): void {
  for (let index = 0; index < items.length; index += 1) {
    if (keep[index] || !isToolCallItem(items[index])) continue
    let previous = index - 1
    while (previous >= 0 && keep[previous] && getItemType(items[previous]) === 'reasoning') {
      keep[previous] = false
      previous -= 1
    }
  }
}

function truncateOversizedToolResults(
  items: AgentInputItem[],
  maxToolResultTokens: number,
): { items: AgentInputItem[]; truncatedToolResults: number } {
  let truncatedToolResults = 0
  const output = items.map((item) => {
    if (!isToolResultItem(item)) return item
    // 带图的工具结果由 evictStaleToolResultImages 独占管理：其体量由图片
    // 主导，整体替换会摧毁"保留最新观察"的驱逐语义。
    if (toolResultContainsInputImage(item)) return item
    const tokens = estimateInputItemTokens([item])
    if (tokens <= maxToolResultTokens) return item
    truncatedToolResults += 1
    return truncateToolResultItem(item, tokens, maxToolResultTokens)
  })

  return {
    items: truncatedToolResults > 0 ? output : items,
    truncatedToolResults,
  }
}

// 截断 stub 必须保留有界的原文开头：零内容占位符曾让模型在关键动作后拿到
// 信息真空（2026-07-03 R1 盲宣告完成、2026-07-23 研究计划回执被清空后反复
// 重注册计划）。开头摘录给模型留下"这条结果大致是什么"的锚点。
const TRUNCATED_RESULT_HEAD_CHARS = 600

function truncatedResultHead(value: unknown): string {
  const text = typeof value === 'string' ? value : extractOutputTextParts(value)
  const head = text.trim().slice(0, TRUNCATED_RESULT_HEAD_CHARS)
  return head ? `\n[截断前开头 ${TRUNCATED_RESULT_HEAD_CHARS} 字符] ${head}` : ''
}

function extractOutputTextParts(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const part of value) {
    if (part && typeof part === 'object') {
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  return parts.join(' ')
}

function truncateToolResultItem(
  item: AgentInputItem,
  tokens: number,
  maxToolResultTokens: number,
): AgentInputItem {
  const placeholder = `[ready:tool-result-truncated] Original result estimate ${tokens} tokens exceeded ${maxToolResultTokens} tokens.`
  const record = item as Record<string, unknown>
  switch (record.type) {
    case 'function_call_result':
      return { ...record, output: `${placeholder}${truncatedResultHead(record.output)}` } as AgentInputItem
    case 'shell_call_output': {
      const firstOutput = Array.isArray(record.output) ? record.output[0] as Record<string, unknown> | undefined : undefined
      return {
        ...record,
        output: [{
          stdout: `${placeholder}${truncatedResultHead(firstOutput?.stdout)}`,
          stderr: '',
          outcome: { type: 'exit', exitCode: null },
        }],
      } as AgentInputItem
    }
    case 'apply_patch_call_output':
      return { ...record, output: `${placeholder}${truncatedResultHead(record.output)}` } as AgentInputItem
    case 'computer_call_result':
      return {
        ...record,
        output: { type: 'computer_screenshot', data: placeholder },
      } as AgentInputItem
    case 'tool_search_output':
      return { ...record, tools: [{ truncated: true, summary: placeholder }] } as unknown as AgentInputItem
    default:
      return item
  }
}

function resolveKeepHeadCount(items: readonly AgentInputItem[], override: number | undefined): number {
  if (override !== undefined) return Math.min(items.length, normalizeNonNegativeInteger(override, 0))

  let count = 0
  while (count < items.length && getMessageRole(items[count]) === 'system') {
    count += 1
  }
  if (count < items.length && getMessageRole(items[count]) === 'user') {
    count += 1
  }
  return count
}

function buildDefaultSummary(items: readonly AgentInputItem[]): string {
  // 2026-07-23 失忆回归修复：占位摘要必须携带确定性操作台账（搜索/写入/
  // 计划/摘录），否则压缩后的模型只剩原始任务指令，会重做已完成的工作。
  return [
    '[ready:context-compacted]',
    `Earlier context items compacted: ${items.length}.`,
    buildCompactionLedger(items),
    'Tool call/result pairs were preserved only when both sides remained in the kept context.',
  ].filter(Boolean).join('\n')
}

function createSummaryItem(summary: string, sourceItems: AgentInputItem[]): AgentInputItem {
  const providerData = kimiK3CompactionProviderData(sourceItems)
  return {
    role: 'user',
    content: summary,
    ...(providerData ? { providerData } : {}),
  } as AgentInputItem
}

function getToolPairKey(item: AgentInputItem): string | null {
  const type = getItemType(item)
  if (!type) return null
  const callType = isToolCallItem(item) ? type : RESULT_CALL_TYPES[type]
  if (!callType) return null
  const callId = getCallId(item, type)
  if (!callId) return null
  return `${callType}:${callId}`
}

function getCallId(item: AgentInputItem, type: string): string | null {
  const record = item as Record<string, unknown>
  const primary = record.callId
  if (typeof primary === 'string' && primary.length > 0) return primary
  const fallback = record.call_id
  if (typeof fallback === 'string' && fallback.length > 0) return fallback
  const id = record.id
  if (typeof id === 'string' && id.length > 0) return id
  return null
}

function isToolCallItem(item: AgentInputItem): boolean {
  const type = getItemType(item)
  return type !== undefined && Object.hasOwn(CALL_RESULT_TYPES, type)
}

function isToolResultItem(item: AgentInputItem): boolean {
  const type = getItemType(item)
  return type !== undefined && Object.hasOwn(RESULT_CALL_TYPES, type)
}

function getItemType(item: AgentInputItem): string | undefined {
  const type = (item as Record<string, unknown>).type
  return typeof type === 'string' ? type : undefined
}

function getMessageRole(item: AgentInputItem): string | undefined {
  const role = (item as Record<string, unknown>).role
  return typeof role === 'string' ? role : undefined
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback
  return Math.max(1, Math.floor(value as number))
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback
  return Math.max(0, Math.floor(value as number))
}

function isPromiseLike(value: unknown): value is Promise<string> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}
