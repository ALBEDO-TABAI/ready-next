import { create } from 'zustand'
import type { DocTab } from '../../../stores/useDocTabs'
import { DraftController, type DraftPort } from './controller'
import { migrateLegacyDrafts } from './migration'

export const useDraftUI = create<{ epoch: number; boot: 'loading' | 'ready' | 'failed'; error: string; saveTabId: string | null }>(() => ({
  epoch: 0, boot: 'loading', error: '', saveTabId: null,
}))
export let drafts: DraftController
let initialization: Promise<void> | undefined
export function configureDrafts(port: Omit<DraftPort, 'notify'>): void {
  drafts = new DraftController({ ...port, notify: () => useDraftUI.setState(state => ({ epoch: state.epoch + 1 })) })
}
export function initializeDrafts(): Promise<void> {
  if (initialization) return initialization
  useDraftUI.setState({ boot: 'loading', error: '' })
  initialization = (async () => {
    await migrateLegacyDrafts(localStorage, window.electronAPI.documentDrafts)
    await drafts.restore()
    useDraftUI.setState({ boot: 'ready' })
  })().catch(error => {
    initialization = undefined
    useDraftUI.setState({ boot: 'failed', error: String(error) })
    throw error
  })
  return initialization
}
export function draftChanged(tab: DocTab, previous?: DocTab): void {
  drafts.changed(tab, previous && !previous.isDirty ? previous.content : undefined)
}
export function reportDraftError(error: unknown): void { useDraftUI.setState({ error: String(error) }) }
export function requestDraftSave(id: string): void { useDraftUI.setState({ saveTabId: id }) }
