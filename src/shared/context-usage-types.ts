export type ContextUsageWindowSource = 'explicit' | 'model' | 'fallback' | null

export interface ContextUsageSnapshot {
  usedInputTokens: number
  windowTokens: number | null
  ratio: number | null
  windowSource: ContextUsageWindowSource
  source: 'last_model_request'
  timestamp: string
}

export function buildContextUsageSnapshot(params: {
  inputTokens?: number | null
  windowTokens?: number | null
  windowSource?: ContextUsageWindowSource
  timestamp: string
}): ContextUsageSnapshot | null {
  const rawInputTokens = Number(params.inputTokens)
  if (!Number.isFinite(rawInputTokens) || rawInputTokens <= 0) return null
  const usedInputTokens = Math.ceil(rawInputTokens)

  const source = params.windowSource ?? null
  const rawWindow = Number(params.windowTokens)
  const usableWindow = (source === 'explicit' || source === 'model' || source === 'fallback')
    && Number.isFinite(rawWindow)
    && rawWindow > 0
  const windowTokens = usableWindow ? Math.floor(rawWindow) : null

  return {
    usedInputTokens,
    windowTokens,
    ratio: windowTokens ? usedInputTokens / windowTokens : null,
    windowSource: source,
    source: 'last_model_request',
    timestamp: params.timestamp,
  }
}

export function normalizeContextUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const expectedKeys = [
    'usedInputTokens',
    'windowTokens',
    'ratio',
    'windowSource',
    'source',
    'timestamp',
  ]
  const keys = Object.keys(candidate)
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))) {
    return null
  }
  if (candidate.source !== 'last_model_request'
    || typeof candidate.timestamp !== 'string'
    || !candidate.timestamp.trim()
    || !Number.isSafeInteger(candidate.usedInputTokens)
    || Number(candidate.usedInputTokens) <= 0
    || (candidate.windowTokens !== null
      && (!Number.isSafeInteger(candidate.windowTokens) || Number(candidate.windowTokens) <= 0))
    || (candidate.ratio !== null
      && (typeof candidate.ratio !== 'number' || !Number.isFinite(candidate.ratio)
        || candidate.ratio < 0))
    || !['explicit', 'model', 'fallback', null].includes(candidate.windowSource as never)) {
    return null
  }
  const normalized = buildContextUsageSnapshot({
    inputTokens: Number(candidate.usedInputTokens),
    windowTokens: candidate.windowTokens === null ? null : Number(candidate.windowTokens),
    windowSource: candidate.windowSource as ContextUsageWindowSource,
    timestamp: candidate.timestamp,
  })
  if (!normalized
    || normalized.windowTokens !== candidate.windowTokens
    || normalized.ratio !== candidate.ratio) return null
  return normalized
}
