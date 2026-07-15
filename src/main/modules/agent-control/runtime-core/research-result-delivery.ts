import {
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../tools-runtime/tool-result-types'

export interface ResearchSearchResultItem {
  title: string
  url: string
  snippet: string
  source: string
}

export interface ResearchSearchDelivery {
  results: ResearchSearchResultItem[]
  queriedAt: string
  acquisitionKind: 'discovery' | 'answer'
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    // silent-catch: malformed result URLs are excluded from the structured research delivery.
    return null
  }
}

function compactText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text
}

export function captureResearchSearchDelivery(
  toolName: string,
  output: ToolExecutionOutput,
  queriedAt = new Date(),
): ResearchSearchDelivery | null {
  if (toolName !== 'web_search') return null
  const normalized = normalizeToolExecutionOutput(output)
  const data = recordValue(normalized.data)
  const rows = Array.isArray(data?.results) ? data.results : []
  const results = rows.flatMap((row) => {
    const record = recordValue(row)
    const url = validHttpUrl(record?.url)
    if (!record || !url) return []
    return [{
      title: compactText(record.title, 240) || url,
      url,
      snippet: compactText(record.snippet, 800),
      source: compactText(record.source, 40),
    }]
  }).slice(0, 5)
  if (results.length === 0) return null
  return {
    results,
    queriedAt: queriedAt.toISOString(),
    acquisitionKind: data?.acquisitionKind === 'answer' ? 'answer' : 'discovery',
  }
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1')
}

function sourceLabel(value: string): string {
  if (value === 'anysearch') return 'AnySearch'
  if (value === 'tavily') return 'Tavily'
  if (value === 'ddg') return 'DuckDuckGo'
  return value || '网页搜索'
}

function hasQueryTime(text: string, queriedAt: string): boolean {
  const date = queriedAt.slice(0, 10)
  return /查询时间|检索时间/i.test(text) || (Boolean(date) && text.includes(date))
}

/**
 * A successful search must remain visible even when the model only emits a
 * completion acknowledgement. This transform is deliberately conservative:
 * an answer that already cites a returned URL is preserved, while a missing
 * source list is appended from the structured tool result.
 */
export function ensureResearchSearchResultDelivered(
  candidateText: string,
  delivery: ResearchSearchDelivery | null | undefined,
): string {
  const text = String(candidateText || '').trim()
  if (!delivery || delivery.results.length === 0) return text

  const citesReturnedResult = delivery.results.some((result) => text.includes(result.url))
  if (citesReturnedResult) {
    return hasQueryTime(text, delivery.queriedAt)
      ? text
      : `${text}\n\n查询时间：${delivery.queriedAt}`
  }

  const resultLines = delivery.results.flatMap((result, index) => [
    `${index + 1}. [${escapeMarkdownLabel(result.title)}](${result.url})`,
    result.snippet ? `   ${result.snippet}` : '',
    `   来源：${sourceLabel(result.source)}`,
  ]).filter(Boolean)
  const resultBlock = [
    '查询结果：',
    ...resultLines,
    '',
    `查询时间：${delivery.queriedAt}`,
  ].join('\n')
  return text ? `${text}\n\n${resultBlock}` : resultBlock
}

export function recoverResearchSearchDeliveryAfterTimeout(
  error: unknown,
  delivery: ResearchSearchDelivery | null | undefined,
): string | null {
  const message = error instanceof Error ? error.message : String(error || '')
  if (!/delivery_wall_clock_exceeded/.test(message) || delivery?.acquisitionKind !== 'answer') {
    return null
  }
  const delivered = ensureResearchSearchResultDelivered('', delivery)
  return delivered || null
}
