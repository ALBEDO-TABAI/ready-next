import { drafts, requestDraftSave } from './drafts/runtime'
export interface SavableDocumentTab {
  id: string
  path: string | null
  title: string
  content: string
}

export interface DocumentSaveApi {
  writeFile(path: string, content: string): Promise<{ success?: boolean; error?: string }>
  saveFileAs(input: { content: string; suggestedName: string }): Promise<{
    success?: boolean
    path?: string
    error?: string
  }>
}

export type DocumentSaveOutcome =
  | { status: 'saved'; path: string }
  | { status: 'stale'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }

export async function saveDocumentTabSnapshot(input: {
  tab: SavableDocumentTab
  api: DocumentSaveApi
  setTabPath(id: string, path: string): void
  renameTab(id: string, title: string): void
  commitTabSaveSnapshot(id: string, expectedContent: string, writtenContent: string): boolean
}): Promise<DocumentSaveOutcome> {
  if (!input.tab.path) { requestDraftSave(input.tab.id); return { status: 'cancelled' } }
  if (drafts?.status(input.tab.id)) {
    try { await drafts.flush(input.tab.id) } catch (error) { console.warn('[documentSaveRuntime] flush draft before save failed:', error instanceof Error ? error.message : String(error)); return { status: 'error', error: String(error) } }
  }
  if (drafts?.status(input.tab.id)?.conflict) return { status: 'error', error: '磁盘版本已变化，请在草稿入口处理冲突' }
  const snapshot = input.tab.content
  const savedPath = input.tab.path
  const result = await input.api.writeFile(savedPath, snapshot)
  if (!result.success) return { status: 'error', error: result.error || '文档保存失败' }

  const committed = input.commitTabSaveSnapshot(input.tab.id, snapshot, snapshot)
  return { status: committed ? 'saved' : 'stale', path: savedPath }
}
