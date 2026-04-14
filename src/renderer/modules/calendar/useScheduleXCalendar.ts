import { useEffect, useMemo, useRef, useState, createElement } from 'react'
import { createPortal } from 'react-dom'
import { createViewWeek, createViewMonthGrid, createViewDay, createCalendar } from '@schedule-x/calendar'
import { createCurrentTimePlugin } from '@schedule-x/current-time'
import { createCalendarControlsPlugin } from '@schedule-x/calendar-controls'
import { Temporal } from '@js-temporal/polyfill'

import type { CalendarPortalDescriptor } from '../../components/calendar/CalendarWorkbenchShell'
import type { CalendarSource } from '../../components/calendar/CalendarSources'
import SXTimeGridEvent from '../../components/calendar/SXTimeGridEvent'
import SXMonthGridEvent from '../../components/calendar/SXMonthGridEvent'
import {
  eventToSX,
  sxEventToEvent,
  sourcesToCalendars,
  SX_VIEW_NAMES,
  temporalToDate,
} from '../../components/calendar/schedule-x-utils'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'

function toPlainDateLike(date: Date) {
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  })
}

interface UseScheduleXCalendarParams {
  hasActivated: boolean
  isActive: boolean
  currentDate: Date
  viewType: ViewType
  sources: CalendarSource[]
  events: CalendarEvent[]
  eventsRef: React.MutableRefObject<CalendarEvent[]>
  enabledSourceIds: Set<string>
  handleOpenEditModal: (event: CalendarEvent) => void
  handleUpdateEvent: (id: string, updates: Partial<CalendarEvent>) => void
  onQuickCardRequest: (payload: { date: Date; hour?: number }) => void
}

