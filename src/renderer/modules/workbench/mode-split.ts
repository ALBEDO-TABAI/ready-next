import type { WorkbenchMode } from '../../stores/useMode'

export const WORKBENCH_MODE_ORDER: WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']

export function resolveWorkbenchSplitToggle({
  workbenchMode,
  splitMode,
  requestedMode,
}: {
  workbenchMode: WorkbenchMode
  splitMode: WorkbenchMode | null
  requestedMode: WorkbenchMode
}): WorkbenchMode | null {
  if (requestedMode === workbenchMode) return splitMode
  return splitMode === requestedMode ? null : requestedMode
}

export function isWorkbenchModePairActive({
  workbenchMode,
  splitMode,
  firstMode,
  secondMode,
}: {
  workbenchMode: WorkbenchMode
  splitMode: WorkbenchMode | null
  firstMode: WorkbenchMode
  secondMode: WorkbenchMode
}): boolean {
  if (!splitMode) return false
  return (
    (workbenchMode === firstMode && splitMode === secondMode) ||
    (workbenchMode === secondMode && splitMode === firstMode)
  )
}
