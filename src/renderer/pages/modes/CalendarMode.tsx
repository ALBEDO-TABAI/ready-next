import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { format, addDays, addMonths, subMonths, subDays, startOfWeek, startOfMonth, endOfMonth, endOfWeek, startOfDay, endOfDay } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import CalendarWorkbenchShell from '../../components/calendar/CalendarWorkbenchShell'
import { CalendarProvider } from '../../components/calendar/CalendarContext'
import type { CalendarContextValue } from '../../components/calendar/CalendarContext'
import type { CalendarAssistantEvent, CalendarAssistantSummary } from '../../components/calendar/CalendarAssistantPanel'
import EventModal from '../../components/calendar/EventModal'
import type { EventModalData } from '../../components/calendar/EventModal'
import type { CalendarSource } from '../../components/calendar/CalendarSources'
import type { CalendarEvent, ViewType } from '../../components/calendar/schedule-x-utils'
import { resolveEventColors } from '../../components/calendar/schedule-x-utils'
import type { Reminder, ReminderFirePayload } from '../../../shared/calendar-types'
import type { RemoteCalendarEventSuggestion } from '../../../shared/calendar-remote-channel'
import { serializeEventToWire, parseEventFromWire } from '../../../shared/calendar-wire'
import { useCalendarAgentAdapter } from '../../modules/calendar/useCalendarAgentAdapter'
import { DEFAULT_SOURCES, persistCalendarModeCache, readCalendarModeCache } from '../../modules/calendar/calendarCache'
import { buildRemoteSuggestionEventDraft } from '../../modules/calendar/remoteSuggestion'
import { useCalendarQuickCreate } from '../../modules/calendar/useCalendarQuickCreate'
import { useScheduleXCalendar } from '../../modules/calendar/useScheduleXCalendar'
import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
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
  const setSessionIsMock = useCalendarSession((state) => state.setIsMock)
  // L4-A — display timezone is a renderer-only preference; the store
  // owns it (default = user's local IANA zone resolved at store init).
  const displayTimezone = useCalendarSession((state) => state.displayTimezone)
  const setDisplayTimezone = useCalendarSession((state) => state.setDisplayTimezone)

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
  const [assistantOpen, setAssistantOpen] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create')
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null)
  const [modalDefaultHour, setModalDefaultHour] = useState<number | undefined>(undefined)
  const [modalDefaultDescription, setModalDefaultDescription] = useState<string | undefined>(undefined)
  // L2-B — seeded reminders when opening EventModal from the "新建提醒"
  // menu pick. `undefined` = no seed (regular create / edit); explicit
  // `null` would clear, an array pre-populates the editor.
  const [modalDefaultReminders, setModalDefaultReminders] = useState<Reminder[] | null | undefined>(undefined)
  // L3-B-RRULE-UI — seeded RRULE when opening from "新建重复事件" menu
  // pick. `undefined` means no seed; the modal then reads `event.recurrenceRule`
  // (edit) or treats it as non-recurring (create). Passing a string
  // pre-populates RecurrenceEditor on open.
  const [modalDefaultRecurrenceRule, setModalDefaultRecurrenceRule] =
    useState<string | null | undefined>(undefined)
  // L2-B — in-app reminder capsule. One row shown at a time; later fires
  // overwrite the previous capsule (mirrors how OS notification stacks
  // are deduped per-event). Cleared on click ("跳转到事件") or after the
  // 8s auto-dismiss.
  const [reminderCapsule, setReminderCapsule] = useState<ReminderFirePayload | null>(null)
  const [remoteSuggestion, setRemoteSuggestion] = useState<RemoteCalendarEventSuggestion | null>(null)
  const [remoteSuggestionBusy, setRemoteSuggestionBusy] = useState(false)
  const [remoteSuggestionError, setRemoteSuggestionError] = useState<string | null>(null)

  const mainViewRef = useRef<HTMLDivElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const becameVisibleRef = useRef(false)
  const lastFetchedWindowRef = useRef<string | null>(null)
  const remoteSuggestionSeenRef = useRef<Set<string>>(new Set())

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

  // L4-B — host-level state for the NewEventMenu's "subscribe" / "import"
  // paths. Declared above `useCalendarQuickCreate` so the arrow closures
  // we hand to that hook can safely reference these symbols.
  const menuPickIcsFileInputRef = useRef<HTMLInputElement | null>(null)
  const [menuSubscribeOpen, setMenuSubscribeOpen] = useState(false)
  const [menuSubUrl, setMenuSubUrl] = useState('')
  const [menuSubName, setMenuSubName] = useState('')
  const [menuSubError, setMenuSubError] = useState<string | null>(null)

  // L4-B — quickCreate accepts two new callbacks so the "import .ics" /
  // "subscribe URL" menu items route to the host instead of falling
  // through to NewEventCard. The arrow closures resolve the refs /
  // setters at click time, which is after every hook has initialized.
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
    setModalDefaultReminders,
    setModalDefaultRecurrenceRule,
    onPickIcsFile: () => menuPickIcsFileInputRef.current?.click(),
    onOpenSubscribeForm: () => {
      setMenuSubUrl('')
      setMenuSubName('')
      setMenuSubError(null)
      setMenuSubscribeOpen(true)
    },
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

  // `color` is a denormalized projection of an event's category
  // (calendarId → source.color); the wire carries no color and the events
  // table has no color column, so a freshly-loaded or agent-recategorized
  // event keeps its last-stamped color (blue fallback on load) until the
  // user re-saves it through the modal. Derive the display color from the
  // current source list here so a category change recolors immediately.
  const coloredEvents = useMemo(() => resolveEventColors(events, sources), [events, sources])

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
    events: coloredEvents,
    eventsRef,
    enabledSourceIds,
    displayTimezone,
    handleOpenEditModal,
    handleUpdateEvent,
    onQuickCardRequest: openQuickCardFromSX,
  })

  // Single path that pulls events for a window into renderer state. The grid
  // hook only re-renders the `events` it is handed, so every visible-window
  // change (initial load, month navigation, post-mutation refresh) flows
  // through here. Sources/mock load separately in loadCalendarData so a
  // navigation refetch never re-runs setSources and clobbers the user's local
  // source toggles. Returns the response mock flag, or undefined when the
  // fetch failed (loadError is already set in that case).
  const fetchEventsForWindow = useCallback(async (start: Date, end: Date): Promise<boolean | undefined> => {
    if (typeof window === 'undefined' || !window.electronAPI) return undefined
    const result = await window.electronAPI.calendar.getEvents(start, end)
    if (!result.success) {
      setLoadError(result.error || '日历事件加载失败。')
      return undefined
    }
    if (result.data) {
      // Boundary-layer normalization: every event from the IPC channel
      // is a `CalendarEventWire`. Convert through `parseEventFromWire`
      // to get JS `Date` objects + null-normalized fields. This is the
      // single place the renderer constructs `Date` from event time —
      // prior to this fix the `new Date(unixSeconds)` shape produced
      // 1970-era events on every refresh.
      setEvents(result.data.map((rawEvent: any) => {
        const parsed = parseEventFromWire(serializeEventToWire(rawEvent))
        return {
          id: parsed.id || `event-${Math.random().toString(36).slice(2, 8)}`,
          title: parsed.title,
          startTime: parsed.startTime,
          endTime: parsed.endTime,
          calendarId: parsed.calendarId,
          color: typeof rawEvent.color === 'string' ? rawEvent.color : '#5B8DEF',
          description: parsed.description ?? undefined,
          location: parsed.location ?? undefined,
          allDay: parsed.allDay,
          contentType: rawEvent.contentType ?? undefined,
          platform: rawEvent.platform ?? undefined,
          publishStatus: rawEvent.publishStatus ?? undefined,
          reminders: parsed.reminders ?? undefined,
          recurrenceRule: parsed.recurrenceRule ?? undefined,
          instanceOf: parsed.instanceOf,
          occurrenceStart: Math.floor(parsed.occurrenceStart.getTime() / 1000),
          overrideKind: parsed.overrideKind ?? undefined,
        }
      }))
    }
    lastFetchedWindowRef.current = `${start.getTime()}-${end.getTime()}`
    return Boolean(result.mock)
  }, [])

  const loadCalendarData = useCallback(async (force = false) => {
    if (!hasActivated) return
    if (dataLoaded && !force) return

    try {
      setLoadError(null)

      if (typeof window === 'undefined' || !window.electronAPI) {
        setIsMock(false)
        setSessionIsMock(false)
        setLoadError('日历模块当前仅支持 Electron 运行环境。')
        setDataLoaded(true)
        return
      }

      // Fetch the window around the currently-viewed date (not today): the
      // month grid for any view is covered by currentDate's month range, so
      // reopening on a persisted date or refreshing after a mutation loads
      // the right window instead of always snapping back to today's month.
      const { start, end } = getDateRange(currentDate, 'month')
      const eventsMock = await fetchEventsForWindow(start, end)
      if (eventsMock === undefined) {
        setIsMock(false)
        setSessionIsMock(false)
        setDataLoaded(true)
        return
      }

      const sourcesResult = await window.electronAPI.calendar.getSources()
      if (!sourcesResult.success) {
        setIsMock(false)
        setSessionIsMock(false)
        setLoadError(sourcesResult.error || '日历来源加载失败。')
        setDataLoaded(true)
        return
      }
      if (sourcesResult.data) {
        setSources(sourcesResult.data)
      }

      // L1-B-Mock-Surface: the IPC layer tags responses with `mock: true`
      // when `ENABLE_MOCK_SERVICES=true` at main start. Either response
      // being mock means the entire calendar view is mock. Push the flag
      // into both local state (for cache snapshot) and the session store
      // (so the workbench shell badge can subscribe without prop drilling).
      const mockActive = Boolean(eventsMock) || Boolean(sourcesResult.mock)
      setIsMock(mockActive)
      setSessionIsMock(mockActive)
    } catch (error) {
      console.error('Calendar data load error:', error)
      setIsMock(false)
      setSessionIsMock(false)
      setLoadError(error instanceof Error ? error.message : '日历模块加载失败。')
    }

    setDataLoaded(true)
  }, [currentDate, dataLoaded, fetchEventsForWindow, hasActivated, setSessionIsMock])

  useEffect(() => {
    if (!isActive) {
      becameVisibleRef.current = false
      return
    }

    if (!hasActivated || becameVisibleRef.current) return
    becameVisibleRef.current = true
    void loadCalendarData(dataLoaded)
  }, [dataLoaded, hasActivated, isActive, loadCalendarData])

  // Refetch events when the user navigates to a different month. The grid only
  // renders the `events` it is handed, so without this every month except the
  // initially-loaded one shows empty even though the events exist in the DB.
  // Keyed on the month window (via lastFetchedWindowRef) so day/week stepping
  // inside a month doesn't refetch, and the run triggered right after the
  // initial load is a no-op because loadCalendarData already primed the ref.
  useEffect(() => {
    if (!hasActivated || !isActive || !dataLoaded) return
    const { start, end } = getDateRange(currentDate, 'month')
    if (lastFetchedWindowRef.current === `${start.getTime()}-${end.getTime()}`) return
    void fetchEventsForWindow(start, end)
  }, [currentDate, dataLoaded, fetchEventsForWindow, hasActivated, isActive])

  // Register the agent handler whenever this (always-mounted) scene exists,
  // not only after the calendar becomes the visible mode. This lets the agent
  // run calendar tools in the background while the user stays in another mode —
  // moduleExecutor no longer force-switches to calendar to make the handler
  // appear. Heavy grid init stays gated on `hasActivated` (see useScheduleXCalendar).
  useCalendarAgentAdapter({
    enabled: true,
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

  // L2-B-Reminder-UI — subscribe once to `calendar:reminderFired` IPC
  // push from main. On fire we surface an in-app capsule that auto-
  // dismisses after 8 seconds; click navigates to the event (load the
  // visible range, then select the event id so the schedule-x runtime
  // scrolls / highlights it).
  //
  // Subscription is mount-only (not gated on `isActive`) because a
  // reminder may fire while the user is in another mode — receiving the
  // capsule means they'll see it next time they switch to calendar mode,
  // which is the same behaviour as a missed OS notification badge. The
  // 8s timer still ticks while the user is elsewhere; that's intentional
  // (the capsule isn't a queue, it's a "latest fired" surface).
  useEffect(() => {
    const api = window.electronAPI?.calendar
    if (!api?.onReminderFired) return
    const dismissTimers: ReturnType<typeof setTimeout>[] = []
    const unsubscribe = api.onReminderFired((payload) => {
      setReminderCapsule(payload)
      const handle = setTimeout(() => {
        setReminderCapsule((current) => (current?.eventId === payload.eventId ? null : current))
      }, 8000)
      dismissTimers.push(handle)
    })
    return () => {
      unsubscribe()
      for (const handle of dismissTimers) clearTimeout(handle)
    }
  }, [])

  useEffect(() => {
    const api = window.electronAPI?.calendar
    if (!api?.onRemoteEventSuggested) return
    const unsubscribe = api.onRemoteEventSuggested((suggestion) => {
      if (!suggestion?.suggestionId) return
      const seen = remoteSuggestionSeenRef.current
      if (seen.has(suggestion.suggestionId)) return
      seen.add(suggestion.suggestionId)
      setRemoteSuggestion(suggestion)
      setRemoteSuggestionError(null)
    })
    return unsubscribe
  }, [])

  // Convert capsule click → navigate to event. Same path the OS
  // notification click handler uses on main side (it pushes
  // `agent:toolAction` `app.switchMode` with `eventId`); from inside
  // CalendarMode we shortcut by directly seeding the session store +
  // setting the current date to the event start.
  const handleReminderCapsuleClick = useCallback(() => {
    if (!reminderCapsule) return
    const eventDate = new Date(reminderCapsule.eventStartTime * 1000)
    if (!Number.isNaN(eventDate.getTime())) {
      setCurrentDate(eventDate)
    }
    setSelectedSessionEvent({ id: reminderCapsule.eventId, title: reminderCapsule.eventTitle })
    setReminderCapsule(null)
  }, [reminderCapsule, setSelectedSessionEvent])

  const handleReminderCapsuleDismiss = useCallback(() => {
    setReminderCapsule(null)
  }, [])

  const handleRemoteSuggestionDismiss = useCallback(() => {
    setRemoteSuggestion(null)
    setRemoteSuggestionError(null)
  }, [])

  const handleRemoteSuggestionCreate = useCallback(async () => {
    if (!remoteSuggestion || remoteSuggestionBusy) return
    const api = window.electronAPI?.calendar
    if (!api?.createEvent) return
    const targetSource = sources.find((source) => source.enabled !== false) ?? sources[0]
    if (!targetSource) {
      setRemoteSuggestionError('还没有可用日历')
      return
    }

    let draft: ReturnType<typeof buildRemoteSuggestionEventDraft>
    try {
      draft = buildRemoteSuggestionEventDraft(remoteSuggestion, targetSource.id)
    } catch (error) {
      setRemoteSuggestionError(error instanceof Error ? error.message : '远程日程建议无效')
      return
    }

    setRemoteSuggestionBusy(true)
    setRemoteSuggestionError(null)
    try {
      const result = await api.createEvent({
        calendarId: draft.calendarId,
        title: draft.title,
        description: draft.description,
        startTime: draft.startTime.toISOString(),
        endTime: draft.endTime.toISOString(),
        allDay: draft.allDay,
      })
      if (!result?.success) {
        setRemoteSuggestionError(result?.error ?? '创建失败')
        return
      }
      setCurrentDate(draft.startTime)
      if (result.data?.id) {
        setSelectedSessionEvent({ id: result.data.id, title: draft.title })
      }
      setRemoteSuggestion(null)
      await loadCalendarData(true)
    } catch (error) {
      setRemoteSuggestionError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoteSuggestionBusy(false)
    }
  }, [
    loadCalendarData,
    remoteSuggestion,
    remoteSuggestionBusy,
    setSelectedSessionEvent,
    sources,
  ])

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

  const deleteSource = useCallback(async (id: string) => {
    // L4-B — when the deleted source has a syncUrl it's an external
    // subscription; we must also drop the row server-side so the
    // periodic sync stops. Local sources are pure UI state today (the
    // backend default sources are seeded at boot and never deleted via
    // this path), so we don't issue an unsubscribe IPC for them.
    const source = sources.find((s) => s.id === id)
    setSources((prev) => prev.filter((source) => source.id !== id))
    setEvents((prev) => prev.filter((event) => event.calendarId !== id))
    if (source && typeof source.syncUrl === 'string' && source.syncUrl.length > 0) {
      try {
        await window.electronAPI?.calendar?.unsubscribeSource(id)
      } catch (error) {
        console.warn('[calendar] unsubscribeSource failed:', error)
      }
    }
  }, [sources])

  // L4-B-External-Sync — handlers for the import / subscribe / sync-now
  // entry points exposed by `CalendarSources` and `NewEventMenu`.

  const handleImportIcs = useCallback(async (file: File) => {
    let rawIcs: string
    try {
      rawIcs = await file.text()
    } catch (error) {
      console.warn('[calendar] reading .ics file failed:', error)
      setLoadError('.ics 文件读取失败')
      return
    }
    try {
      const result = await window.electronAPI?.calendar?.importIcsString({
        rawIcs,
        sourceName: file.name.replace(/\.ics$/i, ''),
      })
      if (!result?.success) {
        setLoadError(result?.error || '.ics 导入失败')
        return
      }
      // Force a reload so the new source row + events appear in the UI.
      await loadCalendarData(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[calendar] importIcsString failed:', message)
      setLoadError(message)
    }
    // Intentionally do NOT add `loadCalendarData` to deps — it's
    // declared further down in the file and changes on each render
    // anyway; the loose dep is OK because we always call the latest
    // version through the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSubscribeUrl = useCallback(async (payload: {
    url: string
    name: string
    color: string
    syncIntervalMinutes: number
  }) => {
    try {
      const result = await window.electronAPI?.calendar?.subscribeUrl({
        url: payload.url,
        name: payload.name,
        color: payload.color,
        syncIntervalMinutes: payload.syncIntervalMinutes,
      })
      if (!result?.success) {
        setLoadError(result?.error || '订阅日历失败')
        return
      }
      await loadCalendarData(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[calendar] subscribeUrl failed:', message)
      setLoadError(message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSyncSourceNow = useCallback(async (id: string) => {
    try {
      const result = await window.electronAPI?.calendar?.syncSourceNow(id)
      if (!result?.success) {
        setLoadError(result?.error || '同步失败')
        return
      }
      // Even on success the SyncResult itself can carry ok:false (e.g.
      // upstream URL was unreachable). Surface that as a soft error
      // banner so the user knows the sync ran but didn't pull anything.
      const inner = result.data
      if (inner && !inner.ok) {
        setLoadError(inner.error || '同步未完成')
      }
      await loadCalendarData(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[calendar] syncSourceNow failed:', message)
      setLoadError(message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMenuIcsFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    await handleImportIcs(file)
  }, [handleImportIcs])

  const submitMenuSubscribeForm = useCallback(async () => {
    const trimmedUrl = menuSubUrl.trim()
    const trimmedName = menuSubName.trim()
    if (trimmedUrl.length === 0) {
      setMenuSubError('请填写订阅 URL')
      return
    }
    if (!/^https?:\/\//i.test(trimmedUrl) && !/^webcal:\/\//i.test(trimmedUrl)) {
      setMenuSubError('URL 必须以 http:// / https:// / webcal:// 开头')
      return
    }
    if (trimmedName.length === 0) {
      setMenuSubError('请填写日历名称')
      return
    }
    const url = trimmedUrl.replace(/^webcal:\/\//i, 'https://')
    await handleSubscribeUrl({
      url,
      name: trimmedName,
      color: '#5B8DEF',
      syncIntervalMinutes: 60,
    })
    setMenuSubscribeOpen(false)
  }, [menuSubUrl, menuSubName, handleSubscribeUrl])

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
        location: data.location,
        allDay: data.allDay,
        ...(data.contentType && { contentType: data.contentType }),
        ...(data.platform && { platform: data.platform }),
        ...(data.publishStatus && { publishStatus: data.publishStatus }),
        // L2-B — propagate reminders through to IPC. The modal seeds
        // its state with `null` when there are no reminders, and the
        // editor canonicalizes empty lists back to `null`, so this is
        // either `null` or a non-empty array; IPC handler accepts both.
        ...(data.reminders !== undefined && { reminders: data.reminders }),
        // L3-B — propagate recurrence rule through to IPC. On create
        // we forward whatever the editor produced (string for a
        // recurring event, null for non-recurring). The repository
        // normalizes empty / null at the DB layer.
        ...(data.recurrenceRule !== undefined && { recurrenceRule: data.recurrenceRule }),
      }
      await createCalendarEvent(eventData)
    } else if (editingEvent) {
      // L3-B — instance vs series routing. EventModal sets
      // `recurrenceScope` to one of three values:
      //   'single' → upsert per-occurrence override (kind='single' + patch)
      //   'future' → splitRecurringSeries (truncate parent, create new
      //              series with the patched fields starting at the
      //              occurrence start)
      //   'series' → standard updateEvent on the parent row
      //
      // We detect instance-id format (id contains '#' or instanceOf
      // differs) to pick the parent id. For non-instance edits the
      // path is the same as today.
      const scope = data.recurrenceScope ?? 'series'
      const isInstance =
        editingEvent.id.includes('#') ||
        (typeof editingEvent.instanceOf === 'string' && editingEvent.instanceOf !== editingEvent.id) ||
        typeof editingEvent.occurrenceStart === 'number'
      const parentId =
        typeof editingEvent.instanceOf === 'string' && editingEvent.instanceOf !== editingEvent.id
          ? editingEvent.instanceOf
          : editingEvent.id.includes('#')
            ? editingEvent.id.split('#')[0]
            : editingEvent.id
      const occurrenceStart =
        typeof editingEvent.occurrenceStart === 'number'
          ? editingEvent.occurrenceStart
          : Math.floor((editingEvent.startTime?.getTime() ?? Date.now()) / 1000)

      // Optimistic UI: apply the locally-visible patch to the in-store
      // row so the user sees the result immediately. We invalidate
      // afterward by re-loading from main for instance routes (override
      // / split can affect multiple rows), and for series routes we
      // keep the existing diff-in-place behavior to avoid a re-read.
      const optimisticUpdates: Partial<CalendarEvent> = {
        title: data.title,
        startTime: data.startTime,
        endTime: data.endTime,
        calendarId: data.calendarId,
        color: data.color,
        description: data.description,
        location: data.location,
        allDay: data.allDay,
        contentType: data.contentType,
        platform: data.platform,
        publishStatus: data.publishStatus,
        ...(data.reminders !== undefined && { reminders: data.reminders }),
      }
      setEvents((prev) => prev.map((event) => event.id === editingEvent.id ? { ...event, ...optimisticUpdates } : event))

      try {
        if (isInstance && scope === 'single') {
          // Patch only the differing fields against the parent's
          // "what an unmodified occurrence would look like". We can't
          // compare to the parent precisely from renderer state so we
          // simply propagate all editable fields — the override layer
          // only stores what's set in the patch, so passing every
          // field is fine (the read side merges with the parent).
          await window.electronAPI?.calendar?.upsertEventOverride({
            parentEventId: parentId,
            occurrenceStart,
            kind: 'single',
            patch: {
              title: data.title,
              description: data.description ?? null,
              location: data.location ?? null,
              startTime: data.startTime.getTime(),
              endTime: data.endTime.getTime(),
              allDay: data.allDay,
              reminders: data.reminders ?? null,
            },
          })
          // Re-read events so the override-merged instance row replaces
          // the optimistic patch we put in store.
          await loadCalendarData(true)
        } else if (isInstance && scope === 'future') {
          await window.electronAPI?.calendar?.splitRecurringSeries({
            parentEventId: parentId,
            occurrenceStart,
            patch: {
              title: data.title,
              description: data.description ?? null,
              location: data.location ?? null,
              startTime: data.startTime.getTime(),
              endTime: data.endTime.getTime(),
              allDay: data.allDay,
              reminders: data.reminders ?? null,
              recurrenceRule: data.recurrenceRule,
              calendarId: data.calendarId,
            },
          })
          await loadCalendarData(true)
        } else {
          // 'series' OR non-instance edit — both go through updateEvent
          // on the parent row id.
          const updates: Partial<CalendarEvent> = {
            ...optimisticUpdates,
            // L3-B — propagate recurrence-rule edit only for series
            // scope; for instance edits the rule is not changed by
            // single-occurrence patches.
            ...(data.recurrenceRule !== undefined && { recurrenceRule: data.recurrenceRule }),
          }
          await window.electronAPI?.calendar?.updateEvent(parentId, updates)
        }
      } catch (error) {
        console.error('Failed to save calendar event:', error)
      }
    }
    setEditingEvent(null)
    setModalDefaultHour(undefined)
    setModalDefaultDescription(undefined)
    setModalDefaultReminders(undefined)
    setModalDefaultRecurrenceRule(undefined)
  }, [createCalendarEvent, modalMode, editingEvent, loadCalendarData])

  const handleDeleteEvent = useCallback(async (id: string) => {
    const previousEvents = eventsRef.current
    // L3-B — the modal stashes the user's chosen scope on the window
    // before calling onDelete (see EventModal.commitRecurrenceScope).
    // We read it once and clear immediately so a subsequent delete of
    // a non-instance event doesn't pick up a stale value.
    const w = window as unknown as { __readyCalendarPendingDeleteScope?: 'single' | 'future' | 'series' }
    const requestedScope = w.__readyCalendarPendingDeleteScope
    if (requestedScope) {
      try { delete w.__readyCalendarPendingDeleteScope } catch { /* noop */ }
    }

    // Decide whether we're deleting an instance and resolve the parent id.
    const target = eventsRef.current.find((e) => e.id === id)
    const isInstance =
      !!target &&
      (target.id.includes('#') ||
        (typeof target.instanceOf === 'string' && target.instanceOf !== target.id) ||
        typeof target.occurrenceStart === 'number')
    const parentId =
      target && typeof target.instanceOf === 'string' && target.instanceOf !== target.id
        ? target.instanceOf
        : target && target.id.includes('#')
          ? target.id.split('#')[0]
          : id
    const occurrenceStart =
      target && typeof target.occurrenceStart === 'number'
        ? target.occurrenceStart
        : target
          ? Math.floor(target.startTime.getTime() / 1000)
          : 0

    setEvents((prev) => prev.filter((event) => event.id !== id))
    setModalOpen(false)
    setEditingEvent(null)
    setModalDefaultDescription(undefined)

    try {
      // Instance + 'single' scope = cancelled override.
      if (isInstance && requestedScope === 'single') {
        const result = await window.electronAPI?.calendar?.upsertEventOverride({
          parentEventId: parentId,
          occurrenceStart,
          kind: 'cancelled',
        })
        if (result && result.success === false) {
          setEvents(previousEvents)
          console.error('Failed to skip event occurrence:', result.error)
          return
        }
        // Re-read so other instances of this series re-display correctly.
        await loadCalendarData(true)
        return
      }
      // Instance + 'future' = split with empty patch + null new RRULE
      // (the new series has no rule and so is a single one-shot event
      // — but practically we want to truncate the parent only). The
      // simplest semantic here is "truncate the parent at this
      // occurrence and don't create a new series at all"; that's not
      // a single existing IPC, so we approximate by splitting with an
      // empty patch and immediately deleting the new event. Cheaper
      // path: just update the parent's RRULE to end at occurrenceStart - 1.
      if (isInstance && requestedScope === 'future') {
        // Resolve the parent's RRULE so we can truncate it in place.
        const parent = eventsRef.current.find((e) => e.id === parentId)
        if (!parent || !parent.recurrenceRule) {
          // Fallback: parent's rule unknown — defer to series delete.
          await window.electronAPI?.calendar?.deleteEvent(parentId)
        } else {
          // Build a truncated rule by reusing the engine's UNTIL
          // shape — for safety we delegate to splitRecurringSeries
          // with `recurrenceRule: null` for the new series. The new
          // row is empty (single event at occurrenceStart) — we drop
          // it immediately because the user asked to delete this
          // and everything after it.
          const splitResult = await window.electronAPI?.calendar?.splitRecurringSeries({
            parentEventId: parentId,
            occurrenceStart,
            patch: { recurrenceRule: null },
          })
          if (splitResult?.success && splitResult.data?.newEventId) {
            await window.electronAPI?.calendar?.deleteEvent(splitResult.data.newEventId)
          }
        }
        await loadCalendarData(true)
        return
      }
      // Non-instance OR 'series' scope = delete the whole parent row.
      // FK cascade drops all override rows tied to this parent.
      const result = await window.electronAPI?.calendar?.deleteEvent(parentId)
      if (result && result.success === false) {
        setEvents(previousEvents)
        console.error('Failed to delete event:', result.error)
        return
      }
      // After series delete reload to drop any expanded instance rows
      // for the parent that were still in store.
      await loadCalendarData(true)
    } catch (error) {
      setEvents(previousEvents)
      console.error('Failed to delete event:', error)
    }
  }, [loadCalendarData])

  const sourcesForView = useMemo(
    () => sources.map((source) => ({ id: source.id, name: source.name, color: source.color })),
    [sources],
  )

  const eventsForMiniCalendar = useMemo(
    () => coloredEvents
      .filter((event) => enabledSourceIds.has(event.calendarId))
      .map((event) => ({ startTime: event.startTime, color: event.color })),
    [coloredEvents, enabledSourceIds],
  )

  const eventsForMonthGrid = useMemo(
    () => coloredEvents.filter((event) => enabledSourceIds.has(event.calendarId)),
    [coloredEvents, enabledSourceIds],
  )

  const headerTitle = useMemo(() => {
    if (viewType === 'day') {
      return format(currentDate, 'yyyy年 M月d日 EEEE', { locale: zhCN })
    }
    if (viewType === 'month') {
      return format(currentDate, 'yyyy年 M月', { locale: zhCN })
    }
    return format(currentDate, 'MMMM yyyy', { locale: zhCN })
  }, [currentDate, viewType])

  const calendarAssistantSummary = useMemo<CalendarAssistantSummary>(() => {
    const sourceNameById = new Map(sources.map((source) => [source.id, source.name]))
    const toAssistantEvent = (event: CalendarEvent): CalendarAssistantEvent => ({
      id: event.id,
      title: event.title,
      startTime: event.startTime,
      endTime: event.endTime,
      calendarName: sourceNameById.get(event.calendarId) || '日历',
      color: event.color,
      allDay: event.allDay,
    })
    const activeEvents = coloredEvents
      .filter((event) => enabledSourceIds.has(event.calendarId))
      .slice()
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

    const todayStart = startOfDay(new Date())
    const todayEnd = endOfDay(new Date())
    const todayEvents = activeEvents
      .filter((event) => overlapsRange(event.startTime, event.endTime, todayStart, todayEnd))
      .map(toAssistantEvent)

    const now = Date.now()
    const nextEvent = activeEvents.find((event) => event.endTime.getTime() >= now)

    const weekRange = getDateRange(currentDate, 'week')
    const weekStartMs = startOfDay(weekRange.start).getTime()
    const weekEndMs = endOfDay(weekRange.end).getTime()
    const weekEventsRaw = activeEvents.filter((event) => (
      event.endTime.getTime() >= weekStartMs && event.startTime.getTime() <= weekEndMs
    ))
    const weekTotalMinutes = weekEventsRaw.reduce((total, event) => {
      if (event.allDay) return total
      const startMs = Math.max(event.startTime.getTime(), weekStartMs)
      const endMs = Math.min(event.endTime.getTime(), weekEndMs)
      return total + Math.max(0, Math.round((endMs - startMs) / 60000))
    }, 0)
    const weekCalendarCount = new Set(weekEventsRaw.map((event) => event.calendarId)).size

    return {
      todayEvents,
      weekEvents: weekEventsRaw.map(toAssistantEvent),
      nextEvent: nextEvent ? toAssistantEvent(nextEvent) : null,
      weekEventCount: weekEventsRaw.length,
      weekTotalHours: Math.round((weekTotalMinutes / 60) * 10) / 10,
      weekCalendarCount,
    }
  }, [coloredEvents, currentDate, enabledSourceIds, sources])

  const handleCalendarAssistantAskAgent = useCallback((instruction: string) => {
    const trimmed = instruction.trim()
    if (!trimmed) return
    const weekLines = calendarAssistantSummary.weekEvents.slice(0, 8).map((event) => {
      const startLabel = format(event.startTime, 'M月d日 HH:mm', { locale: zhCN })
      const endLabel = format(event.endTime, 'HH:mm', { locale: zhCN })
      return `- ${startLabel}-${endLabel} ${event.title || '无标题日程'}（${event.calendarName}）`
    })
    const prompt = [
      '### 日程管家',
      `请求：${trimmed}`,
      `当前视图：${headerTitle}`,
      `本周：${calendarAssistantSummary.weekEventCount} 件事，约 ${calendarAssistantSummary.weekTotalHours} 小时，来自 ${calendarAssistantSummary.weekCalendarCount} 个日历。`,
      weekLines.length > 0 ? '本周日程：' : '本周暂时没有日程。',
      ...weekLines,
    ].join('\n')
    appendToAgentInput(prompt)
  }, [calendarAssistantSummary, headerTitle])

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

  return (
    <CalendarProvider value={calendarContextValue}>
      <>
        <CalendarWorkbenchShell
          isMock={isMock}
          loadError={loadError}
          currentDate={currentDate}
          selectedDate={selectedDate}
          eventsForMiniCalendar={eventsForMiniCalendar}
          eventsForMonthGrid={eventsForMonthGrid}
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
          displayTimezone={displayTimezone}
          assistantOpen={assistantOpen}
          assistantSummary={calendarAssistantSummary}
          onDisplayTimezoneChange={setDisplayTimezone}
          onToggleAssistant={() => setAssistantOpen((open) => !open)}
          onCloseAssistant={() => setAssistantOpen(false)}
          onAssistantAskAgent={handleCalendarAssistantAskAgent}
          onDateChange={setCurrentDate}
          onSelectDate={handleSelectDate}
          onOpenMonthEvent={handleOpenEditModal}
          onCreateMonthEvent={openQuickCardFromSX}
          onToggleSource={toggleSource}
          onAddSource={addSource}
          onUpdateSource={updateSource}
          onDeleteSource={deleteSource}
          onImportIcs={handleImportIcs}
          onSubscribeUrl={handleSubscribeUrl}
          onSyncSourceNow={handleSyncSourceNow}
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
            defaultReminders={modalDefaultReminders}
            defaultRecurrenceRule={modalDefaultRecurrenceRule}
            sources={sourcesForView}
            onSave={handleModalSave}
            onDelete={handleDeleteEvent}
            onClose={() => {
              setModalOpen(false)
              setEditingEvent(null)
              setModalDefaultHour(undefined)
              setModalDefaultDescription(undefined)
              setModalDefaultReminders(undefined)
              setModalDefaultRecurrenceRule(undefined)
              quickCreate.closeQuickCreate()
              quickCreate.closeQuickCard()
            }}
          />
        )}

        {/* L4-B — hidden file picker driven by the NewEventMenu's
            "导入日程 (.ics)" item. The CalendarSources sidebar has its
            own picker; this one services the dropdown-menu path only.
            Both eventually call `handleImportIcs(file)`. */}
        <input
          ref={menuPickIcsFileInputRef}
          type="file"
          accept=".ics,text/calendar"
          onChange={handleMenuIcsFileChange}
          style={{ display: 'none' }}
        />

        {/* L4-B — top-level subscribe modal opened from the NewEventMenu's
            "订阅日历" item. Mirrors the inline modal inside the sidebar
            CalendarSources component; they're separate UIs because the
            two entry points are visually unrelated, but they share the
            same `handleSubscribeUrl` IPC path. */}
        {menuSubscribeOpen && (
          <div
            data-ready-native-overlay=""
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.36)',
              zIndex: 90,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => setMenuSubscribeOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 320,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-default)',
                borderRadius: 8,
                padding: 16,
                display: 'flex', flexDirection: 'column', gap: 10,
                boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
                订阅外部日历
              </span>
              <input
                value={menuSubUrl}
                onChange={(e) => { setMenuSubUrl(e.target.value); setMenuSubError(null) }}
                onKeyDown={(e) => { if (e.key === 'Escape') setMenuSubscribeOpen(false) }}
                placeholder="https:// 或 webcal:// 开头的 ICS URL"
                autoFocus
                style={{
                  padding: '6px 10px', borderRadius: 6,
                  border: '1px solid var(--input-slot-border)',
                  background: 'var(--input-slot-bg)',
                  fontSize: 12, color: 'var(--text-body)', outline: 'none',
                }}
              />
              <input
                value={menuSubName}
                onChange={(e) => { setMenuSubName(e.target.value); setMenuSubError(null) }}
                placeholder="日历名称（用于侧栏显示）"
                style={{
                  padding: '6px 10px', borderRadius: 6,
                  border: '1px solid var(--input-slot-border)',
                  background: 'var(--input-slot-bg)',
                  fontSize: 12, color: 'var(--text-body)', outline: 'none',
                }}
              />
              {menuSubError && (
                <span style={{ fontSize: 11, color: '#EB5757' }}>{menuSubError}</span>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  onClick={() => setMenuSubscribeOpen(false)}
                  style={{
                    padding: '5px 14px', borderRadius: 6,
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-primary)',
                    fontSize: 12, color: 'var(--text-body)', cursor: 'pointer',
                  }}
                >
                  取消
                </button>
                <button
                  onClick={submitMenuSubscribeForm}
                  disabled={!menuSubUrl.trim() || !menuSubName.trim()}
                  style={{
                    padding: '5px 14px', borderRadius: 6,
                    border: 'none', background: 'var(--text-title)',
                    fontSize: 12, fontWeight: 600, color: 'var(--bg-primary)',
                    cursor: menuSubUrl.trim() && menuSubName.trim() ? 'pointer' : 'not-allowed',
                    opacity: menuSubUrl.trim() && menuSubName.trim() ? 1 : 0.5,
                  }}
                >
                  订阅
                </button>
              </div>
            </div>
          </div>
        )}

        {remoteSuggestion && (
          <div
            data-ready-native-overlay=""
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed',
              top: reminderCapsule ? 112 : 24,
              right: 24,
              zIndex: 100,
              maxWidth: 380,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 8,
              background: 'var(--surface-floating-bg)',
              border: '1px solid var(--surface-border)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
              backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
              WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
              color: 'var(--text-body)',
              fontSize: 12,
              animation: 'reminderCapsuleSlide 220ms ease-out',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-title)', marginBottom: 4 }}>
                远程消息里有一个日程
              </div>
              <div style={{ color: 'var(--text-body)', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {remoteSuggestion.suggestedTitle || remoteSuggestion.extractedText}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: remoteSuggestionError ? 6 : 10 }}>
                {new Date(remoteSuggestion.suggestedStartUnix * 1000).toLocaleString('zh-CN', {
                  timeZone: displayTimezone,
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: remoteSuggestion.hasTime ? '2-digit' : undefined,
                  minute: remoteSuggestion.hasTime ? '2-digit' : undefined,
                })}
                {remoteSuggestion.source.sender ? ` · ${remoteSuggestion.source.sender}` : ''}
              </div>
              {remoteSuggestionError && (
                <div style={{ fontSize: 11, color: '#EB5757', marginBottom: 8 }}>
                  {remoteSuggestionError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={handleRemoteSuggestionCreate}
                  disabled={remoteSuggestionBusy}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'var(--text-title)',
                    color: 'var(--bg-primary)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: remoteSuggestionBusy ? 'not-allowed' : 'pointer',
                    opacity: remoteSuggestionBusy ? 0.6 : 1,
                  }}
                >
                  {remoteSuggestionBusy ? '创建中...' : '创建日程'}
                </button>
                <button
                  type="button"
                  onClick={handleRemoteSuggestionDismiss}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border-default)',
                    background: 'transparent',
                    color: 'var(--text-body)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  忽略
                </button>
              </div>
            </div>
            <button
              type="button"
              aria-label="关闭远程日程建议"
              onClick={handleRemoteSuggestionDismiss}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                color: 'var(--text-muted)',
                display: 'flex',
                borderRadius: 4,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>×</span>
            </button>
          </div>
        )}

        {/* L2-B — in-app reminder capsule. Fixed top-right; auto-dismiss
            after 8s via the subscription effect timer. Click → navigate
            to the event; X dismisses immediately. The wrapper sits on a
            very high z-index so it overlays Schedule-X portal content
            and modal overlay (modal z-50). */}
        {reminderCapsule && (
          <div
            data-ready-native-overlay=""
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed',
              top: 24,
              right: 24,
              zIndex: 100,
              maxWidth: 360,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--surface-floating-bg)',
              border: '1px solid var(--surface-border)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
              backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
              WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
              color: 'var(--text-body)',
              fontSize: 12,
              cursor: 'pointer',
              animation: 'reminderCapsuleSlide 220ms ease-out',
            }}
            onClick={handleReminderCapsuleClick}
          >
            <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }} aria-hidden="true">📅</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-title)', marginBottom: 2 }}>
                {(() => {
                  // Same time-relative copy as the OS notification body:
                  // pre-start, at-start, or past-start. We compute fresh
                  // because the user may receive the capsule a few seconds
                  // after firedAt and the offset hint should match what
                  // they read on the OS notification side.
                  const nowSec = Math.floor(Date.now() / 1000)
                  const deltaSeconds = nowSec - reminderCapsule.eventStartTime
                  if (Math.abs(deltaSeconds) < 30) return `📌 ${reminderCapsule.eventTitle} 现在开始`
                  if (deltaSeconds > 0) {
                    return `📌 ${reminderCapsule.eventTitle} 已开始 ${Math.round(deltaSeconds / 60)} 分钟`
                  }
                  return `📌 ${reminderCapsule.eventTitle} ${Math.abs(Math.round(deltaSeconds / 60))} 分钟后开始`
                })()}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                点击跳转到该事件
              </div>
            </div>
            <button
              type="button"
              aria-label="关闭提醒"
              onClick={(e) => {
                e.stopPropagation()
                handleReminderCapsuleDismiss()
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                color: 'var(--text-muted)',
                display: 'flex',
                borderRadius: 4,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>×</span>
            </button>
          </div>
        )}
        <style>{`
          @keyframes reminderCapsuleSlide {
            0% { opacity: 0; transform: translateY(-6px); }
            100% { opacity: 1; transform: translateY(0); }
          }
        `}</style>
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

function overlapsRange(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
  return end.getTime() >= rangeStart.getTime() && start.getTime() <= rangeEnd.getTime()
}