export function useScheduleXCalendar({
  hasActivated,
  isActive,
  currentDate,
  viewType,
  sources,
  events,
  eventsRef,
  enabledSourceIds,
  handleOpenEditModal,
  handleUpdateEvent,
  onQuickCardRequest,
}: UseScheduleXCalendarParams) {
  const sxContainerRef = useRef<HTMLDivElement | null>(null)
  const calendarAppRef = useRef<any>(null)
  const controlsPluginRef = useRef<any>(null)
  const [sxError, setSxError] = useState<string | null>(null)
  const [sxReady, setSxReady] = useState(false)
  const [customPortals, setCustomPortals] = useState<CalendarPortalDescriptor[]>([])

  useEffect(() => {
    if (!hasActivated) return undefined
    const container = sxContainerRef.current
    if (!container) return undefined

    try {
      const controlsPlugin = createCalendarControlsPlugin()
      const app = createCalendar({
        views: [createViewWeek(), createViewDay(), createViewMonthGrid()],
        defaultView: SX_VIEW_NAMES[viewType],
        events: [],
        calendars: sourcesToCalendars(sources),
        locale: 'zh-CN',
        isResponsive: false,
        selectedDate: toPlainDateLike(currentDate),
        dayBoundaries: { start: '06:00', end: '21:00' },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        callbacks: {
          onEventClick: (sxEvent: Record<string, unknown>) => {
            const original = eventsRef.current.find((e) => e.id === String(sxEvent.id))
            if (original) {
              handleOpenEditModal(original)
            } else {
              const parsed = sxEventToEvent(sxEvent)
              handleOpenEditModal({
                id: String(sxEvent.id),
                title: parsed.title || '',
                startTime: parsed.startTime ?? new Date(),
                endTime: parsed.endTime ?? new Date(),
                calendarId: parsed.calendarId || '',
                color: parsed.color || '#5B8DEF',
                description: parsed.description,
                allDay: parsed.allDay,
                contentType: parsed.contentType,
                platform: parsed.platform,
                publishStatus: parsed.publishStatus,
              })
            }
          },
          onDoubleClickDateTime: (dateTime: unknown) => {
            const date = temporalToDate(dateTime)
            onQuickCardRequest({ date, hour: date.getHours() })
          },
          onDoubleClickDate: (date: unknown) => {
            const d = temporalToDate(date)
            onQuickCardRequest({ date: d, hour: 9 })
          },
          onEventUpdate: (sxEvent: Record<string, unknown>) => {
            const eventId = String(sxEvent.id)
            const parsed = sxEventToEvent(sxEvent)
            handleUpdateEvent(eventId, {
              startTime: parsed.startTime,
              endTime: parsed.endTime,
            })
          },
          onRangeUpdate: () => {},
        },
      }, [
        createCurrentTimePlugin(),
        controlsPlugin,
      ])

      const registerCustomComponent = (name: string, Comp: React.ComponentType<any>) => {
        ;(app as any)._setCustomComponentFn(name, (wrapperElement: HTMLElement, props: any) => {
          setCustomPortals((prev) => {
            const ccid = (wrapperElement as { dataset?: { ccid?: string } })?.dataset?.ccid
            if (!ccid) return prev
            return [
              ...prev.filter((portal) => (portal.wrapper as { dataset?: { ccid?: string } })?.dataset?.ccid !== ccid),
              { component: Comp, props, wrapper: wrapperElement },
            ]
          })
        })
      }

      registerCustomComponent('timeGridEvent', SXTimeGridEvent)
      registerCustomComponent('monthGridEvent', SXMonthGridEvent)

      app.render(container)
      calendarAppRef.current = app
      controlsPluginRef.current = controlsPlugin

      const theme = document.documentElement.getAttribute('data-theme')
      try {
        app.setTheme(theme === 'dark' ? 'dark' : 'light')
      } catch {
        // ignore
      }

      setSxReady(true)

      return () => {
        app.destroy()
        calendarAppRef.current = null
        controlsPluginRef.current = null
        setSxReady(false)
        setCustomPortals([])
      }
    } catch (err) {
      setSxError(err instanceof Error ? err.message : String(err))
      return undefined
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActivated])

  useEffect(() => {
    const app = calendarAppRef.current
    if (!app || !isActive) return
    const filteredEvents = events.filter(e => enabledSourceIds.has(e.calendarId))
    const sxEvents = filteredEvents.map(eventToSX)
    try {
      app.events.set(sxEvents as any)
    } catch (err) {
      console.warn('SX events.set error:', err)
    }
  }, [enabledSourceIds, events, isActive, sxReady])

  useEffect(() => {
    const app = calendarAppRef.current
    if (!app || !isActive) return
    const cals = sourcesToCalendars(sources)
    try {
      const a = app as any
      if (a.$app?.config?.calendars) {
        a.$app.config.calendars.value = cals
      }
    } catch (err) {
      console.warn('SX calendars sync error:', err)
    }
  }, [isActive, sources, sxReady])

  useEffect(() => {
    const plugin = controlsPluginRef.current
    if (!plugin || !isActive) return
    const sxViewName = SX_VIEW_NAMES[viewType]
    try {
      plugin.setView(sxViewName)
    } catch (err) {
      console.warn('SX setView error:', err)
    }
  }, [isActive, viewType, sxReady])

  useEffect(() => {
    const plugin = controlsPluginRef.current
    if (!plugin || !isActive) return
    try {
      plugin.setDate(toPlainDateLike(currentDate) as any)
    } catch (err) {
      console.warn('SX setDate error:', err)
    }
  }, [currentDate, isActive, sxReady])

  useEffect(() => {
    const app = calendarAppRef.current
    if (!app || !isActive) return
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme')
      try {
        app.setTheme(theme === 'dark' ? 'dark' : 'light')
      } catch {
        // ignore
      }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [isActive, sxReady])

  const customPortalNodes = useMemo(
    () => customPortals.map((portal, index) => createPortal(createElement(portal.component, portal.props), portal.wrapper, `calendar-portal-${index}`)),
    [customPortals],
  )

  return {
    sxContainerRef,
    customPortalNodes,
    sxError,
    sxReady,
  }
}
