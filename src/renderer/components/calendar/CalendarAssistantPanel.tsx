import { useCallback, useMemo, useState } from 'react'
import { CalendarCheck, Clock3, Send, Sparkles, X } from 'lucide-react'

export interface CalendarAssistantEvent {
  id: string
  title: string
  startTime: Date
  endTime: Date
  calendarName: string
  color: string
  allDay?: boolean
}

export interface CalendarAssistantSummary {
  todayEvents: CalendarAssistantEvent[]
  weekEvents: CalendarAssistantEvent[]
  nextEvent: CalendarAssistantEvent | null
  weekEventCount: number
  weekTotalHours: number
  weekCalendarCount: number
}

export interface CalendarAssistantPanelProps {
  open: boolean
  summary: CalendarAssistantSummary
  displayTimezone: string
  onClose: () => void
  onAskAgent: (instruction: string) => void
}

const SUGGESTIONS = ['帮我安排本周', '找空档', '优先级建议']

function formatTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    // silent-catch: fall back to local time when a custom timezone id is not supported by Intl.
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}

function formatEventTime(event: CalendarAssistantEvent, timezone: string): string {
  if (event.allDay) return '全天'
  return `${formatTime(event.startTime, timezone)} - ${formatTime(event.endTime, timezone)}`
}

function formatHours(hours: number): string {
  if (Number.isInteger(hours)) return String(hours)
  return hours.toFixed(1)
}

export default function CalendarAssistantPanel({
  open,
  summary,
  displayTimezone,
  onClose,
  onAskAgent,
}: CalendarAssistantPanelProps) {
  const [draft, setDraft] = useState('')
  const topEvents = useMemo(() => summary.todayEvents.slice(0, 4), [summary.todayEvents])

  const submit = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    onAskAgent(trimmed)
    setDraft('')
  }, [onAskAgent])

  return (
    <aside
      aria-hidden={!open}
      className={`calendar-assistant-drawer calendar-assistant-surface content-surface-panel ${open ? 'is-entered' : ''}`}
    >
      <div className="calendar-assistant-header">
        <div className="calendar-assistant-title">
          <Sparkles className="h-4 w-4" />
          <span>日程管家</span>
        </div>
        <button
          type="button"
          className="calendar-icon-button"
          aria-label="关闭日程管家"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="calendar-assistant-scroll panel-hover-scrollbar">
        <section className="calendar-assistant-card">
          <div className="calendar-assistant-section-title">
            <span>今天 {summary.todayEvents.length} 件事</span>
          </div>
          {topEvents.length > 0 ? (
            <div className="calendar-assistant-event-list">
              {topEvents.map((event) => (
                <div key={event.id} className="calendar-assistant-event">
                  <span className="calendar-assistant-event-dot" style={{ background: event.color }} />
                  <div className="calendar-assistant-event-main">
                    <span className="calendar-assistant-event-title">{event.title || '无标题日程'}</span>
                    <span className="calendar-assistant-event-time">
                      {formatEventTime(event, displayTimezone)}
                    </span>
                  </div>
                  <span className="calendar-assistant-event-source">{event.calendarName}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="calendar-assistant-empty">今天还没有安排</div>
          )}
        </section>

        <section className="calendar-assistant-card">
          <div className="calendar-assistant-section-title">
            <Clock3 className="h-3.5 w-3.5" />
            <span>下一个</span>
          </div>
          {summary.nextEvent ? (
            <div className="calendar-assistant-next">
              <div>
                <div className="calendar-assistant-next-title">{summary.nextEvent.title || '无标题日程'}</div>
                <div className="calendar-assistant-next-time">
                  {formatEventTime(summary.nextEvent, displayTimezone)}
                </div>
              </div>
              <CalendarCheck className="h-4 w-4" />
            </div>
          ) : (
            <div className="calendar-assistant-empty">后面暂时没有待办日程</div>
          )}
        </section>

        <section className="calendar-assistant-card">
          <div className="calendar-assistant-section-title">
            <span>本周概览</span>
          </div>
          <div className="calendar-assistant-metrics">
            <div>
              <strong>{summary.weekEventCount}</strong>
              <span>总事件</span>
            </div>
            <div>
              <strong>{formatHours(summary.weekTotalHours)}</strong>
              <span>小时</span>
            </div>
            <div>
              <strong>{summary.weekCalendarCount}</strong>
              <span>日历</span>
            </div>
          </div>
        </section>

        <div className="calendar-assistant-suggestions">
          {SUGGESTIONS.map((label) => (
            <button
              key={label}
              type="button"
              className="calendar-assistant-chip"
              onClick={() => submit(label)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="calendar-assistant-composer">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit(draft)
          }}
          placeholder="告诉我想怎么调整日程"
        />
        <button
          type="button"
          className="calendar-assistant-send"
          aria-label="发送给日程管家"
          onClick={() => submit(draft)}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </aside>
  )
}
