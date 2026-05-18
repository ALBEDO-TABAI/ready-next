import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Video, Image as ImageIcon, FileText, BookOpen, Radio, MapPin } from 'lucide-react'
import { Temporal } from '@js-temporal/polyfill'
import { useCalendarContext } from './CalendarContext'
import { sxEventToEvent } from './schedule-x-utils'
import type { CalendarEvent } from './schedule-x-utils'
import { useCalendarSession } from '../../stores/useCalendarSession'
import {
  addReadyContextReferenceToAgentInput,
  showReferenceToInputMenu,
} from '../../modules/agent/chat-input-bridge'

const CONTENT_TYPE_ICONS: Record<string, typeof Video> = {
  video: Video,
  image: ImageIcon,
  article: FileText,
  story: BookOpen,
  live: Radio,
}

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音',
  bilibili: 'B站',
  xiaohongshu: '小红书',
  wechat: '微信',
  weibo: '微博',
}

interface SXTimeGridEventProps {
  calendarEvent: Record<string, unknown>
}

/**
 * Custom time grid event renderer for Schedule-X.
 * Displays event title, time, content type icon, platform badges.
 * Includes bottom-edge resize handle (self-implemented, 15-min snapping).
 */
export default function SXTimeGridEvent({ calendarEvent }: SXTimeGridEventProps) {
  const { onEditEvent, onUpdateEvent } = useCalendarContext()
  // L4-A — read the user's display timezone so the inline HH:mm next to
  // each event renders under the chosen zone, not the host's local zone.
  // schedule-x's own time-grid axis labels still honor its `timezone`
  // config (kept in sync by `useScheduleXCalendar`); this hook is for
  // the custom event renderer we mount inside each time-grid cell.
  const displayTimezone = useCalendarSession((state) => state.displayTimezone)
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<{
    startY: number
    originalEndTime: Date
    eventId: string
    startTime: Date
  } | null>(null)

  // Parse SX event into our domain
  const parsed = sxEventToEvent(calendarEvent)
  const eventColor = (calendarEvent.color as string) || '#5B8DEF'
  const contentType = (calendarEvent.contentType as string) || undefined
  const location = ((calendarEvent.location as string) || '').trim()
  const platformStr = (calendarEvent.platform as string) || ''
  const platforms = useMemo(() => {
    try {
      return platformStr ? JSON.parse(platformStr) as string[] : []
    } catch {
      return []
    }
  }, [platformStr])
  const publishStatus = (calendarEvent.publishStatus as string) || undefined

  const ContentIcon = contentType ? CONTENT_TYPE_ICONS[contentType] : null

  // L4-A — render a Date under `displayTimezone` instead of host-local.
  // Bad IANA strings fall back to host-local so the event card never
  // becomes unrenderable; an invalid zone is the user's input mistake
  // and the toolbar selector should be the only way to set it anyway.
  const formatTime = (date: Date | undefined): string => {
    if (!date) return ''
    try {
      const zdt = Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(displayTimezone)
      return `${String(zdt.hour).padStart(2, '0')}:${String(zdt.minute).padStart(2, '0')}`
    } catch {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }
  }

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (isResizing) return
    // Reconstruct full CalendarEvent for edit
    const event: CalendarEvent = {
      id: String(calendarEvent.id),
      title: (calendarEvent.title as string) || '',
      startTime: parsed.startTime || new Date(),
      endTime: parsed.endTime || new Date(),
      calendarId: (calendarEvent.calendarId as string) || '',
      color: eventColor,
      description: parsed.description,
      location: parsed.location || location || undefined,
      allDay: parsed.allDay,
      contentType: parsed.contentType,
      platform: platforms,
      publishStatus: parsed.publishStatus,
    }
    onEditEvent(event)
  }, [calendarEvent, parsed, eventColor, platforms, isResizing, location, onEditEvent])

  const handleDragStart = useCallback((e: React.DragEvent<HTMLSpanElement>) => {
    e.stopPropagation()
    const payload = JSON.stringify({
      type: 'calendar-event' as const,
      eventId: String(calendarEvent.id),
      name: parsed.title || '(无标题日程)',
      title: parsed.title || '(无标题日程)',
      startTime: parsed.startTime?.toISOString(),
      endTime: parsed.endTime?.toISOString(),
      calendarId: String(calendarEvent.calendarId || ''),
      color: eventColor,
      description: parsed.description || '',
      location: location || '',
      contentType: parsed.contentType,
      platform: platforms,
      publishStatus: parsed.publishStatus,
      draggedAt: Date.now(),
    })
    e.dataTransfer.setData('application/x-ready-drag', payload)
    e.dataTransfer.setData('text/plain', parsed.title || '(无标题日程)')
    e.dataTransfer.effectAllowed = 'copy'
  }, [calendarEvent.calendarId, calendarEvent.id, eventColor, location, parsed.contentType, parsed.description, parsed.endTime, parsed.publishStatus, parsed.startTime, parsed.title, platforms])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    void showReferenceToInputMenu({ x: e.clientX, y: e.clientY }).then((selected) => {
      if (!selected) return
      void addReadyContextReferenceToAgentInput({
        type: 'calendar-event',
        eventId: String(calendarEvent.id),
        name: parsed.title || '(无标题日程)',
        title: parsed.title || '(无标题日程)',
        startTime: parsed.startTime?.toISOString(),
        endTime: parsed.endTime?.toISOString(),
        calendarId: String(calendarEvent.calendarId || ''),
        description: parsed.description || '',
        location: location || '',
        allDay: parsed.allDay,
        contentType: parsed.contentType,
        platform: platforms,
        publishStatus: parsed.publishStatus,
      })
    })
  }, [calendarEvent.calendarId, calendarEvent.id, location, parsed.allDay, parsed.contentType, parsed.description, parsed.endTime, parsed.publishStatus, parsed.startTime, parsed.title, platforms])

  // Resize via bottom edge drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setIsResizing(true)
    resizeRef.current = {
      startY: e.clientY,
      originalEndTime: parsed.endTime || new Date(),
      eventId: String(calendarEvent.id),
      startTime: parsed.startTime || new Date(),
    }
  }, [calendarEvent.id, parsed.endTime, parsed.startTime])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return

      const deltaY = e.clientY - resizeRef.current.startY
      // SX time grid: ~60px per hour (approximate), snap to 15min
      const pixelsPerHour = 60
      const deltaMinutes = Math.round((deltaY / pixelsPerHour) * 60 / 15) * 15
      const newEnd = new Date(resizeRef.current.originalEndTime.getTime() + deltaMinutes * 60000)

      // Minimum 15-min duration
      if (newEnd.getTime() > resizeRef.current.startTime.getTime() + 15 * 60000) {
        onUpdateEvent(resizeRef.current.eventId, { endTime: newEnd })
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      resizeRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, onUpdateEvent])

  const statusColors: Record<string, string> = {
    draft: 'var(--text-muted)',
    scheduled: 'var(--color-blue)',
    published: 'var(--color-green)',
    failed: 'var(--color-red)',
  }

  return (
    <div
      className="sx-custom-time-event"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={{
        width: '100%',
        height: '100%',
        borderLeft: `3px solid ${eventColor}`,
        background: `${eventColor}12`,
        borderRadius: 8,
        padding: '4px 8px',
        cursor: isResizing ? 'ns-resize' : 'pointer',
        position: 'relative',
        overflow: 'hidden',
        fontSize: 11,
        color: eventColor,
        boxSizing: 'border-box',
        userSelect: 'none',
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {ContentIcon && <ContentIcon style={{ width: 12, height: 12, flexShrink: 0 }} />}
        <span style={{
          fontWeight: 600,
          fontSize: 11,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          lineHeight: '16px',
        }}>
          {parsed.title || '(无标题)'}
        </span>
        <span
          draggable
          onDragStart={handleDragStart}
          onClick={(e) => e.stopPropagation()}
          title="拖拽到 Agent 作为引用"
          style={{
            marginLeft: 'auto',
            width: 14,
            height: 14,
            borderRadius: 4,
            background: `${eventColor}1f`,
            color: eventColor,
            fontSize: 9,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'grab',
            flexShrink: 0,
          }}
        >
          @
        </span>
      </div>

      {/* Time */}
      <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
        {formatTime(parsed.startTime)} - {formatTime(parsed.endTime)}
      </div>

      {/* Location */}
      {location && (
        <div
          title={location}
          style={{
            fontSize: 10, opacity: 0.85, marginTop: 2,
            display: 'flex', alignItems: 'center', gap: 4,
            overflow: 'hidden',
          }}
        >
          <MapPin style={{ width: 10, height: 10, flexShrink: 0 }} strokeWidth={2} />
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {location}
          </span>
        </div>
      )}

      {/* Platform badges */}
      {platforms.length > 0 && (
        <div style={{ display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap' }}>
          {platforms.map(p => (
            <span
              key={p}
              style={{
                fontSize: 9,
                padding: '1px 4px',
                borderRadius: 3,
                background: `${eventColor}20`,
                lineHeight: '13px',
              }}
            >
              {PLATFORM_LABELS[p] || p}
            </span>
          ))}
        </div>
      )}

      {/* Publish status dot */}
      {publishStatus && (
        <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: statusColors[publishStatus] || 'var(--text-muted)',
          }} />
          <span style={{ fontSize: 9, opacity: 0.7 }}>
            {publishStatus === 'draft' ? '草稿' : publishStatus === 'scheduled' ? '已排期' : publishStatus === 'published' ? '已发布' : '失败'}
          </span>
        </div>
      )}

      {/* Resize handle at bottom */}
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 6,
          cursor: 'ns-resize',
          borderRadius: '0 0 8px 8px',
        }}
      >
        <div style={{
          width: 20,
          height: 2,
          borderRadius: 1,
          background: eventColor,
          opacity: 0.4,
          margin: '2px auto 0',
        }} />
      </div>
    </div>
  )
}
