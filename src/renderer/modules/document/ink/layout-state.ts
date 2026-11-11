import { userOpenedObject } from '../../workbench/navigation-open-event'
import { create } from 'zustand'
import { useDocTabs } from '../../../stores/useDocTabs'

/** Whether 今日 (W6 §5, the document mode's system tab) covers the editor, and a page created from the sidebar whose
 *  title should take focus. The sidebar's open state and width belong to the shell's one sidebar (W2 §2.2). */
export const useInkLayout = create<{
  home: boolean
  /** A page created from the sidebar whose title should take focus when its header loads. */
  titleFocus: string | null
  setHome(home: boolean): void; setTitleFocus(objectId: string | null): void
}>(set => ({
  home: false, titleFocus: null,
  setTitleFocus: titleFocus => set({ titleFocus }),
  setHome: home => set({ home }),
}))

// Inkwell's navigation: opening a page from the sidebar, home, breadcrumb, file manager or a link replaces the page in
// the current tab (a clean file tab or an empty new tab keeps its place in the strip); ⌘/Ctrl-click opens a new tab and
// unsaved tabs are never replaced. Each tab keeps its own back/forward history, which moves with it when it is replaced.
type History = { back: string[]; forward: string[] }
const histories = new Map<string, History>()
export const useInkHistory = create<{ canBack: boolean; canForward: boolean }>(() => ({ canBack: false, canForward: false }))
function syncHistory() {
  const { activeTabId, tabs } = useDocTabs.getState()
  for (const id of histories.keys()) if (!tabs.some(tab => tab.id === id)) histories.delete(id)
  const history = activeTabId ? histories.get(activeTabId) : undefined
  useInkHistory.setState({ canBack: !!history?.back.length, canForward: !!history?.forward.length })
}
useDocTabs.subscribe((state, previous) => { if (state.activeTabId !== previous.activeTabId || state.tabs.length !== previous.tabs.length) syncHistory() })

export function openInCurrentTab(path: string, { newTab = false, record = true }: { newTab?: boolean; record?: boolean } = {}) {
  const state = useDocTabs.getState()
  const current = state.tabs.find(tab => tab.id === state.activeTabId)
  // 今日 is a tab of its own: what opens from it takes a tab rather than replacing the page behind it.
  const fromToday = useInkLayout.getState().home
  useInkLayout.getState().setHome(false)
  if (current?.path === path) return
  if (record) userOpenedObject({ mode: 'document', path, title: path.split(/[\\/]/).pop()!.replace(/\.(md|canvas)$/i, '') })
  const replaceable = current && current.kind !== 'library' && !current.isDirty && (current.path ? !fromToday : current.content === '')
  if (newTab || !replaceable || state.tabs.some(tab => tab.path === path)) { state.openTab(path); return }
  const history = histories.get(current.id) ?? { back: [], forward: [] }
  if (record && current.path) { history.back.push(current.path); history.forward.length = 0 }
  const slot = state.tabs.indexOf(current)
  state.openTab(path)
  const next = useDocTabs.getState()
  const created = next.tabs.findIndex(tab => tab.id === next.activeTabId)
  if (created >= 0 && created !== slot) next.reorderTabs(created, slot)
  if (next.activeTabId) histories.set(next.activeTabId, history)
  useDocTabs.getState().closeTab(current.id)
  syncHistory()
}
function step(from: 'back' | 'forward') {
  const { activeTabId, tabs } = useDocTabs.getState()
  const current = tabs.find(tab => tab.id === activeTabId)
  const history = activeTabId ? histories.get(activeTabId) : undefined
  const path = history?.[from].pop()
  if (!path || !current?.path || !history) return
  history[from === 'back' ? 'forward' : 'back'].push(current.path)
  openInCurrentTab(path, { record: false })
  syncHistory()
}
export function tabHistoryTarget(direction: -1 | 1): string | undefined {
  const id = useDocTabs.getState().activeTabId
  return id ? histories.get(id)?.[direction === -1 ? 'back' : 'forward'].at(-1) : undefined
}
export const goBack = () => step('back')
export const goForward = () => step('forward')
