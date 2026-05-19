import { useMemo, useState } from 'react'
import {
  Filter,
  Star,
  Plus,
  Sparkles,
  ChevronDown,
  ListTodo,
  RefreshCw,
  Check,
  CircleDashed,
  Loader2,
  Settings,
  TriangleAlert,
  X,
  Play,
  Pause,
  Trash2,
} from 'lucide-react'
import { WORKBENCH_HEADER_EDGE_X } from '../../modules/workbench/chrome'
import { endRssItemDragSession, setRssItemDragPayload } from '../layout/fileTreeExternalDrop'

export interface RSSItem {
  id: string
  title: string
  source: string
  author: string
  sourceId: string
  summary: string
  publishedAt: string
  inboxVisible?: boolean
  read: boolean
  starred: boolean
  coverImage?: string
  link: string
}

export interface RSSSource {
  id: string
  name: string
  count: number
  platform?: string
  url?: string
}

type AnalysisStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'

interface ItemAnalysisProgress {
  itemId: string
  jobId: string
  action: 'copy' | 'visual'
  status: AnalysisStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

interface AnalysisJobItem {
  id: string
  itemId: string
  action: 'copy' | 'visual'
  title: string
  status: AnalysisStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

interface RSSFeedProps {
  items: RSSItem[]
  sources: RSSSource[]
  filter: 'all' | 'unread' | 'starred'
  selectedSource: string | null
  selectedItemId: string | null
  loading: boolean
  refreshing: boolean
  isMock: boolean
  hasPreview: boolean
  newItemIds: Set<string>
  analysisProgressMap: Record<string, ItemAnalysisProgress>
  analysisJobs: AnalysisJobItem[]
  onFilterChange: (filter: 'all' | 'unread' | 'starred') => void
  onSourceChange: (sourceId: string | null) => void
  onItemClick: (item: RSSItem) => void
  onMarkItemRead: (itemId: string) => void
  onToggleStar: (itemId: string) => void
  onDeleteItem: (itemId: string) => void
  onOpenAnalysisOutput: (itemId: string) => void
  onRefresh: () => void
  onAddSource: () => void
  onClearRead: () => void
  onOpenSettings: () => void
  onPauseAnalysisJob: (jobId: string) => void
  onResumeAnalysisJob: (jobId: string) => void
  onDeleteAnalysisJob: (jobId: string) => void
  settingsOpen: boolean
}

function progressStroke(status: AnalysisStatus | undefined): string {
  if (status === 'success') return 'var(--color-green)'
  if (status === 'failed') return 'var(--color-red)'
  if (status === 'paused') return 'var(--color-orange)'
  if (status === 'running_script' || status === 'running_subagent' || status === 'queued') {
    return 'var(--color-blue)'
  }
  return 'var(--text-light)'
}

function progressLabel(entry: ItemAnalysisProgress | undefined): string {
  if (!entry) return '暂无分析任务'
  const stageText: Record<AnalysisStatus, string> = {
    queued: '排队中',
    paused: '已暂停',
    running_script: '脚本处理中',
    running_subagent: 'AI 总结中',
    success: '已完成',
    failed: '已失败',
    skipped: '已跳过'
  }
  const stage = stageText[entry.status] || entry.status
  const detail = entry.error || entry.message || ''
  return detail ? `${stage} ${entry.progress}% · ${detail}` : `${stage} ${entry.progress}%`
}

function taskTypeLabel(action: 'copy' | 'visual' | string): string {
  if (action === 'visual') return '视觉分析'
  if (action === 'copy') return '文案分析'
  return '剪藏'
}

function taskStageLabel(status: AnalysisStatus): string {
  const map: Record<AnalysisStatus, string> = {
    queued: '排队中',
    paused: '已暂停',
    running_script: '脚本处理中',
    running_subagent: 'agent 分析中',
    success: '已完成',
    failed: '已失败',
    skipped: '已跳过'
  }
  return map[status] || status
}

function taskStageTone(status: AnalysisStatus): { color: string; background: string } {
  if (status === 'success') {
    return {
      color: 'var(--color-green)',
      background: 'color-mix(in srgb, var(--color-green) 12%, transparent)'
    }
  }
  if (status === 'failed') {
    return {
      color: 'var(--color-red)',
      background: 'color-mix(in srgb, var(--color-red) 10%, transparent)'
    }
  }
  if (status === 'paused') {
    return {
      color: 'var(--color-orange)',
      background: 'color-mix(in srgb, var(--color-orange) 12%, transparent)'
    }
  }
  return {
    color: 'var(--color-blue)',
    background: 'color-mix(in srgb, var(--color-blue) 10%, transparent)'
  }
}

function taskDetailText(job: AnalysisJobItem): string {
  if (job.error) return job.error

  const message = (job.message || '').trim()
  if (!message || job.status === 'success') return ''
  if (job.progress >= 100 && /完成|已完成/.test(message)) return ''
  if (message === taskStageLabel(job.status)) return ''

  return message
}

function AnalysisProgressRing({
  entry
}: {
  entry?: Pick<ItemAnalysisProgress, 'progress' | 'status'>
}) {
  const value = Math.max(0, Math.min(100, entry?.progress ?? 0))
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dash = circumference * (1 - value / 100)
  const status = entry?.status
  const running =
    status === 'queued' || status === 'running_script' || status === 'running_subagent'

  if (status === 'success') {
    return (
      <div className="flex h-5 w-5 items-center justify-center pt-0.5">
        <Check className="h-[13px] w-[13px] text-[var(--color-green)]" strokeWidth={2.4} />
      </div>
    )
  }

  return (
    <div className="relative w-[18px] h-[18px] flex items-center justify-center">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth="2"
          opacity="0.6"
        />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke={progressStroke(status)}
          strokeWidth="2"
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
          strokeDasharray={circumference}
          strokeDashoffset={dash}
          style={{ transition: 'stroke-dashoffset 240ms ease' }}
        />
      </svg>

      {!entry && (
        <CircleDashed className="absolute w-[10px] h-[10px] text-[var(--text-light)] opacity-70" />
      )}
      {running && (
        <Loader2 className="absolute w-[9px] h-[9px] text-[var(--color-blue)] animate-spin" />
      )}
      {status === 'failed' && (
        <TriangleAlert className="absolute w-[10px] h-[10px] text-[var(--color-red)]" />
      )}
      {status === 'paused' && (
        <CircleDashed className="absolute w-[10px] h-[10px] text-[var(--color-orange)]" />
      )}
    </div>
  )
}

export default function RSSFeed({
  items,
  sources,
  filter,
  selectedSource,
  selectedItemId,
  loading,
  refreshing,
  isMock,
  hasPreview: _hasPreview,
  newItemIds,
  analysisProgressMap,
  analysisJobs,
  onFilterChange,
  onSourceChange,
  onItemClick,
  onMarkItemRead,
  onToggleStar,
  onDeleteItem,
  onOpenAnalysisOutput,
  onRefresh,
  onAddSource,
  onClearRead,
  onOpenSettings,
  onPauseAnalysisJob,
  onResumeAnalysisJob,
  onDeleteAnalysisJob,
  settingsOpen,
}: RSSFeedProps) {
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)

