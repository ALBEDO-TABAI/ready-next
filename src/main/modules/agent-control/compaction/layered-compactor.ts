export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3

const DEFAULT_L1_BUDGET = 16_000
const DEFAULT_L2_THRESHOLD = 0
const L1_MARKER = '[ready:l1-compacted]'

export interface LayeredCompactorMessage {
  role: string
  content: string
}

export type LayeredCompactorMetricName =
  | 'compactionCircuitBreak'
  | 'compactionL2Failed'

export interface LayeredCompactorMetricPayload {
  failureCount?: number
  threshold?: number
  estimatedTokens?: number
  error?: string
}

export interface LayeredCompactorOptions {
  l1Budget?: number
  l2Threshold?: number
  estimateTokens?: (messages: LayeredCompactorMessage[]) => number
  metric?: (name: LayeredCompactorMetricName, payload: LayeredCompactorMetricPayload) => void
  log?: (message: string, payload?: Record<string, unknown>) => void
}

export interface LayeredCompactor {
  compactL1(messages: readonly LayeredCompactorMessage[]): LayeredCompactorMessage[]
  maybeCompact(messages: readonly LayeredCompactorMessage[]): LayeredCompactorMessage[]
  circuitBroken(): boolean
}

export function createLayeredCompactor(options: LayeredCompactorOptions = {}): LayeredCompactor {
  const l1Budget = normalizePositiveInteger(options.l1Budget, DEFAULT_L1_BUDGET)
  const l2Threshold = normalizeNonNegativeInteger(options.l2Threshold, DEFAULT_L2_THRESHOLD)
  let consecutiveL2Failures = 0
  let isCircuitBroken = false
  let emittedCircuitBreak = false

  function compactL1(messages: readonly LayeredCompactorMessage[]): LayeredCompactorMessage[] {
    const normalized = normalizeMessages(messages)
    if (normalized.length === 0 || isAlreadyL1Compacted(normalized)) {
      return normalized
    }

    const totalChars = countMessageChars(normalized)
    if (totalChars <= l1Budget) {
      return normalized
    }

    const recentCount = normalized.length === 1 ? 1 : Math.min(4, Math.max(1, Math.ceil(normalized.length / 2)))
    const earlier = normalized.slice(0, -recentCount)
    const recent = normalized.slice(-recentCount)
    const recentBudget = Math.max(80, Math.floor(l1Budget * 0.7 / recent.length))
    const summaryBudget = Math.max(80, l1Budget - (recentBudget * recent.length))

    const output: LayeredCompactorMessage[] = []
    if (earlier.length > 0) {
      output.push({
        role: 'system',
        content: buildL1Summary(earlier, summaryBudget),
      })
    }
    for (const message of recent) {
      output.push({
        role: message.role,
        content: clipContent(message.content, recentBudget),
      })
    }
    return output
  }

  function maybeCompact(messages: readonly LayeredCompactorMessage[]): LayeredCompactorMessage[] {
    const l1Output = compactL1(messages)
    if (l2Threshold <= 0 || isCircuitBroken) {
      return l1Output
    }

    const estimatedTokens = options.estimateTokens?.(l1Output) ?? estimateCharsAsTokens(l1Output)
    if (estimatedTokens <= l2Threshold) {
      consecutiveL2Failures = 0
      return l1Output
    }

    try {
      return compactL2Stub(l1Output)
    } catch (error) {
      consecutiveL2Failures += 1
      emitMetric('compactionL2Failed', {
        failureCount: consecutiveL2Failures,
        threshold: l2Threshold,
        estimatedTokens,
        error: error instanceof Error ? error.message : String(error),
      })
      options.log?.('layered compactor L2 failed', {
        failureCount: consecutiveL2Failures,
        threshold: l2Threshold,
        estimatedTokens,
      })
      if (consecutiveL2Failures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
        isCircuitBroken = true
        if (!emittedCircuitBreak) {
          emittedCircuitBreak = true
          emitMetric('compactionCircuitBreak', {
            failureCount: consecutiveL2Failures,
            threshold: l2Threshold,
            estimatedTokens,
          })
        }
      }
      return l1Output
    }
  }

  function emitMetric(name: LayeredCompactorMetricName, payload: LayeredCompactorMetricPayload): void {
    try {
      options.metric?.(name, payload)
    } catch {
      // Metrics must never break compaction.
    }
  }

  return {
    compactL1,
    maybeCompact,
    circuitBroken: () => isCircuitBroken,
  }
}

function compactL2Stub(_messages: LayeredCompactorMessage[]): LayeredCompactorMessage[] {
  throw new Error('LayeredCompactor L2 compaction is not implemented in D phase')
}

function normalizeMessages(messages: readonly LayeredCompactorMessage[]): LayeredCompactorMessage[] {
  return messages.map((message) => ({
    role: String(message.role || 'unknown'),
    content: String(message.content || ''),
  }))
}

function isAlreadyL1Compacted(messages: readonly LayeredCompactorMessage[]): boolean {
  return messages[0]?.role === 'system' && messages[0]?.content.startsWith(L1_MARKER)
}

function countMessageChars(messages: readonly LayeredCompactorMessage[]): number {
  return messages.reduce((sum, message) => sum + message.role.length + message.content.length, 0)
}

function buildL1Summary(messages: readonly LayeredCompactorMessage[], budget: number): string {
  const previews = messages
    .slice(-3)
    .map((message) => `${message.role}: ${clipContent(message.content, 80)}`)
    .join('\n')
  return clipContent(`${L1_MARKER}\nolderMessages=${messages.length}\n${previews}`, budget)
}

function clipContent(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function estimateCharsAsTokens(messages: readonly LayeredCompactorMessage[]): number {
  return Math.ceil(countMessageChars(messages) / 4)
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) {
    return fallback
  }
  return Math.floor(value)
}
