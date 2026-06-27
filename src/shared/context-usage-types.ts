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
