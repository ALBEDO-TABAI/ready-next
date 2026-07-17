const fittedTabKeys = new Map<string, string>()

export function getBrowserTabFitKey(bounds: { width: number; height: number } | null | undefined): string | null {
  if (!bounds) return null
  const width = Math.round(bounds.width)
  const height = Math.round(bounds.height)
  if (width <= 0 || height <= 0) return null
  return `${width}x${height}`
}

export function markFitted(tabId: string, fitKey: string): void {
  fittedTabKeys.set(tabId, fitKey)
}

export function isFitted(tabId: string, fitKey: string): boolean {
  return fittedTabKeys.get(tabId) === fitKey
}

export function clearFitted(tabId: string): void {
  fittedTabKeys.delete(tabId)
}

export function shouldClearFittedForTabUpdate(event: { type: string; loading?: boolean; url?: string }): boolean {
  return event.type === 'closed' || event.url !== undefined || event.loading === true
}

export function clearAll(): void {
  fittedTabKeys.clear()
}
