import { captureNavigationScroll, restoreNavigationScroll } from './navigation-scroll'
import { calendarEventReadyRef } from '../../../shared/calendar-event-identity'
import { requestWorkbenchModeOpen } from './mode-transition'
import { onUserObjectOpen, withoutOpenRecording } from './navigation-open-event'
import { useRSSSession } from '../../stores/useRSSSession'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useCalendarSession } from '../../stores/useCalendarSession'
import { useEffect, useSyncExternalStore } from 'react'
import { NavigationController } from './navigation-controller'
import { recentNavigation, type NavigationEntry } from '../../../shared/navigation-history'
import { type ReadyRef } from '../../../shared/ready-ref'
import { useMode } from '../../stores/useMode'
import { useDocTabs } from '../../stores/useDocTabs'
import { useInkHistory, goBack as tabBack, goForward as tabForward, tabHistoryTarget } from '../document/ink/layout-state'
import { openReadyRefDestination } from './open-ready-ref'

export const navigationHistory = new NavigationController(() => window.electronAPI.navigationHistory)
const positions = new Map<string, () => ReadyRef | void>()
export function registerNavigationPosition(key: string, capture: () => ReadyRef | void) {
  positions.set(key, capture)
  return () => { if (positions.get(key) === capture) positions.delete(key) }
}
export function captureRegisteredNavigationRef(): ReadyRef | undefined {
  for (const capture of positions.values()) { const ref = capture(); if (ref) return ref }
  return undefined
}
export function captureNavigationPosition(): NavigationEntry | undefined {
  const state = navigationHistory.getSnapshot(), entry = state.entries[state.cursor]
  if (!entry) return
  let ref = entry.ref
  for (const capture of positions.values()) { const value = capture(); if (value?.kind === 'book-location' && entry.ref.kind === 'book-location' && value.book === entry.ref.book) ref = value }
  const anchor = captureNavigationScroll(entry.mode)
  return { ...entry, ref, anchor }
}
async function restore(entry: NavigationEntry) {
  await withoutOpenRecording(() => openReadyRefDestination(entry.ref, entry.mode, { record: false }))
  requestWorkbenchModeOpen(entry.mode)
  if (entry.ref.kind === 'web') {
    const position = entry.anchor.find(anchor => anchor.selector === 'browser')
    if (position) await window.electronAPI.navigationHistory.restoreBrowserPosition({ url: entry.ref.url, top: position.top, left: position.left })
  }
  await restoreNavigationScroll(entry)
}
export async function navigateHistory(direction: -1 | 1): Promise<void> {
  await navigationHistory.step(direction, restore, () => currentNavigationOrigin(), () => {
    const path = useMode.getState().workbenchMode === 'document' ? tabHistoryTarget(direction) : undefined
    if (!path) return undefined
    return { matches: async entry => {
      if (!('id' in entry.ref) || !['page', 'file', 'canvas'].includes(entry.ref.kind)) return false
      return (await window.electronAPI.objects.locate(entry.ref.id))?.path === path
    }, perform: () => withoutOpenRecording(direction === -1 ? tabBack : tabForward) }
  })
}
export const navigateBack = () => navigateHistory(-1)
export const navigateForward = () => navigateHistory(1)
export function navigationStatus() {
  const state = navigationHistory.getSnapshot(), local = useInkHistory.getState(), doc = useMode.getState().workbenchMode === 'document'
  const path = doc ? tabHistoryTarget(-1) : undefined
  return { canBack: doc && local.canBack || state.cursor > 0,
    canForward: doc && local.canForward || state.cursor < state.entries.length - 1,
    backTitle: path ? path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '') : state.entries[state.cursor - 1]?.title ?? null }
}
export function subscribeNavigation(listener: () => void) {
  const releases = [navigationHistory.subscribe(listener), useInkHistory.subscribe(listener), useMode.subscribe(listener)]
  return () => releases.forEach(release => release())
}
export function useNavigationHistory() {
  useEffect(() => { void navigationHistory.load().catch(error => console.error('[navigation] history could not be loaded', error)) }, [])
  useSyncExternalStore(navigationHistory.subscribe, navigationHistory.getSnapshot)
  useInkHistory(); useMode(state => state.workbenchMode)
  return { ...navigationStatus(), back: navigateBack, forward: navigateForward }
}
export const getRecentOpened = (limit = 20) => recentNavigation(navigationHistory.getSnapshot(), limit)

