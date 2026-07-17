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

function filename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function suggestedMarkdownName(title: string): string {
  const name = title || '新文档'
  return /\.[^./\\]+$/.test(name) ? name : `${name}.md`
}

export async function saveDocumentTabSnapshot(input: {
  tab: SavableDocumentTab
  api: DocumentSaveApi
  setTabPath(id: string, path: string): void
  renameTab(id: string, title: string): void
  commitTabSaveSnapshot(id: string, expectedContent: string, writtenContent: string): boolean
}): Promise<DocumentSaveOutcome> {
  const snapshot = input.tab.content
  let savedPath = input.tab.path

  if (savedPath) {
    const result = await input.api.writeFile(savedPath, snapshot)
    if (!result.success) return { status: 'error', error: result.error || '文档保存失败' }
  } else {
    const result = await input.api.saveFileAs({
      content: snapshot,
      suggestedName: suggestedMarkdownName(input.tab.title),
    })
    if (!result.success || !result.path) {
      return result.error ? { status: 'error', error: result.error } : { status: 'cancelled' }
    }
    savedPath = result.path
    input.setTabPath(input.tab.id, savedPath)
    input.renameTab(input.tab.id, filename(savedPath))
  }

  const committed = input.commitTabSaveSnapshot(input.tab.id, snapshot, snapshot)
  return { status: committed ? 'saved' : 'stale', path: savedPath }
}
