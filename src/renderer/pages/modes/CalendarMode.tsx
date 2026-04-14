import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { format, addDays, addMonths, subMonths, subDays, startOfWeek, startOfMonth, endOfMonth, endOfWeek } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import CalendarWorkbenchShell from '../../components/calendar/CalendarWorkbenchShell'
import { CalendarProvider } from '../../components/calendar/CalendarContext'
import type { CalendarContextValue } from '../../components/calendar/CalendarContext'
import EventModal from '../../components/calendar/EventModal'
import type { EventModalData } from '../../components/calendar/EventModal'
import type { CalendarSource } from '../../components/calendar/CalendarSources'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'
import { useCalendarAgentAdapter } from '../../modules/calendar/useCalendarAgentAdapter'
import { DEFAULT_SOURCES, persistCalendarModeCache, readCalendarModeCache } from '../../modules/calendar/calendarCache'
import { useCalendarQuickCreate } from '../../modules/calendar/useCalendarQuickCreate'
import { useScheduleXCalendar } from '../../modules/calendar/useScheduleXCalendar'
import { useCalendarSession } from '../../stores/useCalendarSession'

import '@schedule-x/theme-default/dist/index.css'
import '../../styles/schedule-x.css'

interface CalendarModeProps {
  isActive?: boolean
  isMotionSettled?: boolean
}

