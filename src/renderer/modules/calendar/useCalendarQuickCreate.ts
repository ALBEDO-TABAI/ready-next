import { useCallback, useMemo, useState, type RefObject } from 'react'

import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'
import type { CalendarEvent } from '../../components/calendar/schedule-x-utils'
import type { Reminder } from '../../../shared/calendar-types'

/**
 * L2-B — default reminder seeded when the user picks "新建提醒" from the
 * NewEventMenu. 15 minutes before, notification method is the most
 * common preset; matches the default in `ReminderEditor.DEFAULT_REMINDER`
 * but kept inline here so this module doesn't need to import the editor
 * just for one constant.
 */
const DEFAULT_REMINDER_FOR_REMINDER_TYPE: Reminder = {
  offsetMinutes: -15,
  method: 'notification',
}

/**
 * L3-B-RRULE-UI — default RRULE seeded when the user picks "新建重复
 * 事件" from the NewEventMenu. "Weekly, 10 occurrences" is the most
 * common cadence (matches the inline default RecurrenceEditor opens
 * with on its CUSTOM seed). The full EventModal opens with this
 * pre-filled and the user can edit it via the RecurrenceEditor before
 * saving.
 */
const DEFAULT_RECURRENCE_RULE_FOR_REPEAT_TYPE = 'FREQ=WEEKLY;COUNT=10'

function getQuickCardCenterPosition(rect: DOMRect | null | undefined) {
  if (!rect) {
    return { top: 80, left: 200 }
  }
  return {
    top: Math.max(8, Math.min(rect.height - 480, 80)),
    left: Math.max(8, (rect.width - 320) / 2),
  }
}

export interface QuickCreateCardPayload {
  date: Date
  hour?: number
  type?: string
  description?: string
}

export interface UseCalendarQuickCreateParams {
  currentDate: Date
  mainViewRef: RefObject<HTMLDivElement | null>
  createButtonRef: RefObject<HTMLButtonElement | null>
  createCalendarEvent: (payload: Omit<CalendarEvent, 'id'>) => Promise<void>
  setEditingEvent: (event: CalendarEvent | null) => void
  setModalMode: (mode: 'create' | 'edit') => void
  setModalOpen: (open: boolean) => void
  setModalDefaultHour: (value: number | undefined) => void
  setModalDefaultDescription: (value: string | undefined) => void
  /**
   * L2-B — seeded reminder list when opening the full EventModal in
   * response to "新建提醒" (or any future menu pick that wants to
   * pre-populate reminders). The host calls this to push state into
   * CalendarMode before openModal flips, then ReminderEditor mounts
   * with the prefilled list.
   */
  setModalDefaultReminders?: (value: Reminder[] | null | undefined) => void
  /**
   * L3-B — seeded RRULE for the "新建重复事件" entry. Same pattern as
   * `setModalDefaultReminders` — host stores the string in state,
   * EventModal seeds RecurrenceEditor from it on open.
   */
  setModalDefaultRecurrenceRule?: (value: string | null | undefined) => void
  /**
   * L4-B — when wired, the menu's `import` action triggers a hidden
   * file picker (host owns it) and the `subscribe` action opens the
   * URL-subscription modal. Both close the dropdown immediately; the
   * actual upload / subscribe flow lives on the host so the hook stays
   * free of `window.electronAPI` calls.
   */
  onPickIcsFile?: () => void
  onOpenSubscribeForm?: () => void
}

