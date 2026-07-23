import type { AgentInputItem } from '@openai/agents'

/**
 * 压缩操作台账：从被压缩（丢弃）的上下文条目中做**确定性**提取，生成一段
 * 有界的进度摘要，替代原先零信息的静态占位符。
 *
 * 2026-07-23 失忆回归的根因面：18 个关键词全部采集完成后触发首次压缩，
 * 占位摘要不携带任何"已完成什么"的信息，且此后每次请求重新压缩，新进度
 * 立即再次被丢——模型只剩原始任务指令，于是回到第一个关键词重做并反复
 * 重建计划。台账让每次压缩后的模型都能看到：搜过什么、写过什么文件、
 * 注册过什么计划、最近说过什么。
 *
 * 纪律：只做机械提取（工具名/关键参数/计数/原文摘录），不做语义概括——
 * 语义判断属于模型，可重复转换属于代码（CLAUDE.md §0）。
 */

const MAX_LEDGER_CHARS = 6_000
const MAX_SEARCH_ENTRIES = 100
const MAX_WRITE_ENTRIES = 40
const MAX_NAVIGATION_ENTRIES = 5
const MAX_TEXT_EXCERPTS = 3
const EXCERPT_CHARS = 240
const MAX_PARSED_ARGUMENT_CHARS = 32_000

const SEARCH_QUERY_TOOLS = new Set(['browser_search', 'web_search'])
const FILE_PATH_ARGUMENT_KEYS = ['file_path', 'path', 'relativePath', 'relative_path', 'target_path']

interface LedgerAccumulator {
  searches: string[]
  fileWrites: string[]
  researchOps: string[]
  skills: string[]
  navigations: string[]
  toolCounts: Map<string, number>
  assistantExcerpts: string[]
  userExcerpts: string[]
}

export function buildCompactionLedger(items: readonly AgentInputItem[]): string {
  const acc: LedgerAccumulator = {
    searches: [],
    fileWrites: [],
    researchOps: [],
    skills: [],
    navigations: [],
    toolCounts: new Map(),
    assistantExcerpts: [],
    userExcerpts: [],
  }
  for (const item of items) {
    collectItem(item, acc)
  }
  const sections: string[] = []
  if (acc.searches.length > 0) {
    sections.push(`已执行搜索（按序）：${numberedList(capMiddle(acc.searches, MAX_SEARCH_ENTRIES))}`)
  }
  if (acc.fileWrites.length > 0) {
    sections.push(`文件写入/修改：${capMiddle(dedupePreservingOrder(acc.fileWrites), MAX_WRITE_ENTRIES).join('；')}`)
  }
  if (acc.researchOps.length > 0) {
    sections.push(`研究计划操作：${acc.researchOps.join('；')}`)
  }
  if (acc.skills.length > 0) {
    sections.push(`已调用技能：${dedupePreservingOrder(acc.skills).join('、')}`)
  }
  if (acc.navigations.length > 0) {
    sections.push(`最近页面导航：${acc.navigations.slice(-MAX_NAVIGATION_ENTRIES).join('；')}`)
  }
  if (acc.toolCounts.size > 0) {
    const counts = [...acc.toolCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, count]) => `${name}×${count}`)
    sections.push(`其余工具调用统计：${counts.join('，')}`)
  }
  if (acc.assistantExcerpts.length > 0) {
    sections.push(`最近助手输出摘录：${acc.assistantExcerpts.slice(-MAX_TEXT_EXCERPTS).map((text) => `「${text}」`).join(' / ')}`)
  }
  if (acc.userExcerpts.length > 0) {
    sections.push(`被压缩的用户补充消息摘录：${acc.userExcerpts.slice(-MAX_TEXT_EXCERPTS).map((text) => `「${text}」`).join(' / ')}`)
  }
  if (sections.length === 0) return ''
  const body = sections.map((section) => `- ${section}`).join('\n')
  const ledger = [
    '以下为被压缩内容的确定性操作台账（代码提取，非模型生成）。继续前先核对台账，不要重做其中已完成的工作：',
    body,
  ].join('\n')
  if (ledger.length <= MAX_LEDGER_CHARS) return ledger
  return `${ledger.slice(0, MAX_LEDGER_CHARS)}\n-（台账超长，已截断）`
}

