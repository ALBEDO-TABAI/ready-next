import { useMode } from '../../../stores/useMode'

/**
 * Editor popups are portaled to the body and marked as native overlays. They show only while their editor's
 * workbench scene is the current one; otherwise a toolbar left over from a text selection would float over
 * another mode and keep the browser's web layer hidden.
 */
export function useSceneVisible(editor: () => Element | null | undefined): boolean {
  const mode = useMode(state => state.workbenchMode)
  const panel = editor()?.closest('[data-workbench-mode-panel]')
  return !panel || panel.getAttribute('data-workbench-mode-panel') === mode
}
