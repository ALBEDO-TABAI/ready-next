import { isReadyBoardFile } from '../../../shared/ready-board'
import { normalizeDocTabPathKey, type DocTab } from '../../stores/useDocTabs'

export function shouldHandleSelectedDocument(input: {
  isActive: boolean
  selectedFile: string | null
  tabs: readonly DocTab[]
  activeTabId: string
}): boolean {
  if (!input.isActive || !input.selectedFile) return false
  const selectedPathKey = normalizeDocTabPathKey(input.selectedFile)
  const activeTab = input.tabs.find((tab) => tab.id === input.activeTabId)
  if (normalizeDocTabPathKey(activeTab?.path) === selectedPathKey) return false

  const keepBoardActive = isReadyBoardFile(activeTab?.path) && !isReadyBoardFile(input.selectedFile)
  if (!keepBoardActive) return true
  return !input.tabs.some((tab) => normalizeDocTabPathKey(tab.path) === selectedPathKey)
}
