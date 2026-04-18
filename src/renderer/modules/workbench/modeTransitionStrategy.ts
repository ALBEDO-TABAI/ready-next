import type { WorkbenchMode } from '../../stores/useMode'

export type ModeTransitionStrategy = 'same-mode' | 'dom-only' | 'with-browser'

export function resolveModeTransitionStrategy(
  from: WorkbenchMode,
  to: WorkbenchMode,
): ModeTransitionStrategy {
  if (from === to) return 'same-mode'
  if (from === 'browser' || to === 'browser') return 'with-browser'
  return 'dom-only'
}