  // Apply filters
  const filteredItems = items.filter((item) => {
    if (selectedSource && item.sourceId !== selectedSource) return false
    if (filter === 'unread' && item.read) return false
    if (filter === 'starred' && !item.starred) return false
    return true
  })

  const isRefreshing = loading || refreshing
  const unreadCount = useMemo(() => items.filter((i) => !i.read).length, [items])
  const selectedSourceEntry = useMemo(
    () => sources.find((source) => source.id === selectedSource) ?? null,
    [selectedSource, sources]
  )
  const refreshLabel = isRefreshing ? '刷新中' : '刷新'
  const activeJobsCount = useMemo(
    () =>
      analysisJobs.filter(
        (job) =>
          job.status === 'queued' ||
          job.status === 'running_script' ||
          job.status === 'running_subagent'
      ).length,
    [analysisJobs]
  )
  const sourceSelectWidth = 92
  const filterSelectWidth = 76
  const calendarPillButtonStyle = {
    padding: '4px 10px',
    borderRadius: 10,
    border: '1px solid var(--border-input)',
    background: 'transparent',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-body)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  } as const
  const shouldShowBootstrapSkeleton = loading && filteredItems.length === 0
  const taskMenuPanel = taskMenuOpen ? (
    <div
      className="glass-surface-floating overflow-hidden rounded-[18px] border"
      style={{
        position: 'absolute',
        top: 'calc(100% + 10px)',
        right: 0,
        zIndex: 30,
        width: 384,
        maxWidth: 'min(384px, calc(100vw - 48px))',
        background:
          'color-mix(in srgb, var(--surface-floating-bg) 92%, rgba(255, 255, 255, 0.12))',
        borderColor: 'color-mix(in srgb, var(--border-default) 74%, transparent)',
        boxShadow: '0 20px 52px rgba(24, 33, 49, 0.18)',
        backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
        WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))'
      }}
    >
      <div
        className="flex items-center justify-between border-b"
        style={{
          padding: '19px 20px 19px 23px',
          background: 'color-mix(in srgb, var(--surface-floating-bg) 96%, transparent)',
          borderColor: 'color-mix(in srgb, var(--border-default) 62%, transparent)'
        }}
      >
        <div className="min-w-0">
          <div
            style={{
              fontSize: 13,
              fontWeight: 650,
              color: 'var(--text-secondary)',
              lineHeight: 1.2
            }}
          >
            分析任务
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 11,
              color: 'var(--text-muted)',
              lineHeight: 1.2
            }}
          >
            {analysisJobs.length} 条记录 · {activeJobsCount} 个进行中
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTaskMenuOpen(false)}
          className="flex h-7 w-7 items-center justify-center rounded-[9px] hover:bg-[var(--bg-hover)]"
          title="关闭"
        >
          <X style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
        </button>
      </div>
      {analysisJobs.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
          暂无任务记录
        </div>
      ) : (
        <div
          className="rss-feed-scroll"
          style={{
            display: 'grid',
            gap: 8,
            maxHeight: 360,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '12px 11px 14px'
          }}
        >
          {analysisJobs.map((job) => {
            const isQueued = job.status === 'queued'
            const isPaused = job.status === 'paused'
            const isRunning = job.status === 'running_script' || job.status === 'running_subagent'
            const canDelete = !isRunning
            const canToggle = isQueued || isPaused
            const stageTone = taskStageTone(job.status)
            const detailText = taskDetailText(job)
            const roundedProgress = Math.max(0, Math.min(100, Math.round(job.progress || 0)))
            return (
              <div
                key={job.id}
                className="group rounded-[16px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  minHeight: 62,
                  padding: '10px 12px'
                }}
              >
                <div
                  className="grid items-center"
                  style={{
                    columnGap: 14,
                    gridTemplateColumns: '20px minmax(0, 1fr) 64px'
                  }}
                >
                  <div className="flex h-6 items-center justify-center">
                    <AnalysisProgressRing
                      entry={{
                        progress: roundedProgress,
                        status: job.status
                      }}
                    />
                  </div>

                  <div className="min-w-0">
                    <div
                      className="text-[12px] font-semibold"
                      style={{
                        color: 'var(--text-secondary)',
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        WebkitLineClamp: 1,
                        lineHeight: 1.35
                      }}
                      title={job.title}
                    >
                      {job.title}
                    </div>
                    <div
                      className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <span className="shrink-0">{taskTypeLabel(job.action)}</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{roundedProgress}%</span>
                      <span
                        className="shrink-0 rounded-full px-1.5 py-[1px]"
                        style={{
                          color: stageTone.color,
                          background: stageTone.background
                        }}
                      >
                        {taskStageLabel(job.status)}
                      </span>
                    </div>
                    {detailText ? (
                      <div
                        className="mt-1.5 truncate text-[11px]"
                        style={{
                          color: job.error ? 'var(--color-red)' : 'var(--text-light)'
                        }}
                        title={detailText}
                      >
                        {detailText}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-end gap-1.5 opacity-70 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      disabled={!canToggle}
                      onClick={() => {
                        if (isPaused) {
                          onResumeAnalysisJob(job.id)
                        } else if (isQueued) {
                          onPauseAnalysisJob(job.id)
                        }
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded-[8px] hover:bg-[var(--bg-hover)] disabled:opacity-35"
                      style={{
                        color: canToggle
                          ? isPaused
                            ? 'var(--color-orange)'
                            : 'var(--color-blue)'
                          : 'var(--text-light)'
                      }}
                      title={isPaused ? '继续任务' : isQueued ? '暂停任务' : '当前阶段不可切换'}
                    >
                      {isPaused ? (
                        <Pause className="h-[13px] w-[13px]" />
                      ) : (
                        <Play className="h-[13px] w-[13px]" />
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={!canDelete}
                      onClick={() => onDeleteAnalysisJob(job.id)}
                      className="flex h-6 w-6 items-center justify-center rounded-[8px] hover:bg-[var(--bg-hover)] disabled:opacity-35"
                      style={{
                        color: canDelete ? 'var(--color-red)' : 'var(--text-light)'
                      }}
                      title={canDelete ? '删除任务' : '运行中任务暂不可删除'}
                    >
                      <Trash2 className="h-[13px] w-[13px]" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  ) : null

  return (
    <div
      className="rss-feed-surface content-surface-panel rss-workbench-surface relative flex flex-col h-full"
      style={{
        padding: '0',
        background: 'transparent',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none'
      }}
    >
      {/* Header Bar */}
      <div
        className="rss-feed-toolbar flex items-center justify-between flex-shrink-0"
        style={{
          minHeight: 56,
          padding: `0 ${WORKBENCH_HEADER_EDGE_X}px 16px`,
          background: 'transparent',
          borderBottom: '1px solid var(--border-default)'
        }}
      >
        {/* Left: Title & Badge */}
        <div className="flex min-w-0 items-center" style={{ gap: 12 }}>
          <h2
            className="whitespace-nowrap"
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', lineHeight: 1 }}
          >
            RSS 订阅源
          </h2>
          {unreadCount > 0 && (
            <span
              className="shrink-0 rounded-full text-white"
              style={{
                background: 'var(--color-red)',
                fontSize: 12,
                fontWeight: 500,
                padding: '2px 8px',
                lineHeight: '16px'
              }}
            >
              {unreadCount} 新
            </span>
          )}
          {isMock && (
            <span className="px-2 py-0.5 rounded-full bg-[var(--color-orange-light)] text-[var(--color-orange)] text-[12px]">
              Mock 模式
            </span>
          )}
        </div>

        {/* Right: Action Controls */}
        <div className="rss-toolbar-actions flex items-center" style={{ gap: 8 }}>
          {/* Secondary dropdown: 全部源 */}
          <div className="relative">
            <select
              value={selectedSource || ''}
              onChange={(e) => onSourceChange(e.target.value || null)}
              className="rss-toolbar-select appearance-none cursor-pointer transition-colors duration-150"
              style={{
                ...calendarPillButtonStyle,
                padding: '4px 28px 4px 12px',
                width: sourceSelectWidth,
                minWidth: sourceSelectWidth,
                maxWidth: sourceSelectWidth,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              <option value="">全部源</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
            <ChevronDown
              style={{
                width: 14,
                height: 14,
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                color: 'var(--text-muted)'
              }}
              strokeWidth={2}
            />
          </div>

          {/* Secondary dropdown-style: 全部/未读/收藏 */}
          <div className="relative">
            <select
              value={filter}
              onChange={(e) => onFilterChange(e.target.value as 'all' | 'unread' | 'starred')}
              className="rss-toolbar-select appearance-none cursor-pointer transition-colors duration-150"
              style={{
                ...calendarPillButtonStyle,
                padding: '4px 28px 4px 12px',
                width: filterSelectWidth,
                minWidth: filterSelectWidth
              }}
            >
              <option value="all">全部</option>
              <option value="unread">未读</option>
              <option value="starred">收藏</option>
            </select>
            <ChevronDown
              style={{
                width: 14,
                height: 14,
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                color: 'var(--text-muted)'
              }}
              strokeWidth={2}
            />
          </div>

          <button
            type="button"
            onClick={onAddSource}
            className="rss-toolbar-icon-button"
            data-tooltip="添加源"
            aria-label="添加 RSS 源"
            title="添加 RSS 源"
          >
            <Plus className="h-[16px] w-[16px]" strokeWidth={2} />
          </button>

          {/* 任务下拉列表 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setTaskMenuOpen((prev) => !prev)}
              className="rss-toolbar-icon-button"
              data-tooltip={taskMenuOpen ? undefined : '任务'}
              aria-label={
                activeJobsCount > 0 ? `查看分析任务，${activeJobsCount} 个进行中` : '查看分析任务'
              }
              title={taskMenuOpen ? undefined : '查看分析任务'}
            >
              <ListTodo className="h-[16px] w-[16px]" strokeWidth={2} />
              {activeJobsCount > 0 ? <span className="rss-toolbar-active-dot" /> : null}
            </button>
            {taskMenuPanel}
          </div>

          {/* Secondary: 刷新 */}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="rss-toolbar-icon-button"
            data-tooltip={refreshLabel}
            aria-label={
              selectedSourceEntry ? `刷新当前源：${selectedSourceEntry.name}` : '刷新全部订阅源'
            }
            title={
              selectedSourceEntry ? `刷新当前源：${selectedSourceEntry.name}` : '刷新全部订阅源'
            }
          >
            <RefreshCw
              className={`h-[16px] w-[16px] ${refreshing ? 'animate-spin' : ''}`}
              strokeWidth={2}
            />
          </button>

          <button
            onClick={onClearRead}
            className="rss-toolbar-icon-button"
            data-tooltip="清空"
            aria-label="清空当前筛选范围中的全部内容"
            title="清空当前筛选范围中的全部内容"
          >
            <Trash2 className="h-[16px] w-[16px]" strokeWidth={2} />
          </button>

          <button
            type="button"
            onClick={() => {
              setTaskMenuOpen(false)
              onOpenSettings()
            }}
            className={`rss-toolbar-icon-button ${settingsOpen ? 'is-active' : ''}`}
            data-tooltip={settingsOpen ? undefined : '设置'}
            aria-label="打开 RSS 设置"
            aria-pressed={settingsOpen}
            title={settingsOpen ? undefined : '打开 RSS 设置'}
          >
            <Settings className="h-[16px] w-[16px]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Item List */}
      <div
        className="rss-feed-list rss-feed-scroll flex-1 overflow-auto"
        style={{ background: 'transparent' }}
      >
        <div className="flex flex-col gap-2 px-2 py-3">
          {shouldShowBootstrapSkeleton ? (
            Array.from({ length: 6 }).map((_, index) => (
              <div
                key={`rss-skeleton-${index}`}
                style={{
                  padding: `12px ${Math.max(WORKBENCH_HEADER_EDGE_X - 8, 12)}px`,
                  display: 'grid',
                  gap: 10,
                  opacity: 0.92,
                  borderRadius: 14,
                  background: 'color-mix(in srgb, var(--surface-card-bg) 8%, transparent)'
                }}
              >
                <div
                  style={{
                    width: `${72 + (index % 3) * 8}px`,
                    height: 10,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--surface-card-bg) 42%, transparent)'
                  }}
                />
                <div
                  style={{
                    width: `${58 + (index % 2) * 14}%`,
                    height: 14,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--surface-card-bg) 58%, transparent)'
                  }}
                />
                <div
                  style={{
                    width: `${82 + (index % 2) * 8}%`,
                    height: 11,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--surface-card-bg) 36%, transparent)'
                  }}
                />
                <div
                  style={{
                    width: `${65 + (index % 3) * 6}%`,
                    height: 11,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--surface-card-bg) 36%, transparent)'
                  }}
                />
              </div>
            ))
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-[var(--text-light)]">
              <Filter className="w-10 h-10 mb-3 opacity-50" />
              <p className="text-[13px]">暂无内容</p>
            </div>
          ) : (
            filteredItems.map((item) => {
              const isNew = newItemIds.has(item.id)
              const isSelected = selectedItemId === item.id
              const metaText = [
                item.source,
                item.author && item.author !== item.source ? item.author : null,
                item.publishedAt
              ]
                .filter(Boolean)
                .join('  ')
              return (
                <button
                  key={item.id}
                  onClick={() => onItemClick(item)}
                  className="w-full rounded-[14px] text-left transition-colors relative"
                  style={{
                    padding: `12px ${Math.max(WORKBENCH_HEADER_EDGE_X - 8, 12)}px`,
                    background: isSelected
                      ? 'color-mix(in srgb, var(--surface-card-bg) 16%, transparent)'
                      : 'color-mix(in srgb, var(--surface-card-bg) 5%, transparent)',
                    boxShadow: isSelected ? 'inset 2px 0 0 var(--color-blue)' : 'none'
                  }}
                >
                  <div className="rss-item-row">
                    <div className="rss-item-main flex items-start gap-2 min-w-0">
                      <div
                        draggable
                        onDragStart={(e) => {
                          setRssItemDragPayload(e, {
                            id: item.id,
                            title: item.title,
                            link: item.link,
                            summary: item.summary,
                            source: item.source,
                            publishedAt: item.publishedAt
                          })
                          e.stopPropagation()
                        }}
                        onDragEnd={() => {
                          endRssItemDragSession()
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-0.5 w-4 h-7 rounded cursor-grab active:cursor-grabbing hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center"
                        title="拖拽到文件管理文件夹"
                      >
                        <span
                          className="block h-4 w-[2px] rounded-full"
                          style={{ background: 'var(--text-light)', opacity: 0.55 }}
                        />
                      </div>

                      <div className="rss-item-text-stack flex-1 min-w-0">
                        <div
                          className="mb-1 grid items-center gap-2"
                          style={{
                            gridTemplateColumns: isNew ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)'
                          }}
                        >
                          <h3
                            className={`rss-item-line-fade text-[13px] ${
                              !item.read
                                ? 'font-semibold text-[var(--text-secondary)]'
                                : 'text-[var(--text-muted)]'
                            }`}
                            title={item.title}
                          >
                            {item.title}
                          </h3>
                          {isNew && (
                            <span
                              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-white text-[9px] flex-shrink-0"
                              style={{ background: 'var(--color-red)' }}
                            >
                              <Sparkles className="w-2.5 h-2.5" />新
                            </span>
                          )}
                        </div>
                        {item.summary ? (
                          <p
                            className="rss-item-line-fade mb-1.5 text-[12px] text-[var(--text-muted)]"
                            title={item.summary}
                          >
                            {item.summary}
                          </p>
                        ) : null}
                        <div
                          className="rss-item-line-fade text-[11px]"
                          style={{ color: 'var(--text-gray)' }}
                          title={metaText}
                        >
                          {metaText}
                        </div>
                      </div>
                    </div>

                    <div className="rss-item-actions flex items-center gap-1.5 justify-end">
                      {(() => {
                        const analysis = analysisProgressMap[item.id]
                        return (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onOpenAnalysisOutput(item.id)
                            }}
                            className="h-7 w-7 rounded-md hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center"
                            title={progressLabel(analysis)}
                          >
                            <AnalysisProgressRing entry={analysis} />
                          </button>
                        )
                      })()}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!item.read) onMarkItemRead(item.id)
                        }}
                        className="h-7 w-7 rounded-md hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center"
                        title={item.read ? '已读' : '标记为已读'}
                      >
                        <Check
                          className={`w-[16px] h-[16px] ${
                            item.read ? 'text-[var(--color-green)]' : 'text-[var(--text-muted)]'
                          }`}
                        />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleStar(item.id)
                        }}
                        className="h-7 w-7 rounded-md hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center"
                        title={item.starred ? '取消收藏' : '收藏'}
                      >
                        <Star
                          className={`w-[16px] h-[16px] ${
                            item.starred
                              ? 'text-[var(--color-gold)]'
                              : 'text-[var(--text-light)] opacity-60 hover:opacity-90'
                          }`}
                          fill={item.starred ? 'currentColor' : 'none'}
                        />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteItem(item.id)
                        }}
                        className="h-7 w-7 rounded-md hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center"
                        title="删除此条推送"
                      >
                        <X className="w-[16px] h-[16px] text-[var(--text-light)] opacity-80" />
                      </button>
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
