import { useState, useEffect, useCallback, useMemo } from 'react'
import { Info, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui'
import {
  SettingsCard,
  SettingsNotice,
  SettingsRow,
  SettingsStatus,
} from './settings-shared'

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

// 来源 / 底稿 / 收件箱 / 收藏 / 刷新方式 / 操作；数字列右对齐等宽，操作列贴右。
const RSS_DRAFT_GRID_COLUMNS = 'minmax(220px, 1fr) 56px 64px 52px 104px 132px'
const RSS_DRAFT_TABLE_MIN_WIDTH = 720

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
    { label: '源', value: summary.sourceCount, unit: '个' },
    { label: '底稿', value: summary.storedCount, unit: '条' },
    { label: '收件箱', value: summary.inboxCount, unit: '条' },
    { label: '收藏', value: summary.starredCount, unit: '条' },
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

  const messageIsError = message !== null && message.includes('失败')

  return (
    <div className="sx-stack w-full" style={{ gap: 20 }}>
      <section className="sx-card sx-card--pad">
        <div className="flex flex-wrap items-center gap-y-4">
          {summaryItems.map((item, index) => (
            <div
              key={item.label}
              className="sx-stat"
              style={{
                paddingLeft: index === 0 ? 0 : 28,
                paddingRight: 28,
                borderLeft: index === 0 ? 'none' : '.5px solid var(--rn-hair)',
              }}
            >
              <span className="sx-stat__value">
                {item.value}
                <small className="ml-1 text-[12px] font-normal" style={{ color: 'var(--rn-ink-2)' }}>{item.unit}</small>
              </span>
              <span className="sx-stat__label">{item.label}</span>
            </div>
          ))}
          <span className="sx-badge ml-auto">
            <span className="sx-dot sx-dot--accent" aria-hidden />
            默认增量刷新
          </span>
        </div>
      </section>

      <SettingsNotice tone="plain" icon={Info}>
        重置底稿不会删除 RSS 源、收藏或收件箱内容，只会让下次刷新重新完整抓取。
      </SettingsNotice>

      {message && (
        <SettingsNotice tone={messageIsError ? 'danger' : 'plain'}>
          {message}
        </SettingsNotice>
      )}

      {loading ? (
        <section className="sx-card sx-card--pad flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--rn-ink-2)' }} />
          <span className="text-[12px]" style={{ color: 'var(--rn-ink-2)' }}>正在读取 RSS 底稿列表…</span>
        </section>
      ) : sources.length === 0 ? (
        <SettingsCard
          title="还没有底稿内容"
          description="等你添加源并刷新后，这里会显示每个源的存量和当前刷新状态。"
        />
      ) : (
        <section className="sx-card overflow-x-auto">
          <div className="sx-table" style={{ minWidth: RSS_DRAFT_TABLE_MIN_WIDTH }}>
            <div className="sx-table__head" style={{ gridTemplateColumns: RSS_DRAFT_GRID_COLUMNS }}>
              <span>来源</span>
              <span className="text-right">底稿</span>
              <span className="text-right">收件箱</span>
              <span className="text-right">收藏</span>
              <span style={{ paddingLeft: 12 }}>刷新方式</span>
              <span className="text-right">操作</span>
            </div>
            {sources.map((source) => (
              <div
                key={source.sourceId}
                className="sx-table__row"
                style={{ gridTemplateColumns: RSS_DRAFT_GRID_COLUMNS, minHeight: 60 }}
              >
                <div className="min-w-0 py-2.5">
                  <div className="truncate text-[13px] font-medium" style={{ color: 'var(--rn-ink)' }} title={source.sourceName}>
                    {source.sourceName}
                  </div>
                  <div className="sx-meta mt-0.5 truncate" title={source.sourceUrl}>
                    {source.sourceUrl}
                  </div>
                </div>
                <span className="sx-mono text-right text-[13px]" style={{ color: 'var(--rn-ink)' }}>{source.storedCount}</span>
                <span className="sx-mono text-right text-[13px]" style={{ color: 'var(--rn-ink)' }}>{source.inboxCount}</span>
                <span className="sx-mono text-right text-[13px]" style={{ color: 'var(--rn-ink-2)' }}>{source.starredCount}</span>
                {/* 常态（增量）只给中性点，例外（首次完整）才着色——避免一整列强调色圆点。 */}
                <SettingsStatus tone={source.refreshMode === 'incremental' ? 'muted' : 'warning'} className="pl-3">
                  {source.refreshMode === 'incremental' ? '增量刷新' : '首次完整'}
                </SettingsStatus>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleClear(source.sourceId, source.sourceName)}
                  disabled={busyKey !== null}
                  aria-busy={busyKey === source.sourceId ? true : undefined}
                  className="sx-table__action justify-self-end"
                  icon={busyKey === source.sourceId ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                >
                  重新完整抓取
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <SettingsCard>
        <SettingsRow
          label="清空全部底稿"
          description="清空后会移除所有历史底稿数据，下一次刷新将重新完整抓取。"
        >
          <Button
            variant="danger"
            aria-label="清空全部底稿"
            onClick={() => void handleClear()}
            disabled={busyKey !== null}
            aria-busy={busyKey === 'all' ? true : undefined}
            icon={busyKey === 'all' ? <Loader2 className="animate-spin" /> : <Trash2 />}
          >
            全部清空
          </Button>
        </SettingsRow>
      </SettingsCard>
    </div>
  )
}
