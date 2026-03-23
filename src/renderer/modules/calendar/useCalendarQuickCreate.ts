import { useCallback, useMemo, useState, type RefObject } from 'react'

import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'
import type { CalendarEvent } from '../../components/calendar/schedule-x-utils'

const PRESET_DESCRIPTIONS: Record<string, string> = {
  task: '任务类型：待办任务',
  repeat: '事件类型：重复事件（每天/每周/每月）',
  milestone: '事件类型：里程碑',
  reminder: '事件类型：提醒',
  memo: '事件类型：备忘',
  import: '导入来源：.ics 文件',
  subscribe: '订阅来源：外部日历 URL',
}

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
    setNewEventCardDay(currentDate)
    setNewEventCardHour(hour)
    setNewEventCardType(type)
    setNewEventCardDesc(PRESET_DESCRIPTIONS[type] || undefined)
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
