import type { WorkbenchMode } from '../../stores/useMode'

export const READY_WORKBENCH_MODE_CHANGE_EVENT = 'ready:workbench-mode-change-request'

export function requestWorkbenchModeChange(mode: WorkbenchMode): void {
  window.dispatchEvent(new CustomEvent(READY_WORKBENCH_MODE_CHANGE_EVENT, {
    detail: { mode },
  }))
}
