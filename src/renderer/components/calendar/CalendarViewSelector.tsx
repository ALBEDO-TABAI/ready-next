import type { ViewType } from './schedule-x-utils'

const VIEW_OPTIONS: { value: ViewType; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

export default function CalendarViewSelector({
  viewType,
  onViewTypeChange,
}: {
  viewType: ViewType
  onViewTypeChange: (value: ViewType) => void
}) {
  return (
    <div className="calendar-view-segment" role="group" aria-label="切换日历视图">
      {VIEW_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className={viewType === value ? 'is-active' : ''}
          aria-pressed={viewType === value}
          onClick={() => onViewTypeChange(value)}
          style={{ fontSize: 12 }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
