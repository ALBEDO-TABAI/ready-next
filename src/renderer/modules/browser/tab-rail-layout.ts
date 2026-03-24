export interface TabRailLayoutMetrics {
  inactiveWidth: number
  inactiveMinWidth: number
  activeCompactWidth: number
  activeCompactMinWidth: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getTabRailLayoutMetrics(tabCount: number): TabRailLayoutMetrics {
  const safeCount = Math.max(1, Math.floor(tabCount))
  const crowding = Math.max(0, safeCount - 3)

  const inactiveWidth = clamp(220 - crowding * 22, 132, 220)
  const inactiveMinWidth = clamp(140 - crowding * 12, 92, 140)
  const activeCompactWidth = clamp(220 - crowding * 16, 176, 220)
  const activeCompactMinWidth = clamp(168 - crowding * 8, 140, 168)

  return {
    inactiveWidth,
    inactiveMinWidth,
    activeCompactWidth,
    activeCompactMinWidth,
  }
}
