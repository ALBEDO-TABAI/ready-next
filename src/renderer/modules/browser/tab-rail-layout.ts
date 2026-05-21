export interface TabRailLayoutMetrics {
  inactiveWidth: number
  inactiveMinWidth: number
  activeCompactWidth: number
  activeCompactMinWidth: number
}

export interface ActiveTabSurfaceMetrics {
  width: number
  minWidth: number
}

export interface ActiveTabSlotMetrics {
  width: number
  minWidth: number
}

type ActiveTabMode = 'compact' | 'primed' | 'expanded' | 'editing'
type RefreshDockMode = 'idle' | 'primed' | 'revealed'

const ACTIVE_TAB_EXPANDED_WIDTH = 420
const ACTIVE_TAB_EXPANDED_MIN_WIDTH = 320
const REFRESH_DOCK_COMPACT_WIDTH = 30
const REFRESH_DOCK_REVEALED_WIDTH = 86
const ACTIVE_TAB_INNER_GAP = 6

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

export function getActiveTabSurfaceMetrics(
  layoutMetrics: TabRailLayoutMetrics,
  activeTabMode: ActiveTabMode,
): ActiveTabSurfaceMetrics {
  if (activeTabMode === 'expanded' || activeTabMode === 'editing') {
    return {
      width: ACTIVE_TAB_EXPANDED_WIDTH,
      minWidth: ACTIVE_TAB_EXPANDED_MIN_WIDTH,
    }
  }

  return {
    width: layoutMetrics.activeCompactWidth,
    minWidth: layoutMetrics.activeCompactMinWidth,
  }
}

export function getActiveTabSlotMetrics(
  layoutMetrics: TabRailLayoutMetrics,
  activeTabMode: ActiveTabMode,
  refreshDockMode: RefreshDockMode,
): ActiveTabSlotMetrics {
  const surfaceMetrics = getActiveTabSurfaceMetrics(layoutMetrics, activeTabMode)
  const refreshDockVisible = activeTabMode === 'expanded' || activeTabMode === 'editing' || refreshDockMode !== 'idle'
  const refreshDockWidth = !refreshDockVisible
    ? 0
    : refreshDockMode === 'revealed'
      ? REFRESH_DOCK_REVEALED_WIDTH
      : REFRESH_DOCK_COMPACT_WIDTH

  return {
    width: surfaceMetrics.width + refreshDockWidth + (refreshDockVisible ? ACTIVE_TAB_INNER_GAP : 0),
    minWidth: surfaceMetrics.minWidth + refreshDockWidth + (refreshDockVisible ? ACTIVE_TAB_INNER_GAP : 0),
  }
}
