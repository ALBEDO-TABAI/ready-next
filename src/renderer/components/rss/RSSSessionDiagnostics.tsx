interface RSSSessionDiagnosticsProps {
  selectedSourceId: string | null
  selectedItemId: string | null
  selectedItemTitle: string | null
  totalItems: number
  unreadItems: number
  visibleItems: number
  lastFetchAt: number | null
  lastAnalysis: {
    jobId: string | null
    itemId: string | null
    status: string | null
    reportPath: string | null
    manifestPath: string | null
    updatedAt: number | null
  }
}

function formatWhen(value: number | null): string {
  if (!value) return '未记录'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function RSSSessionDiagnostics({
  selectedSourceId,
  selectedItemId,
  selectedItemTitle,
  totalItems,
  unreadItems,
  visibleItems,
  lastFetchAt,
  lastAnalysis,
}: RSSSessionDiagnosticsProps) {
  return (
    <div
      className="border-b px-5 py-3 text-[11px]"
      style={{
        borderColor: 'var(--border-default)',
        background: 'rgba(255,255,255,0.78)',
        color: 'var(--text-secondary)',
      }}
    >
      <div className="mb-2 text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-light)' }}>
        RSS Session
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div>当前订阅源：{selectedSourceId || '全部'}</div>
          <div>当前条目：{selectedItemTitle || selectedItemId || '未选中'}</div>
          <div>列表范围：{visibleItems} / {totalItems} 条</div>
          <div>未读数量：{unreadItems}</div>
        </div>
        <div>
          <div>最近拉取：{formatWhen(lastFetchAt)}</div>
          <div>最近分析：{lastAnalysis.status || '未执行'}</div>
          <div>分析任务：{lastAnalysis.jobId || '无'}</div>
          <div className="truncate">报告：{lastAnalysis.reportPath || '未生成'}</div>
        </div>
      </div>
    </div>
  )
}
