import { useState, useEffect, useCallback, useMemo, useRef, createElement } from 'react'
import { createPortal } from 'react-dom'
import { startOfWeek, startOfMonth, endOfMonth, endOfWeek, addDays, addMonths, subMonths, subDays, format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, Info, Plus } from 'lucide-react'
import { createViewWeek, createViewMonthGrid, createViewDay, createCalendar } from '@schedule-x/calendar'
import { createCurrentTimePlugin } from '@schedule-x/current-time'
import { createCalendarControlsPlugin } from '@schedule-x/calendar-controls'
import { Temporal } from '@js-temporal/polyfill'

import MiniCalendar from '../../components/calendar/MiniCalendar'
import CalendarSources from '../../components/calendar/CalendarSources'
import EventModal from '../../components/calendar/EventModal'
import { NewEventMenu, NewEventCard } from '../../components/calendar/NewEventMenu'
import SXTimeGridEvent from '../../components/calendar/SXTimeGridEvent'
import SXMonthGridEvent from '../../components/calendar/SXMonthGridEvent'
import { CalendarProvider } from '../../components/calendar/CalendarContext'
import type { CalendarContextValue } from '../../components/calendar/CalendarContext'
import type { EventModalData } from '../../components/calendar/EventModal'
import type { CalendarSource } from '../../components/calendar/CalendarSources'
import {
  eventToSX,
  sxEventToEvent,
  sourcesToCalendars,
  temporalToDate,
  SX_VIEW_NAMES,
} from '../../components/calendar/schedule-x-utils'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'
import { useCalendarAgentAdapter } from '../../modules/calendar/useCalendarAgentAdapter'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_SUPPORT_PANEL_WIDTH,
  WORKBENCH_TOOLBAR_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'
import { useCalendarSession } from '../../stores/useCalendarSession'

import '@schedule-x/theme-default/dist/index.css'
import '../../styles/schedule-x.css'

/**
 * Convert JS Date to Temporal.PlainDate for Schedule-X controls API.
 */
function toPlainDateLike(date: Date) {
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  })
}

// --- Default mock data ---

const DEFAULT_SOURCES: CalendarSource[] = [
  { id: 'work', name: '工作日程', color: '#5B8DEF', enabled: true },
  { id: 'content', name: '内容创作', color: '#E97A2B', enabled: true },
  { id: 'holiday', name: '节假日', color: '#34D399', enabled: true },
  { id: 'personal', name: '个人', color: '#8B5CF6', enabled: false },
]

function createDefaultEvents(): CalendarEvent[] {
  const now = new Date()
  const today9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0)
  const today10 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0)
  const today14 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0)
  const today15 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 30)
  const today16 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 0)
  const today17 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0)

  const tomorrow10 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0)
  const tomorrow11 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 11, 30)
  const tomorrow15 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 15, 0)
  const tomorrow16 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 0)

  return [
    {
      id: 'mock-1', calendarId: 'work', title: '团队周会',
      startTime: today9, endTime: today10,
      color: '#5B8DEF',
    },
    {
      id: 'mock-2', calendarId: 'content', title: '拍摄短视频',
      startTime: today14, endTime: today15,
      color: '#E97A2B',
      contentType: 'video',
      platform: ['douyin', 'bilibili'],
      publishStatus: 'scheduled',
    },
    {
      id: 'mock-3', calendarId: 'work', title: '产品评审会',
      startTime: today16, endTime: today17,
      color: '#5B8DEF',
    },
    {
      id: 'mock-4', calendarId: 'content', title: '写公众号文章',
      startTime: tomorrow10, endTime: tomorrow11,
      color: '#E97A2B',
      contentType: 'article',
      platform: ['wechat'],
      publishStatus: 'draft',
    },
    {
      id: 'mock-5', calendarId: 'personal', title: '健身',
      startTime: tomorrow15, endTime: tomorrow16,
      color: '#8B5CF6',
    },
  ]
}

// --- Module-level state cache for persistence across mode switches ---

interface CalendarModeCache {
  events: CalendarEvent[]
  sources: CalendarSource[]
  currentDate: Date
  selectedDate: Date | null
  viewType: ViewType
  isMock: boolean
  dataLoaded: boolean
}