/** Capture the object actually visible before the first reference jump, not an unrelated persisted cursor. */
export async function currentNavigationOrigin(mode = useMode.getState().workbenchMode): Promise<NavigationEntry | undefined> {
  const stored = captureNavigationPosition()
  const base = { mode, openedAt: stored?.openedAt ?? Date.now(), anchor: captureNavigationScroll(mode) }
  if (mode === 'document') {
    const state = useDocTabs.getState(), tab = state.tabs.find(tab => tab.id === state.activeTabId)
    if (tab?.kind === 'library') { const ref = captureRegisteredNavigationRef(); return ref ? { ...base, title: stored?.title || '书籍', ref } : stored?.mode === mode ? stored : undefined }
    if (tab?.draftId) return { ...base, title: tab.title, ref: { kind: 'draft', id: tab.draftId } }
    if (tab?.path) {
      const id = tab.objectId ?? (await window.electronAPI.objects.resolvePath(tab.path)).objectId
      return { ...base, title: tab.title.replace(/\.(md|canvas)$/i, ''), ref: stored && 'id' in stored.ref && stored.ref.id === id ? stored.ref : { kind: /\.md$/i.test(tab.path) ? 'page' : /\.canvas$/i.test(tab.path) ? 'canvas' : 'file', id } }
    }
  }
  if (mode === 'rss') {
    const state = useRSSSession.getState()
    if (state.selectedItemId) return { ...base, title: state.selectedItemTitle || '资讯', ref: stored?.ref.kind === 'rss-item' && stored.ref.id === state.selectedItemId ? stored.ref : { kind: 'rss-item', id: state.selectedItemId } }
  }
  if (mode === 'browser') {
    const state = useBrowserTabs.getState(), tab = state.tabs.find(tab => tab.id === state.activeTabId)
    if (tab && /^https?:\/\//.test(tab.url)) {
      const position = await window.electronAPI.navigationHistory.browserPosition()
      return { ...base, title: tab.title || tab.url, ref: { kind: 'web', url: tab.url }, anchor: position?.url === tab.url ? [{ selector: 'browser', top: position.top, left: position.left }] : base.anchor }
    }
  }
  if (mode === 'calendar') {
    const state = useCalendarSession.getState()
    if (state.selectedEventId) {
      let allDay: boolean | undefined
      if (state.selectedEventId.includes('#')) {
        const snapshot = await window.electronAPI.calendar.snapshot()
        if (!snapshot.success || !snapshot.data) throw new Error(snapshot.error || '日程不可用')
        allDay = snapshot.data.events.find(event => event.id === state.selectedEventId!.split('#')[0])?.allDay
      }
      const ref = calendarEventReadyRef(state.selectedEventId, allDay)
      if (ref) return { ...base, title: state.selectedEventTitle || '日程', ref }
    }
  }
  return stored?.mode === mode ? stored : undefined
}
onUserObjectOpen(open => {
  const origin = captureNavigationPosition()
  void (async () => {
    const ref: ReadyRef = 'ref' in open ? open.ref : { kind: /\.md$/i.test(open.path) ? 'page' : /\.canvas$/i.test(open.path) ? 'canvas' : 'file', id: (await window.electronAPI.objects.resolvePath(open.path)).objectId }
    await navigationHistory.open({ mode: open.mode, ref, title: open.title, openedAt: Date.now(), anchor: [] }, async () => {}, origin)
  })().catch(error => console.error('[navigation] open could not be recorded', error))
})