export function useCalendarQuickCreate({
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
  onPickIcsFile,
  onOpenSubscribeForm,
}: UseCalendarQuickCreateParams) {
  const [calendarDropActive, setCalendarDropActive] = useState(false)
  const [newEventMenuPos, setNewEventMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [newEventCardPos, setNewEventCardPos] = useState<{ top: number; left: number } | null>(null)
  const [newEventCardDay, setNewEventCardDay] = useState<Date>(new Date())
  const [newEventCardHour, setNewEventCardHour] = useState(9)
  const [newEventCardType, setNewEventCardType] = useState<string>('event')
  const [newEventCardDesc, setNewEventCardDesc] = useState<string | undefined>(undefined)

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
  }, [createButtonRef, mainViewRef])

  const closeQuickCreate = useCallback(() => {
    setNewEventMenuPos(null)
    setNewEventCardPos(null)
  }, [])

  const closeQuickCard = useCallback(() => {
    setNewEventCardPos(null)
  }, [])

  const openQuickCard = useCallback((payload: QuickCreateCardPayload) => {
    const { date, hour = 9, type, description } = payload
    const safeHour = Math.max(0, Math.min(23, hour))
    setNewEventCardDay(date)
    setNewEventCardHour(safeHour)
    setNewEventCardType(type ?? 'event')
    setNewEventCardDesc(description)
    setNewEventMenuPos(null)
    setNewEventCardPos(getQuickCardCenterPosition(mainViewRef.current?.getBoundingClientRect()))
  }, [mainViewRef])

  const handleQuickMenuSelect = useCallback((type: string) => {
    const now = new Date()
    const hour = Math.max(0, Math.min(23, now.getHours()))

    // L4-B — "导入日程 (.ics)" / "订阅日历" route out of the quick-create
    // flow entirely. Both close the dropdown and delegate to the host.
    // We don't pop a NewEventCard because import / subscribe don't have
    // per-day / per-hour semantics — they live at the source level.
    if (type === 'import') {
      setNewEventMenuPos(null)
      setNewEventCardPos(null)
      onPickIcsFile?.()
      return
    }
    if (type === 'subscribe') {
      setNewEventMenuPos(null)
      setNewEventCardPos(null)
      onOpenSubscribeForm?.()
      return
    }

    // L2-B — "新建提醒" goes through the full EventModal (the inline
    // NewEventCard quick form deliberately stays minimal, no reminder
    // editor inside). We seed `defaultReminders` so the modal opens
    // with one preset row already populated; user can edit / add /
    // remove from there. Other menu types continue to use the inline
    // quick card flow per L1-C.
    if (type === 'reminder') {
      setEditingEvent(null)
      setModalMode('create')
      setModalDefaultHour(hour)
      setModalDefaultDescription(undefined)
      setModalDefaultReminders?.([DEFAULT_REMINDER_FOR_REMINDER_TYPE])
      setModalDefaultRecurrenceRule?.(undefined)
      setNewEventMenuPos(null)
      setNewEventCardPos(null)
      setModalOpen(true)
      return
    }

    // L3-B-RRULE-UI — "新建重复事件" opens the full EventModal too,
    // because the RecurrenceEditor is non-trivial to fit in the inline
    // quick card. Seeds a weekly/10x default the user can edit. Same
    // pattern as the reminder branch above.
    if (type === 'repeat') {
      setEditingEvent(null)
      setModalMode('create')
      setModalDefaultHour(hour)
      setModalDefaultDescription(undefined)
      setModalDefaultReminders?.(undefined)
      setModalDefaultRecurrenceRule?.(DEFAULT_RECURRENCE_RULE_FOR_REPEAT_TYPE)
      setNewEventMenuPos(null)
      setNewEventCardPos(null)
      setModalOpen(true)
      return
    }

    setNewEventCardDay(currentDate)
    setNewEventCardHour(hour)
    setNewEventCardType(type)
    // L1-A: 类型预设描述已退役（"事件类型: xxx" 是占位 hack，会污染 description 字段）。
    // L1-C 负责处理菜单侧的类型选择真正的语义化（任务/里程碑/提醒等）。
    setNewEventCardDesc(undefined)
    setNewEventCardPos({
      top: newEventMenuPos ? newEventMenuPos.top : 56,
      left: newEventMenuPos ? newEventMenuPos.left + 226 : 304,
    })
    setNewEventMenuPos(null)
  }, [
    currentDate,
    newEventMenuPos,
    setEditingEvent,
    setModalMode,
    setModalDefaultHour,
    setModalDefaultDescription,
    setModalDefaultReminders,
    setModalDefaultRecurrenceRule,
    setModalOpen,
    onPickIcsFile,
    onOpenSubscribeForm,
  ])

  const handleQuickCardSubmit = useCallback(async (data: {
    title: string
    startTime: Date
    endTime: Date
    calendarId: string
    color: string
    description?: string
    location?: string
  }) => {
    // L1-A: location 作为独立结构化字段送至 IPC / DB（已支持），不再拼到 description。
    // 渲染端旧实现的字符串拼接造成 agent 工具 / 地图集成查不到地点。
    const trimmedLocation = data.location?.trim()
    await createCalendarEvent({
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      calendarId: data.calendarId,
      color: data.color,
      description: data.description,
      location: trimmedLocation || undefined,
    })
    setNewEventCardPos(null)
  }, [createCalendarEvent])

  const handleCalendarDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(event.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!calendarDropActive) setCalendarDropActive(true)
  }, [calendarDropActive])

  const handleCalendarDragLeave = useCallback(() => {
    setCalendarDropActive(false)
  }, [])

  const handleCalendarDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(event.dataTransfer)
    if (droppedFiles.length === 0) return

    event.preventDefault()
    setCalendarDropActive(false)
    setNewEventMenuPos(null)
    setNewEventCardPos(null)

    const lines = droppedFiles.map((file) => `- [${file.name}](${toFileUrl(file.path)})`)
    setModalDefaultDescription(`附件:\n${lines.join('\n')}`)
    setEditingEvent(null)
    setModalMode('create')
    setModalDefaultHour(undefined)
    setModalOpen(true)
  }, [setEditingEvent, setModalDefaultDescription, setModalMode, setModalDefaultHour, setModalOpen])

  return {
    calendarDropActive,
    newEventMenuPos,
    newEventCardPos,
    newEventCardDay,
    newEventCardHour,
    newEventCardType,
    newEventCardDesc,
    openCreateMenu,
    closeQuickCreate,
    closeQuickCard,
    openQuickCard,
    handleQuickMenuSelect,
    handleQuickCardSubmit,
    handleCalendarDragOver,
    handleCalendarDragLeave,
    handleCalendarDrop,
  }
}
