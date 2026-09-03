import {
  buildContextUsageSnapshot,
  type ContextUsageSnapshot,
} from '../../../../shared/context-usage-types'

export type CodexTokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown
  last: CodexTokenUsageBreakdown
  modelContextWindow: number | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function breakdown(value: unknown): CodexTokenUsageBreakdown | null {
  const candidate = record(value)
  const requiredKeys = [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ] as const
  const keys = candidate && Object.hasOwn(candidate, 'cacheWriteInputTokens')
    ? [...requiredKeys, 'cacheWriteInputTokens'] as const
    : requiredKeys
  if (!candidate || !exactKeys(candidate, keys)) return null
  if (requiredKeys.some((key) => !Number.isSafeInteger(candidate[key]) || Number(candidate[key]) < 0)) {
    return null
  }
  if (candidate.cacheWriteInputTokens !== undefined
    && (!Number.isSafeInteger(candidate.cacheWriteInputTokens)
      || Number(candidate.cacheWriteInputTokens) < 0)) return null
  const normalized: CodexTokenUsageBreakdown = {
    totalTokens: Number(candidate.totalTokens),
    inputTokens: Number(candidate.inputTokens),
    cachedInputTokens: Number(candidate.cachedInputTokens),
    cacheWriteInputTokens: Number(candidate.cacheWriteInputTokens ?? 0),
    outputTokens: Number(candidate.outputTokens),
    reasoningOutputTokens: Number(candidate.reasoningOutputTokens),
  }
  if (
    normalized.cachedInputTokens > normalized.inputTokens
    || normalized.cacheWriteInputTokens > normalized.inputTokens
    || normalized.reasoningOutputTokens > normalized.outputTokens
  ) return null
  return normalized
}

export function normalizeCodexThreadTokenUsage(value: unknown): CodexThreadTokenUsage | null {
  const candidate = record(value)
  const keys = candidate && Object.hasOwn(candidate, 'modelContextWindow')
    ? ['total', 'last', 'modelContextWindow']
    : ['total', 'last']
  if (!candidate || !exactKeys(candidate, keys)) return null
  const total = breakdown(candidate.total)
  const last = breakdown(candidate.last)
  const modelContextWindow = candidate.modelContextWindow ?? null
  if (
    !total
    || !last
    || (modelContextWindow !== null
      && (!Number.isSafeInteger(modelContextWindow) || Number(modelContextWindow) <= 0))
  ) return null
  for (const key of Object.keys(total) as Array<keyof CodexTokenUsageBreakdown>) {
    if (total[key] < last[key]) return null
  }
  return {
    total,
    last,
    modelContextWindow: modelContextWindow === null ? null : Number(modelContextWindow),
  }
}

export class CodexTurnUsageAccumulator {
  private latestTotal: CodexTokenUsageBreakdown | null = null
  private latestContextUsage: ContextUsageSnapshot | null = null

  observe(usage: CodexThreadTokenUsage, timestamp: string): void {
    if (this.latestTotal) {
      for (const key of Object.keys(usage.total) as Array<keyof CodexTokenUsageBreakdown>) {
        if (usage.total[key] < this.latestTotal[key]) throw new Error('codex_token_usage_total_regressed')
      }
    }
    this.latestTotal = { ...usage.total }
    if (usage.last.inputTokens <= 0) return
    const next = buildContextUsageSnapshot({
      inputTokens: usage.last.inputTokens,
      windowTokens: usage.modelContextWindow ?? this.latestContextUsage?.windowTokens ?? null,
      windowSource: usage.modelContextWindow !== null
        ? 'model'
        : this.latestContextUsage?.windowSource ?? null,
      timestamp,
    })
    if (next) this.latestContextUsage = next
  }

  snapshot(): ContextUsageSnapshot | null {
    return this.latestContextUsage ? { ...this.latestContextUsage } : null
  }
}
