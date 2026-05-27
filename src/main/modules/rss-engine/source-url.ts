export interface RSSSourceUrlLike {
  url: string
}

export function normalizeRSSSourceUrl(value: string): string | null {
  try {
    return new URL(value).href
  } catch {
    return null
  }
}

export function findExistingRSSSourceByUrl<T extends RSSSourceUrlLike>(
  sources: T[],
  url: string,
): T | null {
  const normalizedTarget = normalizeRSSSourceUrl(url)
  if (!normalizedTarget) return null
  return sources.find((source) => normalizeRSSSourceUrl(source.url) === normalizedTarget) || null
}