export default function CalendarMode({
  isActive = true,
  isMotionSettled = true,
}: CalendarModeProps) {
  const setVisibleRange = useCalendarSession((state) => state.setVisibleRange)
  const setSelectedSessionEvent = useCalendarSession((state) => state.setSelectedEvent)
  const setConflictState = useCalendarSession((state) => state.setConflictState)
  const markSessionMutation = useCalendarSession((state) => state.markMutation)

  const persistedState = readCalendarModeCache()
  const [currentDate, setCurrentDate] = useState(persistedState?.currentDate ?? new Date())
  const [events, setEvents] = useState<CalendarEvent[]>(persistedState?.events ?? [])
  const [sources, setSources] = useState<CalendarSource[]>(persistedState?.sources?.length ? persistedState.sources : DEFAULT_SOURCES)
  const [selectedDate, setSelectedDate] = useState<Date | null>(persistedState?.selectedDate ?? null)
  const [isMock, setIsMock] = useState(persistedState?.isMock ?? false)
  const [viewType, setViewType] = useState<ViewType>(persistedState?.viewType ?? 'week')
  const [dataLoaded, setDataLoaded] = useState(persistedState?.dataLoaded ?? false)
  const [hasActivated, setHasActivated] = useState(isActive || Boolean(persistedState?.dataLoaded))
  const [loadError, setLoadError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create')
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null)
  const [modalDefaultHour, setModalDefaultHour] = useState<number | undefined>(undefined)
  const [modalDefaultDescription, setModalDefaultDescription] = useState<string | undefined>(undefined)

  const mainViewRef = useRef<HTMLDivElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const becameVisibleRef = useRef(false)

  const eventsRef = useRef(events)
  eventsRef.current = events

  const stateRef = useRef({ events, sources, currentDate, selectedDate, viewType, isMock, dataLoaded })
  stateRef.current = { events, sources, currentDate, selectedDate, viewType, isMock, dataLoaded }

  useEffect(() => {
    return () => {
      persistCalendarModeCache(stateRef.current)
    }
  }, [])

  useEffect(() => {
    if (isActive) {
      setHasActivated(true)
    }
  }, [isActive])

  const createCalendarEvent = useCallback(async (eventData: Omit<CalendarEvent, 'id'>) => {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setEvents((prev) => [...prev, { id: localId, ...eventData }])

    try {
      const result = await window.electronAPI?.calendar?.createEvent(eventData)
      if (result?.success && result.data?.id) {
        setEvents((prev) => prev.map((event) => event.id === localId ? { ...event, id: result.data!.id } : event))
      }
    } catch {
      // Already added locally.
    }
  }, [])

  const quickCreate = useCalendarQuickCreate({
    currentDate,
    mainViewRef,
    createButtonRef,
    createCalendarEvent,
    setEditingEvent,
    setModalMode,
    setModalOpen,
    setModalDefaultHour,
    setModalDefaultDescription,
  })

  const handleOpenEditModal = useCallback((event: CalendarEvent) => {
    setEditingEvent(event)
    setModalMode('edit')
    setModalDefaultDescription(undefined)
    quickCreate.closeQuickCreate()
    quickCreate.closeQuickCard()
    setModalOpen(true)
  }, [quickCreate])

  const handleUpdateEvent = useCallback(async (id: string, updates: Partial<CalendarEvent>) => {
    const previousEvents = eventsRef.current
    setEvents((prev) => prev.map((event) => event.id === id ? { ...event, ...updates } : event))
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

  const openQuickCardFromSX = useCallback((payload: { date: Date; hour?: number }) => {
    const { date, hour = 9 } = payload
    setModalOpen(false)
    setEditingEvent(null)
    setModalDefaultHour(undefined)
    setModalDefaultDescription(undefined)
    setCurrentDate(date)
    quickCreate.openQuickCard({ date, hour, type: 'event', description: undefined })
  }, [quickCreate])

  const enabledSourceIds = useMemo(
    () => new Set(sources.filter((source) => source.enabled).map((source) => source.id)),
    [sources],
  )

  const {
    sxContainerRef,
    customPortalNodes,
    sxError,
  } = useScheduleXCalendar({
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
    onQuickCardRequest: openQuickCardFromSX,
  })

  const loadCalendarData = useCallback(async (force = false) => {
    if (!hasActivated) return
    if (dataLoaded && !force) return

    try {
      setLoadError(null)

      if (typeof window === 'undefined' || !window.electronAPI) {
        setIsMock(false)
        setLoadError('日历模块当前仅支持 Electron 运行环境。')
        setDataLoaded(true)
        return
      }

      const { start, end } = getDateRange(new Date(), 'month')
      const result = await window.electronAPI.calendar.getEvents(start, end)
      if (!result.success) {
        setIsMock(false)
        setLoadError(result.error || '日历事件加载失败。')
        setDataLoaded(true)
        return
      }
      if (result.data) {
        setEvents(result.data.map((event: any) => ({
          id: String(event.id ?? `event-${Math.random().toString(36).slice(2, 8)}`),
          title: event.title || '',
          startTime: new Date(event.startTime ?? event.start_time),
          endTime: new Date(event.endTime ?? event.end_time),
          calendarId: String(event.calendarId ?? event.calendar_id ?? ''),
          color: event.color || '#5B8DEF',
          description: event.description || undefined,
          allDay: event.allDay ?? Boolean(event.all_day),
          contentType: event.contentType ?? undefined,
          platform: event.platform ?? undefined,
          publishStatus: event.publishStatus ?? undefined,
        })))
      }

      const sourcesResult = await window.electronAPI.calendar.getSources()
      if (!sourcesResult.success) {
        setIsMock(false)
        setLoadError(sourcesResult.error || '日历来源加载失败。')
        setDataLoaded(true)
        return
      }
      if (sourcesResult.data) {
        setSources(sourcesResult.data)
      }

      setIsMock(false)
    } catch (error) {
      console.error('Calendar data load error:', error)
      setIsMock(false)
      setLoadError(error instanceof Error ? error.message : '日历模块加载失败。')
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

  const toggleSource = useCallback((id: string) => {
    setSources((prev) => prev.map((source) => source.id === id ? { ...source, enabled: !source.enabled } : source))
  }, [])

  const addSource = useCallback((source: CalendarSource) => {
    setSources((prev) => [...prev, source])
  }, [])

  const updateSource = useCallback((id: string, updates: Partial<CalendarSource>) => {
    setSources((prev) => prev.map((source) => source.id === id ? { ...source, ...updates } : source))
    if (updates.color) {
      const newColor = updates.color
      setEvents((prev) => prev.map((event) => event.calendarId === id ? { ...event, color: newColor } : event))
    }
  }, [])

  const deleteSource = useCallback((id: string) => {
    setSources((prev) => prev.filter((source) => source.id !== id))
    setEvents((prev) => prev.filter((event) => event.calendarId !== id))
  }, [])

  const handleSelectDate = useCallback((date: Date) => {
    setSelectedDate(date)
    setCurrentDate(date)
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
      setEvents((prev) => prev.map((event) => event.id === editingEvent.id ? { ...event, ...updates } : event))
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

  const handleDeleteEvent = useCallback(async (id: string) => {
    const previousEvents = eventsRef.current
    setEvents((prev) => prev.filter((event) => event.id !== id))
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

  const sourcesForView = useMemo(
    () => sources.map((source) => ({ id: source.id, name: source.name, color: source.color })),
    [sources],
  )

  const eventsForMiniCalendar = useMemo(
    () => events
      .filter((event) => enabledSourceIds.has(event.calendarId))
      .map((event) => ({ startTime: event.startTime, color: event.color })),
    [events, enabledSourceIds],
  )

  const calendarContextValue: CalendarContextValue = useMemo(() => ({
    onEditEvent: handleOpenEditModal,
    onUpdateEvent: handleUpdateEvent,
    onDeleteEvent: handleDeleteEvent,
    sources: sourcesForView,
  }), [handleOpenEditModal, handleUpdateEvent, handleDeleteEvent, sourcesForView])

  const navigateDate = useCallback((direction: number) => {
    if (viewType === 'week') {
      setCurrentDate((prev) => addDays(prev, direction * 7))
    } else if (viewType === 'day') {
      setCurrentDate((prev) => direction > 0 ? addDays(prev, 1) : subDays(prev, 1))
    } else {
      setCurrentDate((prev) => direction > 0 ? addMonths(prev, 1) : subMonths(prev, 1))
    }
  }, [viewType])

  const goToToday = useCallback(() => {
    setCurrentDate(new Date())
  }, [])

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
      <>
        <CalendarWorkbenchShell
          isMock={isMock}
          loadError={loadError}
          currentDate={currentDate}
          selectedDate={selectedDate}
          eventsForMiniCalendar={eventsForMiniCalendar}
          sources={sources}
          headerTitle={headerTitle}
          viewType={viewType}
          calendarDropActive={quickCreate.calendarDropActive}
          sxError={sxError}
          sxContainerRef={sxContainerRef}
          mainViewRef={mainViewRef}
          createButtonRef={createButtonRef}
          customPortalNodes={customPortalNodes}
          newEventMenuPos={quickCreate.newEventMenuPos}
          newEventCardPos={quickCreate.newEventCardPos}
          newEventCardDay={quickCreate.newEventCardDay}
          newEventCardHour={quickCreate.newEventCardHour}
          newEventCardType={quickCreate.newEventCardType}
          newEventCardDesc={quickCreate.newEventCardDesc}
          sourcesForView={sourcesForView}
          onDateChange={setCurrentDate}
          onSelectDate={handleSelectDate}
          onToggleSource={toggleSource}
          onAddSource={addSource}
          onUpdateSource={updateSource}
          onDeleteSource={deleteSource}
          onOpenCreateMenu={quickCreate.openCreateMenu}
          onViewTypeChange={setViewType}
          onGoToToday={goToToday}
          onNavigateDate={navigateDate}
          onCalendarDragOver={quickCreate.handleCalendarDragOver}
          onCalendarDragLeave={quickCreate.handleCalendarDragLeave}
          onCalendarDrop={quickCreate.handleCalendarDrop}
          onQuickMenuSelect={quickCreate.handleQuickMenuSelect}
          onCloseQuickCreate={quickCreate.closeQuickCreate}
          onQuickCardSubmit={quickCreate.handleQuickCardSubmit}
          onCloseQuickCard={quickCreate.closeQuickCard}
        />

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
              quickCreate.closeQuickCreate()
              quickCreate.closeQuickCard()
            }}
          />
        )}
      </>
    </CalendarProvider>
  )
}

function getDateRange(date: Date, view: ViewType) {
  if (view === 'month') {
    const monthStart = startOfMonth(date)
    const monthEnd = endOfMonth(date)
    return { start: startOfWeek(monthStart, { weekStartsOn: 0 }), end: endOfWeek(monthEnd, { weekStartsOn: 0 }) }
  }
  if (view === 'day') {
    return { start: date, end: date }
  }
  const weekStart = startOfWeek(date, { weekStartsOn: 0 })
  return { start: weekStart, end: addDays(weekStart, 6) }
}
