import { create } from 'zustand'
import { readStorage, writeStorage } from '../../../utils/storage'

/** Which view of the library the document navigator shows: the page tree or the file manager. */
export type DocumentNavigatorView = 'pages' | 'files'
const VIEW_KEY = 'ready-document-navigator-view-v1'

export const useDocumentNavigator = create<{ view: DocumentNavigatorView; setView(view: DocumentNavigatorView): void }>(set => ({
  view: readStorage(VIEW_KEY) === 'files' ? 'files' : 'pages',
  setView: view => { writeStorage(VIEW_KEY, view); set({ view }) },
}))
