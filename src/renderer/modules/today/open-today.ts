import { useInkLayout } from '../document/ink/layout-state'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'

/** 今日 is the document mode's system tab (W6 §5.1): the brand dot, ⌘K and the tab strip open it the same way. */
export function openToday(): void {
  useInkLayout.getState().setHome(true)
  requestWorkbenchModeOpen('document')
}