function collectItem(item: AgentInputItem, acc: LedgerAccumulator): void {
  const record = item as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : undefined
  if (type === 'reasoning') return
  if (type === 'function_call') {
    collectFunctionCall(record, acc)
    return
  }
  if (type && type !== 'message') return
  const role = typeof record.role === 'string' ? record.role : undefined
  const text = extractMessageText(record.content)
  if (!text || text.startsWith('[ready:context-compacted]')) return
  if (role === 'assistant') {
    pushExcerpt(acc.assistantExcerpts, text)
  } else if (role === 'user' && !text.startsWith('系统补充：') && !text.includes('<system-reminder>')) {
    pushExcerpt(acc.userExcerpts, text)
  }
}

function collectFunctionCall(record: Record<string, unknown>, acc: LedgerAccumulator): void {
  const name = typeof record.name === 'string' ? record.name : 'unknown_tool'
  const args = parseArguments(record.arguments)
  if (SEARCH_QUERY_TOOLS.has(name)) {
    const query = firstString(args, ['query', 'q', 'keyword'])
    if (query) {
      if (acc.searches[acc.searches.length - 1] !== query) acc.searches.push(query)
      return
    }
  }
  if (name === 'file_write' || name === 'file_edit' || name === 'file_append') {
    const path = firstString(args, FILE_PATH_ARGUMENT_KEYS)
    acc.fileWrites.push(path ? `${name} ${path}` : name)
    return
  }
  if (name === 'browser_research') {
    const action = firstString(args, ['action']) ?? 'start'
    const itemCount = Array.isArray(args?.work_items) ? args.work_items.length : null
    acc.researchOps.push(itemCount === null ? action : `${action}(${itemCount} items)`)
    return
  }
  if (name === 'use_skill') {
    const skill = firstString(args, ['skill', 'skill_id', 'name'])
    if (skill) {
      acc.skills.push(skill)
      return
    }
  }
  if (name === 'browser_navigate' || name === 'browser_open') {
    const url = firstString(args, ['url'])
    if (url) {
      acc.navigations.push(url.slice(0, 120))
      return
    }
  }
  acc.toolCounts.set(name, (acc.toolCounts.get(name) ?? 0) + 1)
}

function parseArguments(rawArguments: unknown): Record<string, unknown> | null {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments as Record<string, unknown>
  }
  if (typeof rawArguments !== 'string' || rawArguments.length > MAX_PARSED_ARGUMENT_CHARS) return null
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    // silent-catch: 非 JSON 参数（如损坏的流式拼接）只降级为计数统计。
    return null
  }
}

function firstString(args: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!args) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object') {
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  return parts.join(' ').trim()
}

function pushExcerpt(target: string[], text: string): void {
  const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text
  target.push(excerpt)
  if (target.length > MAX_TEXT_EXCERPTS * 2) target.splice(0, target.length - MAX_TEXT_EXCERPTS)
}

function numberedList(entries: string[]): string {
  return entries.map((entry, index) => `${index + 1}.${entry}`).join(' ')
}

function dedupePreservingOrder(entries: string[]): string[] {
  return [...new Set(entries)]
}

function capMiddle(entries: string[], max: number): string[] {
  if (entries.length <= max) return entries
  const headCount = Math.floor(max / 4)
  const tailCount = max - headCount
  return [
    ...entries.slice(0, headCount),
    `…（中间省略 ${entries.length - max} 条）…`,
    ...entries.slice(entries.length - tailCount),
  ]
}
