export interface ResolvedWidgetTarget {
  resolved?: string
  unresolvedReason?: string
}

export function resolveControlledWidgetTarget(
  raw: string | undefined,
  candidates: string[],
): ResolvedWidgetTarget {
  if (candidates.length === 0) return {}
  const trimmed = String(raw || '').trim()
  if (!trimmed) {
    return { unresolvedReason: 'targetWidgetTitle 为空' }
  }
  if (candidates.includes(trimmed)) return { resolved: trimmed }
  const lower = trimmed.toLowerCase()
  const byCaseInsensitive = candidates.find((item) => item.toLowerCase() === lower)
  if (byCaseInsensitive) return { resolved: byCaseInsensitive }
  const bySubstring = candidates.find((item) => {
    const normalizedItem = item.toLowerCase()
    return normalizedItem.includes(lower) || lower.includes(normalizedItem)
  })
  if (bySubstring) return { resolved: bySubstring }
  return {
    unresolvedReason: `targetWidgetTitle "${trimmed}" 不在候选集，允许值：${candidates.join('、')}`,
  }
}
