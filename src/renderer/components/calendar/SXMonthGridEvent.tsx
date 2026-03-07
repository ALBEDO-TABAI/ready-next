import { useCallback } from 'react'
import { Video, Image as ImageIcon, FileText, BookOpen, Radio } from 'lucide-react'
import { useCalendarContext } from './CalendarContext'
import { sxEventToEvent } from './schedule-x-utils'
import type { CalendarEvent } from './schedule-x-utils'

const CONTENT_TYPE_ICONS: Record<string, typeof Video> = {
  video: Video,
  image: ImageIcon,
  article: FileText,
  story: BookOpen,
  live: Radio,
}

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖',
  bilibili: 'B',
  xiaohongshu: '红',
  wechat: '微',
  weibo: '博',
}

const PLATFORM_COLORS: Record<string, string> = {
  douyin: '#161823',
  bilibili: '#00A1D6',
  xiaohongshu: '#FF2442',
  wechat: '#07C160',
  weibo: '#E6162D',
}

interface SXMonthGridEventProps {
  calendarEvent: Record<string, unknown>
}

/**
 * Custom month grid event renderer for Schedule-X.
 * Compact pill style with content type icon, title, and platform badges.
 */
export default function SXMonthGridEvent({ calendarEvent }: SXMonthGridEventProps) {
  const { onEditEvent } = useCalendarContext()

  const parsed = sxEventToEvent(calendarEvent)
  const eventColor = (calendarEvent.color as string) || '#5B8DEF'
  const contentType = (calendarEvent.contentType as string) || undefined
  const platformStr = (calendarEvent.platform as string) || ''
  let platforms: string[] = []
  try {
    platforms = platformStr ? JSON.parse(platformStr) : []
  } catch {
    platforms = []
  }

  const ContentIcon = contentType ? CONTENT_TYPE_ICONS[contentType] : null

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const event: CalendarEvent = {
      id: String(calendarEvent.id),
      title: (calendarEvent.title as string) || '',
      startTime: parsed.startTime || new Date(),
      endTime: parsed.endTime || new Date(),
      calendarId: (calendarEvent.calendarId as string) || '',
      color: eventColor,
      description: parsed.description,
      allDay: parsed.allDay,
      contentType: parsed.contentType,
      platform: platforms,
      publishStatus: parsed.publishStatus,
    }
    onEditEvent(event)
  }, [calendarEvent, parsed, eventColor, platforms, onEditEvent])

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
      contentType: parsed.contentType,
      platform: platforms,
      publishStatus: parsed.publishStatus,
      draggedAt: Date.now(),
    })
    e.dataTransfer.setData('application/x-ready-drag', payload)
    e.dataTransfer.setData('text/plain', parsed.title || '(无标题日程)')
    e.dataTransfer.effectAllowed = 'copy'
  }, [calendarEvent.calendarId, calendarEvent.id, eventColor, parsed.contentType, parsed.description, parsed.endTime, parsed.publishStatus, parsed.startTime, parsed.title, platforms])

  return (
    <div
      className="sx-custom-month-event"
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px',
        borderRadius: 4,
        background: `${eventColor}15`,
        borderLeft: `2px solid ${eventColor}`,
        color: eventColor,
        cursor: 'pointer',
        overflow: 'hidden',
        fontSize: 10,
        lineHeight: '18px',
        width: '100%',
        boxSizing: 'border-box',
        userSelect: 'none',
      }}
    >
      {ContentIcon && <ContentIcon style={{ width: 10, height: 10, flexShrink: 0 }} />}
      <span style={{
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
        minWidth: 0,
      }}>
        {parsed.title || '(无标题)'}
      </span>

      {/* Platform badges */}
      {platforms.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {platforms.slice(0, 2).map(p => (
            <span
              key={p}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                borderRadius: 2,
                background: PLATFORM_COLORS[p] || '#999',
                color: '#FFFFFF',
                fontSize: 7,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {PLATFORM_LABELS[p] || '?'}
            </span>
          ))}
        </div>
      )}
      <span
        draggable
        onDragStart={handleDragStart}
        onClick={(e) => e.stopPropagation()}
        title="拖拽到 Agent 作为引用"
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: `${eventColor}1f`,
          color: eventColor,
          fontSize: 8,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          flexShrink: 0,
          marginLeft: 2,
        }}
      >
        @
      </span>
    </div>
  )
}
