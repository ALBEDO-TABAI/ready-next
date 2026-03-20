import { useEffect, type MutableRefObject } from 'react'

import type { CalendarSource } from '../../components/calendar/CalendarSources'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'
import { createCalendarAgentHandler } from './calendar-agent-handler'

interface UseCalendarAgentAdapterParams {
  enabled?: boolean
  currentDate: Date
  viewType: ViewType
  editingEvent: CalendarEvent | null
  sources: CalendarSource[]
  eventsRef: MutableRefObject<CalendarEvent[]>
  loadCalendarData: (force?: boolean) => Promise<void>
  setVisibleRange: (start: string, end: string) => void
  setSelectedSessionEvent: (payload: { id?: string | null; title?: string | null }) => void
  setConflictState: (payload: { hasConflict?: boolean; reason?: string | null }) => void
  markSessionMutation: () => void
  getDateRange: (date: Date, view: ViewType) => { start: Date; end: Date }
}

export function useCalendarAgentAdapter(params: UseCalendarAgentAdapterParams): void {
  const {
    enabled = true,
    currentDate,
    viewType,
    editingEvent,
    sources,
    eventsRef,
    loadCalendarData,
    setVisibleRange,
    setSelectedSessionEvent,
    setConflictState,
    markSessionMutation,
    getDateRange,
  } = params

  useEffect(() => {
    if (!enabled) return
    const { start, end } = getDateRange(currentDate, viewType)
    setVisibleRange(start.toISOString(), end.toISOString())
  }, [currentDate, enabled, getDateRange, setVisibleRange, viewType])

  useEffect(() => {
    if (!enabled) return
    setSelectedSessionEvent({
      id: editingEvent?.id ?? null,
      title: editingEvent?.title ?? null,
    })
  }, [editingEvent, enabled, setSelectedSessionEvent])

  useEffect(() => {
    if (!enabled) return
    return registerModuleAgentHandler(
      'calendar',
      createCalendarAgentHandler({
        currentDate,
        viewType,
        editingEvent,
        sources,
        getEvents: () => eventsRef.current,
        loadCalendarData,
        setConflictState,
        markSessionMutation,
        getDateRange,
        calendarApi: window.electronAPI?.calendar,
      }),
    )
  }, [
    currentDate,
    enabled,
    editingEvent,
    eventsRef,
    getDateRange,
    loadCalendarData,
    markSessionMutation,
    setConflictState,
    sources,
    viewType,
  ])
}
