export function clampNumericInputValue(
  value: string,
  minAttr: string | null | undefined,
  maxAttr: string | null | undefined,
): string {
  const trimmed = value.trim()
  if (!trimmed) return value

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return value

  const min = minAttr != null && minAttr !== '' ? Number(minAttr) : null
  const max = maxAttr != null && maxAttr !== '' ? Number(maxAttr) : null

  let next = numeric
  if (min != null && Number.isFinite(min)) {
    next = Math.max(next, min)
  }
  if (max != null && Number.isFinite(max)) {
    next = Math.min(next, max)
  }

  return String(next)
}
