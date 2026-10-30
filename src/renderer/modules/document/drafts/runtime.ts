import { create } from 'zustand'
import type { DocTab } from '../../../stores/useDocTabs'
import { DraftController, type DraftPort } from './controller'
import { migrateLegacyDrafts } from './migration'

export const useDraftUI = create<{ epoch: number; boot: 'loading' | 'ready' | 'failed' | 'no_vault'; error: string; saveTabId: string | null; saveParentPath?: string; saveRequestId?: string }>(() => ({
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
    // Drafts live in the vault: before one is configured this is a setup step, not a failure.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'no_vault') { useDraftUI.setState({ boot: 'no_vault', error: '' }); return }
    useDraftUI.setState({ boot: 'failed', error: String(error) })
    throw error
  })
  return initialization
}
/** First run and vault switches: drafts start (again) once the vault they live in is ready. */
export function watchDraftVault(): () => void {
  let root: string | null = null
  return window.electronAPI.vault.onChanged(state => {
    if (state.status !== 'ready' || (state.root === root && useDraftUI.getState().boot === 'ready')) return
    root = state.root
    initialization = undefined
    void initializeDrafts().catch(reportDraftError)
  })
}
export function draftChanged(tab: DocTab, previous?: DocTab): void {
  drafts.changed(tab, previous && !previous.isDirty ? previous.content : undefined)
}
export function reportDraftError(error: unknown): void { useDraftUI.setState({ error: String(error) }) }
let saveCompletion: ((path: string | null) => void) | undefined
export function completeDraftSave(path: string | null, requestId = useDraftUI.getState().saveRequestId): void {
  if (requestId !== useDraftUI.getState().saveRequestId) return
  const complete = saveCompletion
  saveCompletion = undefined
  useDraftUI.setState({ saveTabId: null, saveParentPath: undefined, saveRequestId: undefined })
  complete?.(path)
}
export function requestDraftSave(id: string, parentPath?: string): Promise<string | null> {
  completeDraftSave(null)
  return new Promise(resolve => {
    saveCompletion = resolve
    useDraftUI.setState({ saveTabId: id, saveParentPath: parentPath, saveRequestId: crypto.randomUUID() })
  })
}
