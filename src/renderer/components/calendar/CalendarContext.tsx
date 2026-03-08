import { createContext, useContext } from 'react'
import type { CalendarEvent } from './schedule-x-utils'

export interface CalendarContextValue {
  onEditEvent: (event: CalendarEvent) => void
  onUpdateEvent: (id: string, updates: Partial<CalendarEvent>) => void
  onDeleteEvent: (id: string) => void
  sources: { id: string; name: string; color: string }[]
}

const CalendarContext = createContext<CalendarContextValue>({
  onEditEvent: () => {},
  onUpdateEvent: () => {},
  onDeleteEvent: () => {},
  sources: [],
})

export const CalendarProvider = CalendarContext.Provider

export function useCalendarContext() {
  return useContext(CalendarContext)
}

export default CalendarContext
