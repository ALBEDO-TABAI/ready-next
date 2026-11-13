import type { WorkbenchMode } from '../../stores/useMode'

export const READY_WORKBENCH_MODE_CHANGE_EVENT = 'ready:workbench-mode-change-request'

export type WorkbenchModeChangePresentation = 'animated' | 'immediate'

/** How long a mode change moves the content's scenes (and, in step, the sidebar's navigators, V23). The CSS animations
 *  that carry it (ritual-overlay.css, shell.css) use the same 280ms on cubic-bezier(0.24, 1, 0.36, 1). */
export const WORKBENCH_MODE_SCENE_TRANSITION_MS = 280

export function shouldAnimateWorkbenchModeTransition(
  presentation: WorkbenchModeChangePresentation,
  reducedMotion: boolean,
): boolean {
  return presentation === 'animated' && !reducedMotion
}

export interface WorkbenchModeChangeRequestDetail {
  mode: WorkbenchMode
  placement?: 'primary' | 'open'
  presentation?: WorkbenchModeChangePresentation
}

export type BrowserVisibilityTransition = 'enters' | 'leaves' | 'unchanged'

export function resolveBrowserVisibilityTransition(
  before: { workbenchMode: WorkbenchMode; splitMode: WorkbenchMode | null },
  after: { workbenchMode: WorkbenchMode; splitMode: WorkbenchMode | null },
): BrowserVisibilityTransition {
  const wasVisible = before.workbenchMode === 'browser' || before.splitMode === 'browser'
  const willBeVisible = after.workbenchMode === 'browser' || after.splitMode === 'browser'
  if (wasVisible === willBeVisible) return 'unchanged'
  return willBeVisible ? 'enters' : 'leaves'
}

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

export function requestWorkbenchModeChange(
  mode: WorkbenchMode,
  options: Omit<WorkbenchModeChangeRequestDetail, 'mode'> = {},
): void {
  window.dispatchEvent(new CustomEvent(READY_WORKBENCH_MODE_CHANGE_EVENT, {
    detail: { mode, ...options } satisfies WorkbenchModeChangeRequestDetail,
  }))
}

export function requestWorkbenchModeOpen(mode: WorkbenchMode): void {
  requestWorkbenchModeChange(mode, {
    placement: 'open',
    presentation: 'immediate',
  })
}
