import type { ViewType } from './schedule-x-utils'

interface CalendarDiagnosticsPanelProps {
  isMock: boolean
  dataLoaded: boolean
  viewType: ViewType
  currentDate: Date
  totalSources: number
  enabledSources: number
  totalEvents: number
  visibleRangeStart: string | null
  visibleRangeEnd: string | null
  selectedEventId: string | null
  selectedEventTitle: string | null
  lastMutationAt: number | null
  conflictState: {
    hasConflict: boolean
    reason: string | null
  }
  onRefresh: () => void | Promise<void>
}

function formatWhen(value: number | string | null): string {
  if (!value) return '未记录'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function CalendarDiagnosticsPanel({
  isMock,
  dataLoaded,
  viewType,
  currentDate,
  totalSources,
  enabledSources,
  totalEvents,
  visibleRangeStart,
  visibleRangeEnd,
  selectedEventId,
  selectedEventTitle,
  lastMutationAt,
  conflictState,
  onRefresh,
}: CalendarDiagnosticsPanelProps) {
  return (
    <div
      className="mt-3 rounded-[14px] border px-3 py-3 text-[11px]"
      style={{
        borderColor: 'var(--border-default)',
        background: 'rgba(255,255,255,0.74)',
        color: 'var(--text-secondary)',
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-light)' }}>
          Calendar Diagnostics
        </div>
        <button
          onClick={() => void onRefresh()}
          className="rounded-full px-2 py-1 text-[10px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--color-blue)' }}
        >
          刷新
        </button>
      </div>
      <div>数据状态：{dataLoaded ? (isMock ? 'mock' : 'live') : 'loading'}</div>
      <div>当前视图：{viewType} · {currentDate.toLocaleDateString('zh-CN')}</div>
      <div>日历源：{enabledSources} / {totalSources} 启用</div>
      <div>事件总数：{totalEvents}</div>
      <div>可视范围：{visibleRangeStart ? formatWhen(visibleRangeStart) : '未计算'} - {visibleRangeEnd ? formatWhen(visibleRangeEnd) : '未计算'}</div>
      <div>当前事件：{selectedEventTitle || selectedEventId || '未选中'}</div>
      <div>最近变更：{formatWhen(lastMutationAt)}</div>
      <div style={{ color: conflictState.hasConflict ? 'var(--color-orange)' : 'var(--text-secondary)' }}>
        冲突状态：{conflictState.hasConflict ? conflictState.reason || '存在冲突' : '无冲突'}
      </div>
    </div>
  )
}
