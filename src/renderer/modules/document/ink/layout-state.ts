import { userOpenedObject } from '../../workbench/navigation-open-event'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { isoDate } from '../../../../shared/calendar/dates'
import { occurrences } from '../../../../shared/calendar/model'
import { dayOf } from '../../../../shared/calendar/tz'
import { useDocTabs } from '../../../stores/useDocTabs'

/** Whether the home view covers the editor, and a page created from the sidebar whose title should take focus.
 *  The sidebar's open state and width belong to the shell's one sidebar (W2 §2.2). */
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
  useInkLayout.getState().setHome(false)
  if (current?.path === path) return
  if (record) userOpenedObject({ mode: 'document', path, title: path.split(/[\\/]/).pop()!.replace(/\.(md|canvas)$/i, '') })
  const replaceable = current && current.kind !== 'library' && !current.isDirty && (current.path ? true : current.content === '')
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

export interface UpcomingEvent { key: string; eventId: string; title: string; start: number; allDay: boolean; color: string; day: string }

const zoneOf = (prefs: Record<string, unknown> | null | undefined) =>
  typeof prefs?.primaryTimeZone === 'string' ? prefs.primaryTimeZone : Intl.DateTimeFormat().resolvedOptions().timeZone

/** The next few occurrences in visible calendars over the coming week, refreshed while the shell is shown. */
export function useUpcomingEvents(active: boolean, limit = 4): UpcomingEvent[] | null {
  const [items, setItems] = useState<UpcomingEvent[] | null>(null)
  useEffect(() => {
    if (!active || !window.electronAPI?.calendar?.snapshot) return
    let alive = true
    const load = async () => {
      const result = await window.electronAPI.calendar.snapshot()
      if (!alive || !result.success || !result.data) return
      const { events, calendars, prefs } = result.data
      const zone = zoneOf(prefs)
      const visible = new Map(calendars.filter(calendar => calendar.visible).map(calendar => [calendar.id, calendar]))
      const now = Date.now(), today = dayOf(now, zone)
      const list = occurrences(events.filter(event => visible.has(event.calendarId)), today, today + 8, zone)
        .filter(item => item.allDay ? item.endDay >= today : item.end > now)
        .sort((a, b) => a.start - b.start)
        .slice(0, limit)
        .map(item => ({ key: item.key, eventId: item.event.id, title: item.event.title || '（无标题）', start: item.start, allDay: item.allDay,
          color: item.event.color || visible.get(item.event.calendarId)?.color || 'var(--studio-accent)',
          day: isoDate(item.startDay) }))
      setItems(list)
    }
    void load().catch(() => { if (alive) setItems([]) })
    const timer = window.setInterval(() => { void load().catch(() => {}) }, 60_000)
    const onFocus = () => { void load().catch(() => {}) }
    window.addEventListener('focus', onFocus)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [active, limit])
  return items
}

export function eventTimeLabel(item: UpcomingEvent, now = new Date()): string {
  const start = new Date(item.start)
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1)
  const day = sameDay(start, now) ? '' : sameDay(start, tomorrow) ? '明天 ' : `${start.getMonth() + 1}/${start.getDate()} `
  if (item.allDay) return day ? day.trim() : '全天'
  return `${day}${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
}
