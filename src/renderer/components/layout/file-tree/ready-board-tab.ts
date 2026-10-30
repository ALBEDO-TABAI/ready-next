import { isImagePreviewPath, useDocTabs } from '../../../stores/useDocTabs'

export function isActiveReadyBoardTab(): boolean {
  const state = useDocTabs.getState()
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  return /\.canvas$/i.test(activeTab?.path ?? '')
}

export { isImagePreviewPath }
