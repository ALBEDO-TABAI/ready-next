import { useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isToday,
  startOfWeek,
  addDays,
  addMonths,
  subMonths,
  isSameMonth,
  isSameDay,
  isSameWeek,
} from 'date-fns'
import { zhCN } from 'date-fns/locale'

interface MiniCalendarProps {
  currentDate: Date
  selectedDate: Date | null
  events: { startTime: Date; color: string }[]
  onDateChange: (date: Date) => void
  onSelectDate: (date: Date) => void
}

export default function MiniCalendar({
  currentDate,
  selectedDate,
  events,
  onDateChange,
  onSelectDate,
}: MiniCalendarProps) {
  const monthStart = startOfMonth(currentDate)
  const monthEnd = endOfMonth(currentDate)
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd })

  // Pad the start of the grid to align with weekday columns
  const firstDayOfWeek = startOfWeek(monthStart, { weekStartsOn: 0 })
  const leadingDays: Date[] = []
  let d = firstDayOfWeek
  while (d < monthStart) {
    leadingDays.push(d)
    d = addDays(d, 1)
  }

  const allDays = [...leadingDays, ...monthDays]

  // Task 12: Build a map of dates that have events, with their colors
  const eventDotMap = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const event of events) {
      const key = format(event.startTime, 'yyyy-MM-dd')
      const existing = map.get(key) || []
      if (!existing.includes(event.color)) {
        existing.push(event.color)
      }
      map.set(key, existing)
    }
    return map
  }, [events])

  // Task 12: Navigate months
  const handlePrevMonth = () => {
    onDateChange(subMonths(currentDate, 1))
  }

  const handleNextMonth = () => {
    onDateChange(addMonths(currentDate, 1))
  }

  // Task 12: Click date -> jump to that week in CalendarView
  const handleDateClick = (day: Date) => {
    onSelectDate(day)
  }

  return (
    <div>
      {/* MiniCalNav */}
      <div className="flex items-center justify-between" style={{ height: 28 }}>
        <span className="text-[13px] font-semibold">
          {format(currentDate, 'yyyy年 M月', { locale: zhCN })}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePrevMonth}
            className="p-1 rounded hover:bg-[var(--bg-hover)]"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={handleNextMonth}
            className="p-1 rounded hover:bg-[var(--bg-hover)]"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* MiniWeekHeader */}
      <div
        className="flex items-center justify-between"
        style={{ height: 22, padding: '0 2px' }}
      >
        {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map(day => (
          <span
            key={day}
            style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-placeholder)', textAlign: 'center', flex: 1 }}
          >
            {day}
          </span>
        ))}
      </div>

      {/* Days Grid */}
      <div className="grid grid-cols-7" style={{ gap: 2 }}>
        {allDays.map((day, i) => {
          const inMonth = isSameMonth(day, currentDate)
          const today = isToday(day)
          const selected = selectedDate && isSameDay(day, selectedDate)
          const inCurrentWeek = isSameWeek(day, currentDate, { weekStartsOn: 0 })
          const dayKey = format(day, 'yyyy-MM-dd')
          const dotColors = eventDotMap.get(dayKey) || []

          return (
            <button
              key={i}
              onClick={() => handleDateClick(day)}
              className="flex flex-col items-center justify-center transition-colors relative"
              style={{
                height: 28,
                borderRadius: today ? 14 : 4,
                background: today
                  ? 'var(--calendar-today-accent)'
                  : selected
                    ? 'var(--calendar-mini-selected-bg)'
                    : inCurrentWeek && inMonth
                      ? 'var(--calendar-mini-week-bg)'
                      : 'transparent',
                color: today
                  ? '#FFFFFF'
                  : selected
                    ? 'var(--color-blue)'
                    : inMonth
                      ? 'var(--text-body)'
                      : 'var(--text-placeholder)',
                fontSize: 11,
                fontWeight: today || selected ? 600 : 500,
              }}
            >
              <span>{format(day, 'd')}</span>
              {/* Task 12: Event dot indicators */}
              {dotColors.length > 0 && (
                <div className="flex items-center gap-px absolute" style={{ bottom: 1 }}>
                  {dotColors.slice(0, 3).map((color, idx) => (
                    <span
                      key={idx}
                      className="rounded-full"
                      style={{
                        width: 3,
                        height: 3,
                        background: today ? '#FFFFFF' : color,
                        opacity: today ? 0.8 : 1,
                      }}
                    />
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
