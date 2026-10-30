import { requestDraftSave } from './drafts/runtime'
import { useDocTabs } from '../../stores/useDocTabs'

export type SaveUntitledDocTabResult =
  | { success: true; path: string; fileName: string }
  | { success: false; reason: 'not-untitled' | 'cancelled'; error?: string }

/** A drop preselects a location; only the shared picker confirms publication. */
export async function saveUntitledDocTabToDirectory(tabId: string, targetDir: string): Promise<SaveUntitledDocTabResult> {
  const tab = useDocTabs.getState().tabs.find(item => item.id === tabId)
  if (!tab || tab.path || tab.kind === 'library') return { success: false, reason: 'not-untitled' }
  const path = await requestDraftSave(tabId, targetDir)
  return path ? { success: true, path, fileName: path.split(/[\\/]/).pop()! }
    : { success: false, reason: 'cancelled', error: '已取消保存，草稿已保留' }
}
