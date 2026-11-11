import { useWorkspace } from '../../stores/useWorkspace'
import { create } from 'zustand'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useDocTabs } from '../../stores/useDocTabs'
import { requestWorkbenchModeOpen } from './mode-transition'

type Restore = () => void
type Entry = { label: string; mode: WorkbenchMode; restore: Restore }
export const useReferenceReturn = create<{ entry: Entry | null; destination: WorkbenchMode | null }>(() => ({ entry: null, destination: null }))
const positions = new Map<string, { mode: WorkbenchMode; capture: () => Restore }>()
export function registerReturnPosition(key: string, capture: () => Restore, mode: WorkbenchMode = 'document') {
  const owner = { mode, capture }
  positions.set(key, owner)
  return () => { if (positions.get(key) === owner) positions.delete(key) }
}
let expectedMode: WorkbenchMode | null = null
export function clearReferenceReturn() { expectedMode = null; useReferenceReturn.setState({ entry: null, destination: null }) }
useMode.subscribe((state, before) => {
  if (state.workbenchMode === before.workbenchMode && state.splitMode === before.splitMode) return
  if (expectedMode && (state.workbenchMode === expectedMode || state.splitMode === expectedMode)) expectedMode = null
  else clearReferenceReturn()
})

export function captureReferenceOrigin(mode: WorkbenchMode = useMode.getState().workbenchMode): Entry {
  const { activeTabId, splitTabId, focusedPaneTabId, tabs } = useDocTabs.getState()
  const restorePositions = [...positions.values()].filter(p => p.mode === mode || p.mode === useMode.getState().splitMode).map(p => p.capture())
  const scrolls = [...document.querySelectorAll<HTMLElement>(`[data-workbench-mode-panel="${mode}"] *`)]
    .filter(el => el.scrollTop || el.scrollLeft).map(el => ({ el, top: el.scrollTop, left: el.scrollLeft }))
  return { mode, label: mode === 'document' ? tabs.find(t => t.id === (focusedPaneTabId || activeTabId))?.title.replace(/\.(md|canvas)$/i, '') || '文档' : { browser: '浏览器', rss: 'RSS', calendar: '日历' }[mode], restore: () => {
    restorePositions.forEach(restore => restore())
    const liveTabs = useDocTabs.getState()
    if (mode === 'document') useWorkspace.getState().selectFile(liveTabs.tabs.find(t => t.id === activeTabId)?.path ?? null)
    if (liveTabs.tabs.some(t => t.id === activeTabId)) {
      liveTabs.setActiveTab(activeTabId)
      liveTabs.setSplitTab(liveTabs.tabs.some(t => t.id === splitTabId) ? splitTabId : null)
      if (focusedPaneTabId && liveTabs.tabs.some(t => t.id === focusedPaneTabId)) liveTabs.setFocusedPaneTab(focusedPaneTabId)
    }
    scrolls.forEach(({ el, top, left }) => { if (el.isConnected) { el.scrollTop = top; el.scrollLeft = left } })
  } }
}
export function rememberReferenceOrigin(entry: Entry, target: WorkbenchMode) {
  expectedMode = useMode.getState().workbenchMode === target || useMode.getState().splitMode === target ? null : target
  useReferenceReturn.setState({ entry, destination: target })
}
export function returnFromReference() {
  const entry = useReferenceReturn.getState().entry
  if (!entry) return
  clearReferenceReturn()
  entry.restore()
  requestWorkbenchModeOpen(entry.mode)
}
