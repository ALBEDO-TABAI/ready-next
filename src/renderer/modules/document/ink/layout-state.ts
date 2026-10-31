import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { isoDate } from '../../../../shared/calendar/dates'
import { occurrences } from '../../../../shared/calendar/model'
import { dayOf } from '../../../../shared/calendar/tz'
import { useDocTabs } from '../../../stores/useDocTabs'
import { readStorage, writeStorage } from '../../../utils/storage'

const KEY = 'ready-ink-sidebar'
const MIN = 200, MAX = 420, DEFAULT = 248
const clamp = (width: number) => Math.round(Math.max(MIN, Math.min(MAX, width)))
function saved(): { open: boolean; width: number } {
  try {
    const value = JSON.parse(readStorage(KEY) || '{}') as { open?: unknown; width?: unknown }
    return { open: value.open !== false, width: typeof value.width === 'number' ? clamp(value.width) : DEFAULT }
  } catch { return { open: true, width: DEFAULT } }
}

/** The document shell's sidebar (open, width) and whether the home view covers the editor. */
export const useInkLayout = create<{
  open: boolean; width: number; resizing: boolean; home: boolean
  /** A page created from the sidebar whose title should take focus when its header loads. */
  titleFocus: string | null
  setOpen(open: boolean): void; setWidth(width: number): void; commitWidth(): void; resetWidth(): void
  setResizing(resizing: boolean): void; setHome(home: boolean): void; setTitleFocus(objectId: string | null): void
}>((set, get) => ({
  ...saved(), resizing: false, home: false, titleFocus: null,
  setTitleFocus: titleFocus => set({ titleFocus }),
  setOpen: open => { set({ open }); writeStorage(KEY, JSON.stringify({ open, width: get().width })) },
  setWidth: width => set({ width: clamp(width) }),
  commitWidth: () => writeStorage(KEY, JSON.stringify({ open: get().open, width: get().width })),
  resetWidth: () => { set({ width: DEFAULT }); writeStorage(KEY, JSON.stringify({ open: get().open, width: DEFAULT })) },
  setResizing: resizing => set({ resizing }),
  setHome: home => set({ home }),
}))

const KEEP_OPEN = 8
const recent: string[] = []
/** Keeps the most recently shown documents open; older ones close only when nothing in them is unsaved. */
export function recycleDocumentTabs(activeId: string) {
  const index = recent.indexOf(activeId)
  if (index >= 0) recent.splice(index, 1)
  recent.unshift(activeId)
  const state = useDocTabs.getState()
  if (state.tabs.length <= KEEP_OPEN) return
  const pinned = new Set([state.activeTabId, state.splitTabId, state.focusedPaneTabId].filter(Boolean))
  // Oldest first: tabs not shown since start, then the least recently shown.
  const order = [...state.tabs.filter(tab => !recent.includes(tab.id)).map(tab => tab.id), ...[...recent].reverse()]
  for (const id of order) {
    const current = useDocTabs.getState()
    if (current.tabs.length <= KEEP_OPEN) break
    const tab = current.tabs.find(item => item.id === id)
    if (!tab || pinned.has(id) || tab.isDirty || !tab.path) continue
    current.closeTab(id)
  }
}

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
