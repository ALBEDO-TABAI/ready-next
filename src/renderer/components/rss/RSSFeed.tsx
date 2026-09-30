import type { RSSMembership } from '../../../shared/rss-organization'
import type { RSSArticleSummary, RSSQueryInput } from '../../../shared/rss-workspace'
import RSSGroupedReports from './RSSGroupedReports'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Filter,
  Star,
  Plus,
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
import { compactAnalysisDetail } from '../../modules/rss/analysisLabels'
import Modal from '../ui/Modal'
import { useModal } from '../ui/useModal'
import { chatMenuSurfaceStyle } from '../agent/chatMenuStyles'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'
import RSSCoverImage from './RSSCoverImage'

export interface RSSItem {
  event?: RSSArticleSummary['event']
  eventGroup?: RSSArticleSummary['eventGroup']
  classifications?: RSSMembership[]
  id: string
  reveal?: { id: string; range: import('../../../shared/rss-reading').RSSReadingRange }
  pinnedRevision?: string
  revision?: string
  sourceRevision?: string
  title: string
  source: string
  author: string
  sourceId: string
  summary: string
  publishedAt: string
  publishedAtMs?: number | null
  collectedAt?: number
  inboxVisible?: boolean
  read: boolean
  starred: boolean
  coverImage?: string
  link: string
}

export interface RSSSource {
  id: string
  name: string
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
  sourceWarning?: string | null
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
  sourceWarning?: string | null
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
  query?: RSSQueryInput
  queryRevision?: number
  active?: boolean
  items: RSSItem[]
  sources: RSSSource[]
  selectedSource: string | null
  selectedItemId: string | null
  loading: boolean
  refreshing: boolean
  analysisProgressMap: Record<string, ItemAnalysisProgress>
  analysisJobs: AnalysisJobItem[]
  onSourceChange: (sourceId: string | null) => void
  onItemClick: (item: RSSItem) => void
  onMarkItemRead: (itemId: string) => void
  onToggleStar: (itemId: string) => void
  onDeleteItem: (itemId: string) => void
  onOpenAnalysisOutput: (itemId: string) => void
  onRefresh: () => void
  onAddSource: () => void
  onDeleteSource: (sourceId: string) => void
  onClearRead: () => void
  onOpenSettings: () => void
  onPauseAnalysisJob: (jobId: string) => void
  onResumeAnalysisJob: (jobId: string) => void
  onDeleteAnalysisJob: (jobId: string) => void
  settingsOpen: boolean
  nextPage?: boolean
  loadingMore?: boolean
  queryError?: string | null
  inbox?: boolean
  onLoadMore?: () => void
  onReloadQuery?: () => void
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
  const detail = compactAnalysisDetail(entry.error || entry.message)
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
  if (job.sourceWarning) return job.sourceWarning
  if (job.error) return compactAnalysisDetail(job.error)

  const message = (job.message || '').trim()
  if (!message || job.status === 'success') return ''
  if (job.progress >= 100 && /完成|已完成/.test(message)) return ''
  if (message === taskStageLabel(job.status)) return ''

  return compactAnalysisDetail(message)
}

