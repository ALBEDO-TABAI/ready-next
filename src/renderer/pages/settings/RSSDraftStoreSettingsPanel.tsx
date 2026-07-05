import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react'
import { Info, Loader2, RefreshCw, Trash2 } from 'lucide-react'

interface RSSDraftStoreSourceRow {
  sourceId: string
  sourceName: string
  sourceUrl: string
  platform: string
  storedCount: number
  inboxCount: number
  starredCount: number
  refreshMode: 'full' | 'incremental'
  lastFetchedAt: string | null
}

const RSS_DRAFT_CONTENT_MAX_WIDTH = 1560
const RSS_DRAFT_GRID_COLUMNS = 'minmax(300px, 1fr) 72px 84px 72px 120px 128px'
const RSS_DRAFT_SOURCE_COLUMN_PADDING = 44
const RSS_DRAFT_LIGHT_BORDER = '1px solid color-mix(in srgb, var(--surface-border) 14%, transparent)'
const RSS_DRAFT_DIVIDER = '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)'

const RSS_DRAFT_SUBTLE_SURFACE_STYLE: CSSProperties = {
  border: RSS_DRAFT_LIGHT_BORDER,
  borderRadius: 12,
  background: 'color-mix(in srgb, var(--surface-card-bg) 8%, transparent)',
  boxShadow: 'none',
}

