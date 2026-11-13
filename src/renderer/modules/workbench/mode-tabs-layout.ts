import type { WorkbenchMode } from '../../stores/useMode'
import { WORKBENCH_MODE_ORDER } from './mode-split'

export interface WorkbenchModeTabLayout {
  displayModes: WorkbenchMode[]
  visualIndexByMode: Record<WorkbenchMode, number>
  activeIndex: number
  splitIndex: number | null
  thumbStart: number
  thumbSpan: number
}

export function resolveWorkbenchModeTabLayout(
  activeMode: WorkbenchMode,
  splitMode: WorkbenchMode | null,
): WorkbenchModeTabLayout {
  const hasSplitMode = Boolean(splitMode && splitMode !== activeMode)
  const displayModes = [...WORKBENCH_MODE_ORDER]

  if (hasSplitMode && splitMode) {
    const activeOriginalIndex = WORKBENCH_MODE_ORDER.indexOf(activeMode)
    const splitOriginalIndex = WORKBENCH_MODE_ORDER.indexOf(splitMode)
    const withoutSplit = displayModes.filter((mode) => mode !== splitMode)
    const activeDisplayIndex = withoutSplit.indexOf(activeMode)
    const insertIndex = splitOriginalIndex > activeOriginalIndex
      ? activeDisplayIndex + 1
      : activeDisplayIndex

    withoutSplit.splice(insertIndex, 0, splitMode)
    displayModes.splice(0, displayModes.length, ...withoutSplit)
  }

  const visualIndexByMode = Object.fromEntries(
    WORKBENCH_MODE_ORDER.map((mode) => [mode, displayModes.indexOf(mode)]),
  ) as Record<WorkbenchMode, number>
  const activeIndex = visualIndexByMode[activeMode]
  const splitIndex = hasSplitMode && splitMode ? visualIndexByMode[splitMode] : null
  const thumbStart = splitIndex === null ? activeIndex : Math.min(activeIndex, splitIndex)
  const thumbSpan = splitIndex === null ? 1 : Math.abs(activeIndex - splitIndex) + 1

  return {
    displayModes,
    visualIndexByMode,
    activeIndex,
    splitIndex,
    thumbStart,
    thumbSpan,
  }
}
