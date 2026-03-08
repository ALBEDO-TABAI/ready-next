import type { CalendarEvent, CalendarSource } from '../database'
import { getDatabase } from '../database'

export interface CalendarEventCreateInput {
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start_time: number
  end_time: number
  all_day: number
}

export type CalendarEventUpdateInput = Partial<{
  title: string
  description: string | null
  location: string | null
  calendar_id: string
  all_day: number
  start_time: number
  end_time: number
}>

export class CalendarRepository {
  getSources(): CalendarSource[] {
    return getDatabase().getCalendarSources()
  }

  getEvents(startTime: number, endTime: number): CalendarEvent[] {
    return getDatabase().getCalendarEvents(startTime, endTime)
  }

  createEvent(event: CalendarEventCreateInput): string {
    return getDatabase().createCalendarEvent(event)
  }

  updateEvent(id: string, updates: CalendarEventUpdateInput): void {
    getDatabase().updateCalendarEvent(id, updates)
  }

  deleteEvent(id: string): void {
    getDatabase().deleteCalendarEvent(id)
  }
}