export function RSSDraftStoreSettingsPanel() {
  const [sources, setSources] = useState<RSSDraftStoreSourceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const summary = useMemo(
    () => ({
      sourceCount: sources.length,
      storedCount: sources.reduce((total, source) => total + source.storedCount, 0),
      inboxCount: sources.reduce((total, source) => total + source.inboxCount, 0),
      starredCount: sources.reduce((total, source) => total + source.starredCount, 0),
    }),
    [sources],
  )

  const summaryItems = [
    { label: '源', value: `${summary.sourceCount} 个` },
    { label: '底稿', value: `${summary.storedCount} 条` },
    { label: '收件箱', value: `${summary.inboxCount} 条` },
    { label: '收藏', value: `${summary.starredCount} 条` },
  ]

  const loadSources = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.rss?.getDraftStoreSources) return
    setLoading(true)
    try {
      const result = await window.electronAPI.rss.getDraftStoreSources()
      if (!result.success || !result.data) {
        setMessage(result.error || '读取 RSS 底稿仓库失败')
        setSources([])
        return
      }
      setSources(result.data)
      setMessage(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const handleClear = useCallback(async (sourceId?: string, sourceName?: string) => {
    if (!window.electronAPI?.rss?.clearDraftStore) return
    const confirmed = window.confirm(
      sourceId
        ? `确认重新完整抓取「${sourceName || '当前源'}」吗？\n\n这会清空该源已缓存的底稿，下次刷新会重新走首次完整抓取。`
        : '确认清空全部 RSS 底稿吗？\n\n这会清空所有源已缓存的底稿，下次刷新会重新走首次完整抓取。',
    )
    if (!confirmed) return
    setBusyKey(sourceId || 'all')
    try {
      const result = await window.electronAPI.rss.clearDraftStore(sourceId ? { sourceId } : undefined)
      if (!result.success || !result.data) {
        setMessage(result.error || '重置 RSS 底稿仓库失败')
        return
      }
      await loadSources()
      setMessage(
        sourceId
          ? `${sourceName || '当前源'} 已重置，下次刷新会重新走首次完整抓取`
          : '全部 RSS 底稿已重置，下次刷新会重新走首次完整抓取',
      )
    } finally {
      setBusyKey(null)
    }
  }, [loadSources])

  return (
    <div className="flex w-full flex-col gap-5" style={{ maxWidth: RSS_DRAFT_CONTENT_MAX_WIDTH }}>
      <div
        style={{
          borderTop: RSS_DRAFT_DIVIDER,
          borderBottom: RSS_DRAFT_DIVIDER,
          padding: '22px 0 18px',
        }}
      >
        <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
          {summaryItems.map((item, index) => (
            <div
              key={item.label}
              className="flex items-baseline gap-2"
              style={{
                paddingLeft: index === 0 ? 0 : 40,
                borderLeft: index === 0 ? 'none' : RSS_DRAFT_DIVIDER,
              }}
            >
              <strong className="text-[20px] font-semibold leading-none" style={{ color: 'var(--text-title)' }}>{item.value}</strong>
              <span className="text-[12px]" style={{ color: 'var(--text-light)' }}>{item.label}</span>
            </div>
          ))}
          <span
            className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium"
            style={{
              border: RSS_DRAFT_LIGHT_BORDER,
              background: 'color-mix(in srgb, var(--surface-card-bg) 10%, transparent)',
              color: 'var(--text-muted)',
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-green)' }} />
            默认增量刷新
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 px-0.5 text-[12px] leading-6" style={{ color: 'var(--text-light)' }}>
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>
          重置底稿不会删除 RSS 源、收藏或收件箱内容，只会让下次刷新重新完整抓取。
        </span>
      </div>
      {message && (
        <div
          className="rounded-lg px-3 py-2 text-[12px]"
          style={{
            border: RSS_DRAFT_LIGHT_BORDER,
            background: 'color-mix(in srgb, var(--surface-panel-bg) 8%, transparent)',
            color: 'var(--text-muted)',
          }}
        >
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-3" style={{ ...RSS_DRAFT_SUBTLE_SURFACE_STYLE, padding: '16px 18px' }}>
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-blue)' }} />
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取 RSS 底稿列表…</span>
        </div>
      ) : sources.length === 0 ? (
        <div style={{ ...RSS_DRAFT_SUBTLE_SURFACE_STYLE, padding: '18px' }}>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>还没有底稿内容</div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--text-light)' }}>等你添加源并刷新后，这里会显示每个源的存量和当前刷新状态。</div>
        </div>
      ) : (
        <div className="overflow-x-auto" style={RSS_DRAFT_SUBTLE_SURFACE_STYLE}>
          <div style={{ minWidth: 920 }}>
            <div
              className="grid items-center gap-6 text-[12px] font-medium"
              style={{
                gridTemplateColumns: RSS_DRAFT_GRID_COLUMNS,
                color: 'var(--text-light)',
                borderBottom: RSS_DRAFT_DIVIDER,
                padding: '28px 0 18px',
              }}
            >
              <span style={{ paddingLeft: RSS_DRAFT_SOURCE_COLUMN_PADDING }}>来源</span>
              <span>底稿</span>
              <span>收件箱</span>
              <span>收藏</span>
              <span>刷新方式</span>
              <span style={{ textAlign: 'left' }}>操作</span>
            </div>
            {sources.map((source, index) => (
              <div
                key={source.sourceId}
                className="grid min-h-[86px] items-center gap-6 px-6 py-4"
                style={{
                  gridTemplateColumns: RSS_DRAFT_GRID_COLUMNS,
                  borderTop: index === 0 ? 'none' : RSS_DRAFT_DIVIDER,
                }}
              >
                <div className="min-w-0" style={{ paddingLeft: RSS_DRAFT_SOURCE_COLUMN_PADDING }}>
                  <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-title)' }} title={source.sourceName}>
                    {source.sourceName}
                  </div>
                  <div className="mt-1 truncate text-[12px]" style={{ color: 'var(--text-light)' }} title={source.sourceUrl}>
                    {source.sourceUrl}
                  </div>
                </div>
                <strong className="text-[14px] font-medium" style={{ color: 'var(--text-title)' }}>{source.storedCount}</strong>
                <strong className="text-[14px] font-medium" style={{ color: 'var(--text-title)' }}>{source.inboxCount}</strong>
                <span className="text-[14px]" style={{ color: 'var(--text-muted)' }}>{source.starredCount}</span>
                <span
                  className="inline-flex w-fit items-center gap-2 rounded-full px-2.5 py-1 text-[12px] font-medium"
                  style={{
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: source.refreshMode === 'incremental' ? 'var(--color-green)' : 'var(--color-orange)' }}
                  />
                  {source.refreshMode === 'incremental' ? '增量刷新' : '首次完整'}
                </span>
                <button
                  onClick={() => void handleClear(source.sourceId, source.sourceName)}
                  disabled={busyKey !== null}
                  className="ml-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'color-mix(in srgb, var(--color-red) 42%, var(--text-muted) 58%)',
                  }}
                >
                  {busyKey === source.sourceId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  重新完整抓取
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        aria-label="清空全部底稿"
        onClick={() => void handleClear()}
        disabled={busyKey !== null}
        className="w-full text-left transition-[filter,transform,opacity] duration-200 hover:brightness-110 active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          ...RSS_DRAFT_SUBTLE_SURFACE_STYLE,
          padding: `20px 24px 20px ${RSS_DRAFT_SOURCE_COLUMN_PADDING}px`,
        }}
      >
        <div className="flex items-center gap-3 text-[13px] font-semibold" style={{ color: 'var(--color-red)' }}>
          {busyKey === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          清空全部底稿
        </div>
        <div className="mt-2 text-[12px]" style={{ color: 'var(--text-light)' }}>
          清空后会移除所有历史底稿数据，下一次刷新将重新完整抓取。
        </div>
      </button>
    </div>
  )
}
