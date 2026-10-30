import { parseReadyUri, type ReadyRef } from '../../../../shared/ready-ref'
import { useDocTabs } from '../../../stores/useDocTabs'
import { useWorkspace } from '../../../stores/useWorkspace'
import { openReadyRef } from '../open-ready-ref'
import { requestWorkbenchModeOpen } from '../mode-transition'
import type { SearchResultItem } from './query'
export type PreviewTarget = ReadyRef | { kind: 'draft'; tabId: string }

export async function searchResultTarget(item: SearchResultItem): Promise<PreviewTarget> {
  if (item.draft) return { kind: 'draft', tabId: item.draft.tabId }
  const parsed = parseReadyUri(item.path)
  if (parsed.ok) return parsed.ref
  const location = await window.electronAPI.objects.resolvePath(item.path)
  return { kind: /\.md$/i.test(item.path) ? 'page' : /\.canvas$/i.test(item.path) ? 'canvas' : 'file', id: location.objectId }
}
export async function openObjectTarget(target: PreviewTarget): Promise<void> {
  if (target.kind !== 'draft') return openReadyRef(target)
  const tab = useDocTabs.getState().tabs.find(tab => tab.id === target.tabId)
  if (!tab) throw new Error('草稿已关闭')
  useDocTabs.getState().setActiveTab(tab.id)
  useWorkspace.getState().selectFile(tab.path)
  requestWorkbenchModeOpen('document')
}