let cachedState: CalendarModeCache | null = null

// --- ViewSelector dropdown ---

const VIEW_OPTIONS: { value: ViewType; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

function ViewSelector({ viewType, onViewTypeChange }: { viewType: ViewType; onViewTypeChange: (v: ViewType) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const currentLabel = VIEW_OPTIONS.find(o => o.value === viewType)?.label || '周'

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 10px', borderRadius: 10,
          border: '1px solid var(--border-input)', background: 'transparent',
          fontSize: 11, fontWeight: 500, color: 'var(--text-body)',
          cursor: 'pointer',
        }}
      >
        {currentLabel}
      </button>
      {open && (
        <div
          className="glass-surface-floating"
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4,
            background: 'var(--surface-floating-bg)', border: '1px solid var(--border-default)',
            borderRadius: 8, padding: 4, zIndex: 50,
            boxShadow: 'var(--surface-shadow)',
            minWidth: 60,
          }}
        >
          {VIEW_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => { onViewTypeChange(value); setOpen(false) }}
              style={{
                display: 'block', width: '100%',
                padding: '4px 10px', borderRadius: 6,
                border: 'none', cursor: 'pointer', textAlign: 'left',
                fontSize: 11, fontWeight: viewType === value ? 600 : 400,
                color: viewType === value ? 'var(--color-blue)' : 'var(--text-body)',
                background: viewType === value ? 'var(--color-blue-light)' : 'transparent',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Component ---

export default function CalendarMode({ isActive = true }: { isActive?: boolean }) {
  const visibleRangeStart = useCalendarSession((state) => state.visibleRangeStart)
  const visibleRangeEnd = useCalendarSession((state) => state.visibleRangeEnd)
  const selectedEventId = useCalendarSession((state) => state.selectedEventId)
  const selectedEventTitle = useCalendarSession((state) => state.selectedEventTitle)
  const lastMutationAt = useCalendarSession((state) => state.lastMutationAt)
  const conflictSnapshot = useCalendarSession((state) => state.conflictState)
  const setVisibleRange = useCalendarSession((state) => state.setVisibleRange)
  const setSelectedSessionEvent = useCalendarSession((state) => state.setSelectedEvent)
  const setConflictState = useCalendarSession((state) => state.setConflictState)
  const markSessionMutation = useCalendarSession((state) => state.markMutation)
  const [currentDate, setCurrentDate] = useState(cachedState?.currentDate ?? new Date())
  const [events, setEvents] = useState<CalendarEvent[]>(cachedState?.events ?? [])
  const [sources, setSources] = useState<CalendarSource[]>(cachedState?.sources?.length ? cachedState.sources : DEFAULT_SOURCES)
  const [selectedDate, setSelectedDate] = useState<Date | null>(cachedState?.selectedDate ?? null)
  const [isMock, setIsMock] = useState(cachedState?.isMock ?? false)
  const [viewType, setViewType] = useState<ViewType>(cachedState?.viewType ?? 'week')
  const [dataLoaded, setDataLoaded] = useState(cachedState?.dataLoaded ?? false)
  const [hasActivated, setHasActivated] = useState(isActive || Boolean(cachedState?.dataLoaded))

  // EventModal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create')
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null)
  const [modalDefaultHour, setModalDefaultHour] = useState<number | undefined>(undefined)
  const [modalDefaultDescription, setModalDefaultDescription] = useState<string | undefined>(undefined)
  const [calendarDropActive, setCalendarDropActive] = useState(false)
  const [newEventMenuPos, setNewEventMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [newEventCardPos, setNewEventCardPos] = useState<{ top: number; left: number } | null>(null)
  const [newEventCardDay, setNewEventCardDay] = useState<Date>(new Date())
  const [newEventCardHour, setNewEventCardHour] = useState(9)
  const [newEventCardType, setNewEventCardType] = useState<string>('event')
  const [newEventCardDesc, setNewEventCardDesc] = useState<string | undefined>(undefined)
  const mainViewRef = useRef<HTMLDivElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const becameVisibleRef = useRef(false)

  // --- Schedule-X: direct DOM management (StrictMode-safe) ---
  // We bypass ScheduleXCalendar because its cleanup calls calendarApp.destroy(),
  // which in React StrictMode's double-fire pattern (setup→cleanup→setup) leaves
  // the second render operating on a destroyed instance → blank calendar.
  // Instead, we create + render + destroy in a single useEffect so each cycle
  // gets a fresh calendar instance.
  const sxContainerRef = useRef<HTMLDivElement>(null)
  const calendarAppRef = useRef<any>(null)
  const controlsPluginRef = useRef<any>(null)
  const [sxError, setSxError] = useState<string | null>(null)
  const [sxReady, setSxReady] = useState(false)
  const [customPortals, setCustomPortals] = useState<Array<{ el: React.ReactElement; wrapper: HTMLElement }>>([])

  // Keep events ref up to date for callbacks
  const eventsRef = useRef(events)
  eventsRef.current = events

  // --- Persist state across mode switches ---
  const stateRef = useRef({ events, sources, currentDate, selectedDate, viewType, isMock, dataLoaded })
  stateRef.current = { events, sources, currentDate, selectedDate, viewType, isMock, dataLoaded }

  useEffect(() => {
    return () => {
      cachedState = stateRef.current
    }
  }, [])

  useEffect(() => {
    if (isActive) {
      setHasActivated(true)
    }
  }, [isActive])

  // --- Event modal handlers (defined before SX effect so they can be referenced) ---

  const handleOpenEditModal = useCallback((event: CalendarEvent) => {
    setEditingEvent(event)
    setModalMode('edit')
    setModalDefaultDescription(undefined)
    setNewEventMenuPos(null)
    setNewEventCardPos(null)
    setModalOpen(true)
  }, [])

  const handleUpdateEvent = useCallback(async (id: string, updates: Partial<CalendarEvent>) => {
    const previousEvents = eventsRef.current
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e))
    try {
      const result = await window.electronAPI?.calendar?.updateEvent(id, updates)
      if (result && result.success === false) {
        setEvents(previousEvents)
        console.error('Failed to update event:', result.error)
      }
    } catch (error) {
      setEvents(previousEvents)
      console.error('Failed to update event:', error)
    }
  }, [])

  // --- Single SX lifecycle effect: create → render → (cleanup: destroy) ---
  useEffect(() => {
    if (!hasActivated) return
    const container = sxContainerRef.current
    if (!container) return

    try {
      const controlsPlugin = createCalendarControlsPlugin()
      const app = createCalendar({
        views: [createViewWeek(), createViewDay(), createViewMonthGrid()],
        defaultView: SX_VIEW_NAMES[cachedState?.viewType ?? 'week'],
        events: [],
        calendars: sourcesToCalendars(cachedState?.sources?.length ? cachedState.sources : DEFAULT_SOURCES),
        locale: 'zh-CN',
        isResponsive: false,
        selectedDate: toPlainDateLike(cachedState?.currentDate ?? new Date()),
        dayBoundaries: { start: '06:00', end: '21:00' },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        callbacks: {
          onEventClick: (sxEvent: Record<string, unknown>) => {
            const parsed = sxEventToEvent(sxEvent)
            const original = eventsRef.current.find(e => e.id === String(sxEvent.id))
            if (original) {
              handleOpenEditModal(original)
            } else {
              handleOpenEditModal({
                id: String(sxEvent.id),
                title: parsed.title || '',
                startTime: parsed.startTime || new Date(),
                endTime: parsed.endTime || new Date(),
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
            setCurrentDate(date)
            const hour = date.getHours()
            setNewEventCardDay(date)
            setNewEventCardHour(hour)
            setNewEventCardType('event')
            setNewEventCardDesc(undefined)
            setNewEventMenuPos(null)
            setModalOpen(false)
            // Position the card near center of the calendar view
            const rootRect = mainViewRef.current?.getBoundingClientRect()
            setNewEventCardPos({
              top: rootRect ? Math.max(8, Math.min(rootRect.height - 480, 80)) : 80,
              left: rootRect ? Math.max(8, (rootRect.width - 320) / 2) : 200,
            })
          },
          onDoubleClickDate: (date: unknown) => {
            const d = temporalToDate(date)
            setCurrentDate(d)
            setNewEventCardDay(d)
            setNewEventCardHour(9)
            setNewEventCardType('event')
            setNewEventCardDesc(undefined)
            setNewEventMenuPos(null)
            setModalOpen(false)
            const rootRect = mainViewRef.current?.getBoundingClientRect()
            setNewEventCardPos({
              top: rootRect ? Math.max(8, Math.min(rootRect.height - 480, 80)) : 80,
              left: rootRect ? Math.max(8, (rootRect.width - 320) / 2) : 200,
            })
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

      // Register custom components — SX calls these to create wrapper elements,
      // and we inject React components via portals
      const registerCC = (name: string, Comp: React.ComponentType<any>) => {
        ;(app as any)._setCustomComponentFn(name, (wrapperElement: HTMLElement, props: any) => {
          setCustomPortals(prev => {
            const ccid = (wrapperElement as any)?.dataset?.ccid
            if (!ccid) return prev
            return [
              ...prev.filter(p => (p.wrapper as any)?.dataset?.ccid !== ccid),
              { el: createElement(Comp, props), wrapper: wrapperElement },
            ]
          })
        })
      }
      registerCC('timeGridEvent', SXTimeGridEvent)
      registerCC('monthGridEvent', SXMonthGridEvent)

      app.render(container)
      calendarAppRef.current = app
      controlsPluginRef.current = controlsPlugin

      // Sync theme on init
      const theme = document.documentElement.getAttribute('data-theme')
      try { app.setTheme(theme === 'dark' ? 'dark' : 'light') } catch { /* ignore */ }

      console.log('[CalendarMode] SX calendar mounted successfully')
      setSxReady(true)

      return () => {
        app.destroy()
        calendarAppRef.current = null
        controlsPluginRef.current = null
        setSxReady(false)
        setCustomPortals([])
      }
    } catch (err) {
      console.error('[CalendarMode] createCalendar FAILED:', err)
      setSxError(err instanceof Error ? err.message : String(err))
      return undefined
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActivated])

  // --- Load data only once ---
  const loadCalendarData = useCallback(async (force = false) => {
    if (!hasActivated) return
    if (dataLoaded && !force) return

    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const { start, end } = getDateRange(new Date(), 'month')

        const result = await window.electronAPI.calendar.getEvents(start, end)
        if (result.success && result.data) {
          setEvents(result.data.map((e: any) => ({
            id: String(e.id ?? `event-${Math.random().toString(36).slice(2, 8)}`),
            title: e.title || '',
            startTime: new Date(e.startTime ?? e.start_time),
            endTime: new Date(e.endTime ?? e.end_time),
            calendarId: String(e.calendarId ?? e.calendar_id ?? ''),
            color: e.color || '#5B8DEF',
            description: e.description || undefined,
            allDay: e.allDay ?? Boolean(e.all_day),
            contentType: e.contentType ?? undefined,
            platform: e.platform ?? undefined,
            publishStatus: e.publishStatus ?? undefined,
          })))
          setIsMock(result.mock === true)
        }

        const sourcesResult = await window.electronAPI.calendar.getSources()
        if (sourcesResult.success && sourcesResult.data) {
          setSources(sourcesResult.data)
          if (sourcesResult.mock === true) setIsMock(true)
        }
      } else {
        setIsMock(true)
        setSources(DEFAULT_SOURCES)
        setEvents(createDefaultEvents())
      }
    } catch (error) {
      console.error('Calendar data load error:', error)
      setIsMock(true)
      setSources(DEFAULT_SOURCES)
      setEvents(createDefaultEvents())
    }

    setDataLoaded(true)
  }, [dataLoaded, hasActivated])

  useEffect(() => {
    if (!isActive) {
      becameVisibleRef.current = false
      return
    }

    if (!hasActivated || becameVisibleRef.current) return
    becameVisibleRef.current = true
    void loadCalendarData(dataLoaded)
  }, [dataLoaded, hasActivated, isActive, loadCalendarData])

  useCalendarAgentAdapter({
    enabled: hasActivated,
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
  })

  // --- Sync events to Schedule-X ---
  const enabledSourceIds = useMemo(
    () => new Set(sources.filter(s => s.enabled).map(s => s.id)),
    [sources]
  )

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
  }, [sxReady, events, enabledSourceIds, isActive])

  // --- Sync calendars (sources) to Schedule-X ---
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
  }, [sxReady, sources, isActive])

  // --- Sync view type to Schedule-X ---
  useEffect(() => {
    const plugin = controlsPluginRef.current
    if (!plugin || !isActive) return
    const sxViewName = SX_VIEW_NAMES[viewType]
    try {
      plugin.setView(sxViewName)
    } catch (err) {
      console.warn('SX setView error:', err)
    }
  }, [sxReady, viewType, isActive])

  // --- Sync date navigation to Schedule-X ---
  useEffect(() => {
    const plugin = controlsPluginRef.current
    if (!plugin || !isActive) return
    try {
      // calendar-controls expects Temporal.PlainDate (not a YYYY-MM-DD string).
      plugin.setDate(toPlainDateLike(currentDate) as any)
    } catch (err) {
      console.warn('SX setDate error:', err)
    }
  }, [sxReady, currentDate, isActive])

  // --- Watch for theme changes via MutationObserver ---
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
  }, [sxReady, isActive])

  // --- Source management ---

  const toggleSource = useCallback((id: string) => {
    setSources(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s))
  }, [])

  const addSource = useCallback((source: CalendarSource) => {
    setSources(prev => [...prev, source])
  }, [])

  const updateSource = useCallback((id: string, updates: Partial<CalendarSource>) => {
    setSources(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s))
    if (updates.color) {
      const newColor = updates.color
      setEvents(prev => prev.map(e => e.calendarId === id ? { ...e, color: newColor } : e))
    }
  }, [])

  const deleteSource = useCallback((id: string) => {
    setSources(prev => prev.filter(s => s.id !== id))
    setEvents(prev => prev.filter(e => e.calendarId !== id))
  }, [])

  // --- Date selection ---

  const handleSelectDate = useCallback((date: Date) => {
    setSelectedDate(date)
    setCurrentDate(date)
  }, [])

  // --- Event modal handlers (continued) ---

  const createCalendarEvent = useCallback(async (eventData: Omit<CalendarEvent, 'id'>) => {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setEvents(prev => [...prev, { id: localId, ...eventData }])

    try {
      const result = await window.electronAPI?.calendar?.createEvent(eventData)
      if (result?.success && result.data?.id) {
        setEvents(prev => prev.map(e => e.id === localId ? { ...e, id: result.data!.id } : e))
      }
    } catch {
      // Already added locally
    }
  }, [])

  const handleModalSave = useCallback(async (data: EventModalData) => {
    setModalOpen(false)
    if (modalMode === 'create') {
      const eventData: Omit<CalendarEvent, 'id'> = {
        title: data.title,
        startTime: data.startTime,
        endTime: data.endTime,
        calendarId: data.calendarId,
        color: data.color,
        description: data.description,
        allDay: data.allDay,
        ...(data.contentType && { contentType: data.contentType }),
        ...(data.platform && { platform: data.platform }),
        ...(data.publishStatus && { publishStatus: data.publishStatus }),
      }
      await createCalendarEvent(eventData)
    } else if (editingEvent) {
      const updates: Partial<CalendarEvent> = {
        title: data.title,
        startTime: data.startTime,
        endTime: data.endTime,
        calendarId: data.calendarId,
        color: data.color,
        description: data.description,
        allDay: data.allDay,
        contentType: data.contentType,
        platform: data.platform,
        publishStatus: data.publishStatus,
      }
      setEvents(prev => prev.map(e => e.id === editingEvent.id ? { ...e, ...updates } : e))
      try {
        await window.electronAPI?.calendar?.updateEvent(editingEvent.id, updates)
      } catch (error) {
        console.error('Failed to update event:', error)
      }
    }
    setEditingEvent(null)
    setModalDefaultHour(undefined)
    setModalDefaultDescription(undefined)
  }, [createCalendarEvent, modalMode, editingEvent])

  // Delete event
  const handleDeleteEvent = useCallback(async (id: string) => {
    const previousEvents = eventsRef.current
    setEvents(prev => prev.filter(e => e.id !== id))
    setModalOpen(false)
    setEditingEvent(null)
    setModalDefaultDescription(undefined)
    try {
      const result = await window.electronAPI?.calendar?.deleteEvent(id)
      if (result && result.success === false) {
        setEvents(previousEvents)
        console.error('Failed to delete event:', result.error)
      }
    } catch (error) {
      setEvents(previousEvents)
      console.error('Failed to delete event:', error)
    }
  }, [])

  // Sources info for views
  const sourcesForView = useMemo(() =>
    sources.map(s => ({ id: s.id, name: s.name, color: s.color })),
    [sources]
  )

  // Events data for MiniCalendar dot indicators
  const eventsForMiniCalendar = useMemo(() =>
    events
      .filter(e => enabledSourceIds.has(e.calendarId))
      .map(e => ({ startTime: e.startTime, color: e.color })),
    [events, enabledSourceIds]
  )

  // --- CalendarContext value ---
  const calendarContextValue: CalendarContextValue = useMemo(() => ({
    onEditEvent: handleOpenEditModal,
    onUpdateEvent: handleUpdateEvent,
    onDeleteEvent: handleDeleteEvent,
    sources: sourcesForView,
  }), [handleOpenEditModal, handleUpdateEvent, handleDeleteEvent, sourcesForView])

  // --- Navigation helpers ---
  const navigateDate = useCallback((direction: number) => {
    if (viewType === 'week') {
      setCurrentDate(prev => addDays(prev, direction * 7))
    } else if (viewType === 'day') {
      setCurrentDate(prev => direction > 0 ? addDays(prev, 1) : subDays(prev, 1))
    } else {
      setCurrentDate(prev => direction > 0 ? addMonths(prev, 1) : subMonths(prev, 1))
    }
  }, [viewType])

  const goToToday = useCallback(() => {
    setCurrentDate(new Date())
  }, [])

  const openCreateMenu = useCallback(() => {
    const rootRect = mainViewRef.current?.getBoundingClientRect()
    const triggerRect = createButtonRef.current?.getBoundingClientRect()
    if (!rootRect || !triggerRect) {
      setNewEventMenuPos({ top: 56, left: 20 })
      setNewEventCardPos(null)
      return
    }
    setNewEventCardPos(null)
    setNewEventMenuPos({
      top: Math.max(8, triggerRect.bottom - rootRect.top + 6),
      left: Math.max(8, triggerRect.left - rootRect.left),
    })
  }, [])

  const closeQuickCreate = useCallback(() => {
    setNewEventMenuPos(null)
    setNewEventCardPos(null)
  }, [])

  const handleQuickMenuSelect = useCallback((type: string) => {
    const now = new Date()
    const hour = Math.max(0, Math.min(23, now.getHours()))
    setNewEventCardDay(currentDate)
    setNewEventCardHour(hour)
    setNewEventCardType(type)

    const presetDescription: Record<string, string> = {
      task: '任务类型：待办任务',
      repeat: '事件类型：重复事件（每天/每周/每月）',
      milestone: '事件类型：里程碑',
      reminder: '事件类型：提醒',
      memo: '事件类型：备忘',
      import: '导入来源：.ics 文件',
      subscribe: '订阅来源：外部日历 URL',
    }
    setNewEventCardDesc(presetDescription[type] || undefined)

    setNewEventCardPos({
      top: newEventMenuPos ? newEventMenuPos.top : 56,
      left: newEventMenuPos ? newEventMenuPos.left + 226 : 304,
    })
    setNewEventMenuPos(null)
  }, [currentDate, newEventMenuPos])

  const handleQuickCardSubmit = useCallback(async (data: {
    title: string
    startTime: Date
    endTime: Date
    calendarId: string
    color: string
    description?: string
    location?: string
  }) => {
    const combinedDescription = data.location
      ? `${data.description ? `${data.description}\n\n` : ''}地点: ${data.location}`
      : data.description
    await createCalendarEvent({
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      calendarId: data.calendarId,
      color: data.color,
      description: combinedDescription,
    })
    setNewEventCardPos(null)
  }, [createCalendarEvent])

  const handleCalendarDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!calendarDropActive) setCalendarDropActive(true)
  }, [calendarDropActive])

  const handleCalendarDragLeave = useCallback(() => {
    if (calendarDropActive) setCalendarDropActive(false)
  }, [calendarDropActive])

  const handleCalendarDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length === 0) return

    e.preventDefault()
    setCalendarDropActive(false)

    const lines = droppedFiles.map((file) => `- [${file.name}](${toFileUrl(file.path)})`)
    setModalDefaultDescription(`附件:\n${lines.join('\n')}`)
    setEditingEvent(null)
    setNewEventMenuPos(null)
    setNewEventCardPos(null)
    setModalMode('create')
    setModalDefaultHour(undefined)
    setModalOpen(true)
  }, [])

  // Format the header title based on view type
  const headerTitle = useMemo(() => {
    if (viewType === 'day') {
      return format(currentDate, 'yyyy年 M月d日 EEEE', { locale: zhCN })
    }
    if (viewType === 'month') {
      return format(currentDate, 'yyyy年 M月', { locale: zhCN })
    }
    return format(currentDate, 'MMMM yyyy', { locale: zhCN })
  }, [currentDate, viewType])

  return (
    <CalendarProvider value={calendarContextValue}>
      <div className="workbench-mode-root calendar-mode-shell">
        {/* Mock Mode Badge */}
        {isMock && (
          <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-orange-light)] border-b border-[var(--color-orange)] flex-shrink-0">
            <Info className="w-4 h-4 text-[var(--color-orange)]" />
            <span className="text-[12px] text-[var(--color-orange)]">
              当前处于演示模式，数据为模拟数据
            </span>
          </div>
        )}

        <div className="flex-1 min-h-0 px-3 pb-3 pt-2">
          <div
            className="workbench-canvas-shell flex h-full min-h-0 overflow-hidden"
            style={{
              gap: 0,
              background: 'rgba(241, 244, 249, 0.94)',
              backdropFilter: 'blur(20px) saturate(138%)',
              WebkitBackdropFilter: 'blur(20px) saturate(138%)',
            }}
          >
            {/* Calendar Sidebar */}
            <div
              className="panel-hover-scrollbar flex-shrink-0 overflow-auto flex flex-col"
              style={{
                width: WORKBENCH_SUPPORT_PANEL_WIDTH,
                minWidth: WORKBENCH_SUPPORT_PANEL_WIDTH,
                background: 'transparent',
                padding: '0 14px 12px',
              }}
            >
              <MiniCalendar
                currentDate={currentDate}
                selectedDate={selectedDate}
                events={eventsForMiniCalendar}
                onDateChange={setCurrentDate}
                onSelectDate={handleSelectDate}
              />

              {/* Divider */}
              <div style={{ height: 8 }} />

              <CalendarSources
                sources={sources}
                onToggleSource={toggleSource}
                onAddSource={addSource}
                onUpdateSource={updateSource}
                onDeleteSource={deleteSource}
              />
            </div>

            {/* Main View */}
            <div
              className="flex flex-1 min-h-0 min-w-0 overflow-hidden"
              style={{
                background: 'transparent',
                boxShadow: 'none',
              }}
            >
              <div
                ref={mainViewRef}
                className="flex-1 flex flex-col"
                style={{
                  background: 'transparent',
                  position: 'relative',
                }}
              >
            {/* CalNavBar - our own nav bar above SX calendar */}
            <div
              className="flex items-center justify-between flex-shrink-0"
              style={{
                height: WORKBENCH_TOOLBAR_ROW_HEIGHT,
                padding: `0 ${WORKBENCH_HEADER_EDGE_X}px`,
                background: 'transparent',
                boxSizing: 'border-box',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  ref={createButtonRef}
                  onClick={openCreateMenu}
                  className="glass-surface-card"
                  style={{
                    height: 28,
                    borderRadius: 8,
                    border: '1px solid var(--border-default)',
                    background: 'color-mix(in srgb, var(--surface-card-bg) 28%, transparent)',
                    color: 'var(--text-title)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '0 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  <Plus style={{ width: 13, height: 13, color: 'var(--color-red)' }} />
                  新建
                </button>
                <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-title)' }}>
                  {headerTitle}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ViewSelector viewType={viewType} onViewTypeChange={setViewType} />
                <button
                  onClick={goToToday}
                  style={{
                    padding: '4px 12px', borderRadius: 10,
                    border: '1px solid var(--border-input)', background: 'transparent',
                    fontSize: 11, fontWeight: 500, color: 'var(--text-body)',
                    cursor: 'pointer',
                  }}
                >
                  今天
                </button>
                <ChevronLeft
                  onClick={() => navigateDate(-1)}
                  style={{ width: 16, height: 16, color: 'var(--text-muted)', cursor: 'pointer' }}
                />
                <ChevronRight
                  onClick={() => navigateDate(1)}
                  style={{ width: 16, height: 16, color: 'var(--text-muted)', cursor: 'pointer' }}
                />
              </div>
            </div>

            {/* Schedule-X Calendar — rendered directly into this div */}
            <div
              className="flex-1 overflow-hidden relative"
              onDragOver={handleCalendarDragOver}
              onDragLeave={handleCalendarDragLeave}
              onDrop={handleCalendarDrop}
              style={{
                background: calendarDropActive
                  ? 'var(--color-blue-light)'
                  : 'transparent',
                transition: 'background 0.15s ease',
              }}
            >
              {sxError ? (
                <div className="flex items-center justify-center h-full">
                  <div style={{ textAlign: 'center', color: 'var(--color-red)', fontSize: 13 }}>
                    <p style={{ fontWeight: 600, marginBottom: 8 }}>日历初始化失败</p>
                    <pre style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxWidth: 400 }}>{sxError}</pre>
                  </div>
                </div>
              ) : (
                <>
                  <div
                    ref={sxContainerRef}
                    className="sx-react-calendar-wrapper"
                    style={{ width: '100%', height: '100%' }}
                  />
                  {customPortals.map((p, i) => createPortal(p.el, p.wrapper))}
                  {calendarDropActive && (
                    <div
                      className="absolute inset-0 flex items-center justify-center pointer-events-none"
                      style={{ zIndex: 30 }}
                    >
                      <div
                        className="glass-surface-floating"
                        style={{
                          padding: '8px 14px',
                          borderRadius: 12,
                          border: '1px dashed var(--color-blue)',
                          background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
                          color: 'var(--color-blue)',
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        松开后创建带附件备注的新日程
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {newEventMenuPos && (
              <NewEventMenu
                position={newEventMenuPos}
                onSelect={handleQuickMenuSelect}
                onClose={closeQuickCreate}
              />
            )}

            {newEventCardPos && (
              <NewEventCard
                day={newEventCardDay}
                hour={newEventCardHour}
                position={newEventCardPos}
                sources={sourcesForView}
                eventType={newEventCardType}
                defaultDescription={newEventCardDesc}
                onSubmit={handleQuickCardSubmit}
                onClose={() => setNewEventCardPos(null)}
              />
            )}
              </div>
            </div>
          </div>
        </div>

        {/* Event Modal */}
        {modalOpen && (
          <EventModal
            mode={modalMode}
            event={editingEvent}
            defaultDate={currentDate}
            defaultHour={modalDefaultHour}
            defaultDescription={modalDefaultDescription}
            sources={sourcesForView}
            onSave={handleModalSave}
            onDelete={handleDeleteEvent}
            onClose={() => {
              setModalOpen(false)
              setEditingEvent(null)
              setModalDefaultHour(undefined)
              setModalDefaultDescription(undefined)
              setNewEventMenuPos(null)
              setNewEventCardPos(null)
            }}
          />
        )}
      </div>
    </CalendarProvider>
  )
}

// Helper
function getDateRange(date: Date, view: ViewType) {
  if (view === 'month') {
    const ms = startOfMonth(date)
    const me = endOfMonth(date)
    return { start: startOfWeek(ms, { weekStartsOn: 0 }), end: endOfWeek(me, { weekStartsOn: 0 }) }
  }
  if (view === 'day') {
    return { start: date, end: date }
  }
  const ws = startOfWeek(date, { weekStartsOn: 0 })
  return { start: ws, end: addDays(ws, 6) }
}
