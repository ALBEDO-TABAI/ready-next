import type { DraftFinalizeInput } from '../../../../shared/document-drafts'
import { useDocTabs } from '../../../stores/useDocTabs'
import { drafts } from './runtime'

/** Both explicit save locations consume the same durable draft finalization. */
export async function finalizeDraftTab(tabId: string, input: DraftFinalizeInput) {
  const tab = useDocTabs.getState().tabs.find(tab => tab.id === tabId)
  if (!tab || tab.kind === 'library') throw new Error('文档标签不存在')
  if (!tab.isDirty && !drafts.status(tabId)) useDocTabs.getState().updateTabContent(tabId, tab.content)
  const saved = await drafts.finalize(tabId, input)
  useDocTabs.setState(state => ({ tabs: state.tabs.map(current => current.id === tabId && current.kind !== 'library'
    ? { ...current, title: saved.path.split(/[\\/]/).pop()!, ...(current.content === saved.content ? { content: saved.writtenContent, isDirty: false } : {}) }
    : current) }))
  return saved
}
