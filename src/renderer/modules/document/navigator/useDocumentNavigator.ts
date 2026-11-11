import { create } from 'zustand'
import { readStorage, writeStorage } from '../../../utils/storage'
import { useWorkspace } from '../../../stores/useWorkspace'

/** Which view of the library the document navigator shows: the page tree or the file manager. */
export type DocumentNavigatorView = 'pages' | 'files'
const VIEW_KEY = 'ready-document-navigator-view-v1'

export const useDocumentNavigator = create<{ view: DocumentNavigatorView; setView(view: DocumentNavigatorView): void }>(set => ({
  view: readStorage(VIEW_KEY) === 'files' ? 'files' : 'pages',
  setView: view => { writeStorage(VIEW_KEY, view); set({ view }) },
}))

/** 在文件视角中显示: the sidebar shows its 文件 view with the path selected and its folders expanded. */
export async function revealPathInFiles(path: string): Promise<void> {
  const workspace = useWorkspace.getState()
  if (!workspace.sidebarVisible) workspace.toggleSidebar()
  useDocumentNavigator.getState().setView('files')
  await workspace.revealFile(path)
}