function AnalysisProgressRing({
  entry
}: {
  entry?: Pick<ItemAnalysisProgress, 'progress' | 'status' | 'sourceWarning'>
}) {
  const value = Math.max(0, Math.min(100, entry?.progress ?? 0))
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dash = circumference * (1 - value / 100)
  const status = entry?.status
  const running =
    status === 'queued' || status === 'running_script' || status === 'running_subagent'

  if (entry?.sourceWarning) return <TriangleAlert className="h-[13px] w-[13px] text-[var(--color-orange)]" />
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
  active = true,
  items,
  sources,
  selectedSource,
  selectedItemId,
  loading,
  refreshing,
  analysisProgressMap,
  analysisJobs,
  onSourceChange,
  onItemClick,
  onMarkItemRead,
  onToggleStar,
  onDeleteItem,
  onOpenAnalysisOutput,
  onRefresh,
  onAddSource,
  onDeleteSource,
  onClearRead,
  onOpenSettings,
  onPauseAnalysisJob,
  onResumeAnalysisJob,
  onDeleteAnalysisJob,
  settingsOpen, nextPage, loadingMore, queryError, inbox = true, onLoadMore, onReloadQuery, query, queryRevision,
}: RSSFeedProps) {
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  // A destructive source delete routes through a modal confirm (danger styled)
  // so an accidental click on the row's X can't drop a feed and its articles.
  const { modalProps, showConfirm } = useModal()
  const sourceMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) { setTaskMenuOpen(false); setSourceMenuOpen(false) }
  }, [active])

  useEffect(() => {
    if (!sourceMenuOpen) return
    const handler = (event: MouseEvent) => {
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(event.target as Node)) {
        setSourceMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sourceMenuOpen])

  const isRefreshing = loading || refreshing
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
  const calendarPillButtonStyle = {
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid transparent',
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
  const shouldShowBootstrapSkeleton = loading && items.length === 0
  const taskMenuPanel = taskMenuOpen ? (
    <LiquidFloatingPanel
      className="rss-task-menu-panel overflow-hidden rounded-[18px]"
      sourceSelector="[data-liquid-scroll-root='rss-feed-list']"
      radius={18}
      style={{
        ...chatMenuSurfaceStyle,
        position: 'absolute',
        top: 'calc(100% + 10px)',
        right: 0,
        zIndex: 30,
        width: 384,
        maxWidth: 'min(384px, calc(100vw - 48px))',
        padding: 0,
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
          className="flex h-7 w-7 items-center justify-center rounded-[8px] hover:bg-[var(--bg-hover)]"
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
                className="rss-task-menu-row group rounded-[16px] transition-colors hover:bg-[var(--bg-hover)]"
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
                        {job.sourceWarning ? '完成 · 有范围提示' : taskStageLabel(job.status)}
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
    </LiquidFloatingPanel>
  ) : null

  return (
    <div
      className="rss-feed-surface content-surface-panel rss-workbench-surface relative flex flex-col flex-1 min-h-0"
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
          padding: `10px ${WORKBENCH_HEADER_EDGE_X}px`,
          background: 'transparent',
          borderBottom: '1px solid var(--border-default)'
        }}
      >
        {/* Right: Action Controls */}
        <div className="rss-toolbar-actions flex items-center" style={{ gap: 8, flexWrap: 'wrap', width: '100%' }}>
          {/* Secondary dropdown: 全部源. Custom menu (not a native <select>)
              so each source row can carry an inline delete control — native
              <option> can't host a button. */}
          <div className="relative" ref={sourceMenuRef}>
            <button
              type="button"
              onClick={() => setSourceMenuOpen((prev) => !prev)}
              className="rss-toolbar-select appearance-none cursor-pointer transition-colors duration-150"
              style={{
                ...calendarPillButtonStyle,
                justifyContent: 'flex-start',
                padding: '4px 28px 4px 12px',
                width: sourceSelectWidth,
                minWidth: sourceSelectWidth,
                maxWidth: sourceSelectWidth,
                whiteSpace: 'nowrap',
                overflow: 'hidden'
              }}
              title={selectedSourceEntry ? selectedSourceEntry.name : selectedSource ? '所选信源' : '全部源'}
              aria-haspopup="listbox"
              aria-expanded={sourceMenuOpen}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedSourceEntry ? selectedSourceEntry.name : selectedSource ? '所选信源' : '全部源'}
              </span>
            </button>
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
            {sourceMenuOpen && (
              <LiquidFloatingPanel
                className="rss-source-menu-panel overflow-hidden rounded-[12px]"
                sourceSelector="[data-liquid-scroll-root='rss-feed-list']"
                role="listbox"
                radius={14}
                style={{
                  ...chatMenuSurfaceStyle,
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  right: 0,
                  zIndex: 30,
                  width: 300,
                  maxWidth: 'calc(100vw - 48px)',
                }}
              >
                <div
                  className="rss-feed-scroll"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr)',
                    gap: 2,
                    maxHeight: 320,
                    overflowY: 'auto',
                    overscrollBehavior: 'contain',
                    padding: 0
                  }}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={!selectedSource}
                    onClick={() => { onSourceChange(null); setSourceMenuOpen(false) }}
                    className={`ready-floating-menu-item flex items-center gap-2 rounded-[8px] transition-colors hover:bg-[var(--bg-hover)] ${!selectedSource ? 'is-selected' : ''}`}
                    style={{ padding: '7px 10px', textAlign: 'left' }}
                  >
                    <Check
                      className="h-[13px] w-[13px] shrink-0"
                      style={{ color: 'var(--color-blue)', opacity: selectedSource ? 0 : 1 }}
                      strokeWidth={2.5}
                    />
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>
                      全部源
                    </span>
                  </button>
                  {sources.map((source) => {
                    const isSelected = source.id === selectedSource
                    return (
                      <div
                        key={source.id}
                        className={`ready-floating-menu-item flex min-w-0 items-center gap-1 rounded-[8px] transition-colors hover:bg-[var(--bg-hover)] ${isSelected ? 'is-selected' : ''}`}
                        style={{ padding: '0 4px 0 10px' }}
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => { onSourceChange(source.id); setSourceMenuOpen(false) }}
                          className="flex min-w-0 flex-1 items-center gap-2"
                          style={{ padding: '7px 0', textAlign: 'left' }}
                          title={source.name}
                        >
                          <Check
                            className="h-[13px] w-[13px] shrink-0"
                            style={{ color: 'var(--color-blue)', opacity: isSelected ? 1 : 0 }}
                            strokeWidth={2.5}
                          />
                          <span
                            className="min-w-0 flex-1"
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              color: 'var(--text-body)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {source.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation()
                            setSourceMenuOpen(false)
                            const confirmed = await showConfirm(
                              `删除订阅源「${source.name}」后，其下文章会一并移除，且无法恢复。确定删除吗？`,
                              '删除订阅源',
                            )
                            if (confirmed) onDeleteSource(source.id)
                          }}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ color: 'var(--text-muted)' }}
                          title="删除该源"
                          aria-label={`删除 ${source.name}`}
                        >
                          <X className="h-[13px] w-[13px]" strokeWidth={2.5} />
                        </button>
                      </div>
                    )
                  })}
                  {sources.length === 0 && (
                    <div className="px-3 py-6 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      暂无订阅源
                    </div>
                  )}
                </div>
              </LiquidFloatingPanel>
            )}
          </div>

          <button
            type="button"
            onClick={onAddSource}
            className="rss-toolbar-icon-button"
            data-tooltip="添加源"
            aria-label="添加 RSS 源"
            title="添加 RSS 源"
          >
            <Plus className="h-[14px] w-[14px]" strokeWidth={2} />
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
              <ListTodo className="h-[14px] w-[14px]" strokeWidth={2} />
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
              selectedSource ? `刷新当前源：${selectedSourceEntry?.name || '所选订阅源'}` : '刷新全部订阅源'
            }
            title={
              selectedSource ? `刷新当前源：${selectedSourceEntry?.name || '所选订阅源'}` : '刷新全部订阅源'
            }
          >
            <RefreshCw
              className={`h-[14px] w-[14px] ${refreshing ? 'animate-spin' : ''}`}
              strokeWidth={2}
            />
          </button>

          <button
            onClick={onClearRead}
            disabled={!inbox}
            className="rss-toolbar-icon-button"
            data-tooltip="清空"
            aria-label="清空当前筛选范围中的全部内容"
            title="清空当前筛选范围中的全部内容"
          >
            <Trash2 className="h-[14px] w-[14px]" strokeWidth={2} />
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
            <Settings className="h-[14px] w-[14px]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Item List */}
      <div
        data-liquid-scroll-root="rss-feed-list"
        className="rss-feed-list rss-feed-scroll flex-1 overflow-auto"
        style={{ background: 'transparent' }}
      >
        <div className="flex flex-col gap-2 px-2 py-3">
          {queryError && <div className="rss-query-error" role="alert">{queryError}<button type="button" onClick={onReloadQuery}>重新读取</button></div>}
          {shouldShowBootstrapSkeleton ? (
            Array.from({ length: 6 }).map((_, index) => (
              <div
                key={`rss-skeleton-${index}`}
                style={{
                  padding: `12px ${Math.max(WORKBENCH_HEADER_EDGE_X - 8, 12)}px`,
                  display: 'grid',
                  gap: 10,
                  opacity: 0.92,
                  borderRadius: 12,
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
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-[var(--text-light)]">
              <Filter className="w-10 h-10 mb-3 opacity-50" />
              <p className="text-[13px]">{queryError ? '当前范围暂时无法读取' : '暂无内容'}</p>
            </div>
          ) : (
            items.map((item, index) => {
              const isSelected = selectedItemId === item.id
              const metaText = [
                item.source,
                item.author && item.author !== item.source ? item.author : null,
                item.publishedAt || (item.collectedAt ? `收录于 ${new Date(item.collectedAt).toLocaleString()}` : '')
              ]
                .filter(Boolean)
                .join('  ')
              const dateLabel = (entry: RSSItem) => {
                const timestamp = entry.eventGroup?.displayTime ?? entry.publishedAtMs ?? entry.collectedAt
                return timestamp == null ? '时间未提供' : new Date(timestamp).toLocaleDateString()
              }
              const date = dateLabel(item)
              return (
                <Fragment key={item.eventGroup ? `event:${item.eventGroup.id}` : `article:${item.id}`}>
                {(index === 0 || dateLabel(items[index - 1]) !== date) && <h2 className="rss-date-heading">{date}</h2>}
                <article data-rss-item-id={item.id}
                  onClick={() => onItemClick(item)}
                  className="rss-news-card w-full rounded-[12px] text-left transition-colors relative"
                  style={{
                    padding: `12px ${Math.max(WORKBENCH_HEADER_EDGE_X - 8, 12)}px`,
                    background: isSelected
                      ? 'color-mix(in srgb, var(--surface-card-bg) 16%, transparent)'
                      : 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)',
                    border: '1px solid var(--border-default)',
                    boxShadow: isSelected ? 'inset 2px 0 0 var(--color-blue)' : 'none'
                  }}
                >
                  {item.eventGroup && (item.eventGroup.memberCount > 1 || item.eventGroup.factCount > 1 || item.eventGroup.staleCount > 0) && query && queryRevision !== undefined && <RSSGroupedReports group={item.eventGroup} query={query} revision={queryRevision} active={active} onSelect={onItemClick} />}
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
                            gridTemplateColumns: 'minmax(0, 1fr)'
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
                            <button type="button" className="text-left">{item.title}</button>
                          </h3>

                        </div>
                        {(item.classifications || []).some((entry) => entry.included) && <div className="rss-classification-labels">
                          {(item.classifications || []).filter((entry) => entry.included).map((entry) => <span key={entry.definitionId} title={entry.reason}>{entry.name}{entry.stale ? ' · 需更新' : ''}</span>)}
                        </div>}
                        {item.summary ? (
                          <p
                            className="rss-item-line-fade mb-1.5 text-[12px] text-[var(--text-muted)]"
                            title={item.summary}
                          >
                            {item.summary}
                          </p>
                        ) : null}
                        <RSSCoverImage link={item.link} coverImage={item.coverImage} compact />
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
                            title={analysis?.sourceWarning || progressLabel(analysis)}
                            data-rss-analysis-job-id={analysis?.jobId}
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
                      {item.inboxVisible !== false && <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteItem(item.id)
                        }}
                        className="h-7 w-7 rounded-md hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center"
                        title={item.starred ? "移出收件箱（收藏会继续显示）" : "移出收件箱"}
                      >
                        <X className="w-[16px] h-[16px] text-[var(--text-light)] opacity-80" />
                      </button>}
                    </div>
                  </div>
                </article>
                </Fragment>
              )
            })
          )}
          {nextPage && <button type="button" className="rss-load-more" disabled={loading || loadingMore} onClick={onLoadMore}>{loadingMore ? '正在读取…' : '加载更多'}</button>}
        </div>
      </div>
      <Modal {...modalProps} danger confirmLabel="删除" />
    </div>
  )
}
