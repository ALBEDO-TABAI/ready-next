import type { WorkbenchMode } from '../../stores/useMode'

export const READY_WORKBENCH_MODE_CHANGE_EVENT = 'ready:workbench-mode-change-request'

export type WorkbenchModeOpenDecision =
  | { kind: 'already-visible' }
  | { kind: 'replace-split'; splitMode: WorkbenchMode }
  | { kind: 'switch-primary'; workbenchMode: WorkbenchMode }

export function resolveWorkbenchModeOpenDecision(
  state: { workbenchMode: WorkbenchMode; splitMode: WorkbenchMode | null },
  targetMode: WorkbenchMode,
): WorkbenchModeOpenDecision {
  if (state.workbenchMode === targetMode || state.splitMode === targetMode) {
    return { kind: 'already-visible' }
  }
  if (state.splitMode) {
    return { kind: 'replace-split', splitMode: targetMode }
  }
  return { kind: 'switch-primary', workbenchMode: targetMode }
}

export function applyWorkbenchModeOpenDecision(
  state: { workbenchMode: WorkbenchMode; splitMode: WorkbenchMode | null },
  targetMode: WorkbenchMode,
  actions: {
    setSplitMode: (mode: WorkbenchMode) => void
    requestModeChange: (mode: WorkbenchMode) => void
  },
): WorkbenchModeOpenDecision {
  const decision = resolveWorkbenchModeOpenDecision(state, targetMode)
  if (decision.kind === 'replace-split') {
    actions.setSplitMode(decision.splitMode)
  } else if (decision.kind === 'switch-primary') {
    actions.requestModeChange(decision.workbenchMode)
  }
  return decision
}

export function requestWorkbenchModeChange(mode: WorkbenchMode): void {
  window.dispatchEvent(new CustomEvent(READY_WORKBENCH_MODE_CHANGE_EVENT, {
    detail: { mode },
  }))
}
