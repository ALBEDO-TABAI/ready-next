import RSSVirtualList from './RSSVirtualList'
import type { RSSDefinition, RSSMembership } from '../../../shared/rss-organization'
import type { RSSArticleSummary, RSSQueryInput, RSSQueryResult } from '../../../shared/rss-workspace'
import RSSGroupedReports from './RSSGroupedReports'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  Bookmark,
  Check,
  ChevronDown,
  CircleDashed,
  Inbox,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { WORKBENCH_HEADER_EDGE_X } from '../../modules/workbench/chrome'
import { endRssItemDragSession, setRssItemDragPayload } from '../layout/fileTreeExternalDrop'
import { compactAnalysisDetail } from '../../modules/rss/analysisLabels'
import { isRSSFeedItemContentEqual } from '../../modules/rss/rssFeedItemEquality'
import { rssQueryKey } from '../../modules/rss/workspace-query'
import Modal from '../ui/Modal'
import { useModal } from '../ui/useModal'
import { chatMenuSurfaceStyle } from '../agent/chatMenuStyles'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'
import RSSCoverImage from './RSSCoverImage'
import RSSTopbarTools from './RSSTopbarTools'
import RSSSearchField from './RSSSearchField'
import RSSWorkspaceHeading from './RSSWorkspaceHeading'
import RSSProcessingPanel from './RSSProcessingPanel'
import RSSHotEvents from './RSSHotEvents'

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

export interface RSSFeedNotice {
  message: string
  action?: { label: string; run(): void }
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
  view?: RSSQueryResult | null
  definitions?: RSSDefinition[]
  active?: boolean
  // Whether this list is the visible RSS view; only then does it place its tools in the top bar.
  toolsVisible?: boolean
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
  // Reference / export entries for the "more" menu; supplied by RSSMode so the list stays free of chat dependencies.
  renderMoreActions?: (close: () => void) => ReactNode
  settingsOpen: boolean
  nextPage?: boolean
  loadingMore?: boolean
  queryError?: string | null
  inbox?: boolean
  onLoadMore?: () => void
  onReloadQuery?: () => void
}

function progressStroke(status: AnalysisStatus | undefined): string {
  if (status === 'failed') return 'var(--color-red)'
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

// Status reads as text weight, not colored chips: only failure is tinted.
function taskStageTone(status: AnalysisStatus): string {
  if (status === 'failed') return 'var(--sx-danger-text)'
  if (status === 'success') return 'var(--text-secondary)'
  return 'var(--text-muted)'
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
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  const dash = circumference * (1 - value / 100)
  const status = entry?.status
  const running =
    status === 'queued' || status === 'running_script' || status === 'running_subagent'

  if (entry?.sourceWarning) return <TriangleAlert className="h-[13px] w-[13px]" style={{ color: 'var(--sx-warning)' }} />
  if (status === 'success') {
    return <Check className="h-[13px] w-[13px]" style={{ color: 'var(--text-secondary)' }} strokeWidth={2.4} />
  }

  return (
    <span className="relative flex h-[16px] w-[16px] items-center justify-center">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--sx-track-bg)" strokeWidth="1.8" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke={progressStroke(status)}
          strokeWidth="1.8"
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
          strokeDasharray={circumference}
          strokeDashoffset={dash}
          style={{ transition: 'stroke-dashoffset 240ms ease' }}
        />
      </svg>
      {running && <Loader2 className="absolute h-[8px] w-[8px] animate-spin" style={{ color: 'var(--color-blue)' }} />}
      {status === 'failed' && <TriangleAlert className="absolute h-[9px] w-[9px]" style={{ color: 'var(--color-red)' }} />}
      {status === 'paused' && <CircleDashed className="absolute h-[9px] w-[9px]" style={{ color: 'var(--text-muted)' }} />}
    </span>
  )
}

const WEEKDAYS = '日一二三四五六'

function itemTimestamp(entry: RSSItem): number | null {
  return entry.eventGroup?.displayTime ?? entry.publishedAtMs ?? entry.collectedAt ?? null
}

function dayKey(timestamp: number | null): string {
  return timestamp == null ? 'unknown' : new Date(timestamp).toDateString()
}

// 日期在前，“今天 / 昨天”与星期作补充，像报纸的日期栏。
function dayHeading(timestamp: number | null): { main: string; detail: string } {
  if (timestamp == null) return { main: '时间未提供', detail: '' }
  const date = new Date(timestamp)
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const offset = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`
  const weekday = `星期${WEEKDAYS[date.getDay()]}`
  return { main: day, detail: offset === 0 ? `今天 · ${weekday}` : offset === 1 ? `昨天 · ${weekday}` : weekday }
}

function cardTimeLabel(item: RSSItem): string {
  const format = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  if (item.publishedAtMs != null) return format(item.publishedAtMs)
  if (item.publishedAt) return item.publishedAt
  return item.collectedAt ? format(item.collectedAt) : ''
}

interface RSSFeedItemRowProps {
  item: RSSItem
  heading: { main: string; detail: string } | null
  isSelected: boolean
  analysis?: ItemAnalysisProgress
  query?: RSSQueryInput
  queryRevision?: number
  active: boolean
  // Comma-joined ids of curated definitions: their membership is the 精选 mark and its reason, not a tag.
  curatedIds: string
  // 精选 reads like an edition with a large preview; other columns scan faster with a thumbnail beside the text.
  media: 'preview' | 'thumb'
  onItemClick: (item: RSSItem) => void
  onMarkItemRead: (itemId: string) => void
  onToggleStar: (itemId: string) => void
  onDeleteItem: (itemId: string) => void
  onOpenAnalysisOutput: (itemId: string) => void
}

function areRSSFeedItemRowPropsEqual(previous: RSSFeedItemRowProps, next: RSSFeedItemRowProps): boolean {
  return previous.isSelected === next.isSelected
    && previous.active === next.active
    && previous.queryRevision === next.queryRevision
    && previous.query === next.query
    && previous.curatedIds === next.curatedIds
    && previous.media === next.media
    && previous.heading?.main === next.heading?.main
    && previous.heading?.detail === next.heading?.detail
    && previous.onItemClick === next.onItemClick
    && previous.onMarkItemRead === next.onMarkItemRead
    && previous.onToggleStar === next.onToggleStar
    && previous.onDeleteItem === next.onDeleteItem
    && previous.onOpenAnalysisOutput === next.onOpenAnalysisOutput
    && isRSSFeedItemContentEqual(previous.item, next.item, previous.analysis, next.analysis)
}

const RSSFeedItemRow = memo(function RSSFeedItemRow({
  item,
  heading,
  isSelected,
  analysis,
  query,
  queryRevision,
  active,
  curatedIds,
  media,
  onItemClick,
  onMarkItemRead,
  onToggleStar,
  onDeleteItem,
  onOpenAnalysisOutput,
}: RSSFeedItemRowProps) {
  const time = cardTimeLabel(item)
  const curated = new Set(curatedIds ? curatedIds.split(',') : [])
  const included = (item.classifications || []).filter((entry) => entry.included)
  const curation = included.find((entry) => curated.has(entry.definitionId))
  const topics = included.filter((entry) => !curated.has(entry.definitionId))
  const grouped = item.eventGroup && (item.eventGroup.memberCount > 1 || item.eventGroup.factCount > 1 || item.eventGroup.staleCount > 0) && query && queryRevision !== undefined
  return (
    <>
      {heading && <h2 className="rss-date-heading">{heading.main}{heading.detail ? <small>{heading.detail}</small> : null}</h2>}
      <div className={`rss-tl${item.read ? '' : ' is-unread'}`}>
        <time className="rss-tl__time">{time}</time>
        <i className="rss-tl__dot" aria-hidden />
        <article
          data-rss-item-id={item.id}
          className={`rss-news-card rss-item-row${isSelected ? ' is-selected' : ''}${item.read ? ' is-read' : ''}`}
          onClick={() => onItemClick(item)}
          draggable
          onDragStart={(event) => {
            setRssItemDragPayload(event, {
              id: item.id,
              title: item.title,
              link: item.link,
              summary: item.summary,
              source: item.source,
              publishedAt: item.publishedAt,
            })
            event.stopPropagation()
          }}
          onDragEnd={() => endRssItemDragSession()}
        >
          <div className="rss-card-meta">
            <span className="rss-card-monogram" aria-hidden>{(item.source || '·').trim().slice(0, 1)}</span>
            <span className="rss-card-source" title={item.source}>{item.source}</span>
            {item.author && item.author !== item.source ? <span title={item.author}>· {item.author}</span> : null}
            {curation && <span className="rss-card-curated" title={curation.reason}>精选</span>}
            <div className="rss-item-actions" onClick={(event) => event.stopPropagation()}>
              {analysis && (
                <button
                  type="button"
                  className="is-persistent"
                  onClick={() => onOpenAnalysisOutput(item.id)}
                  title={analysis.sourceWarning || progressLabel(analysis)}
                  data-rss-analysis-job-id={analysis.jobId}
                >
                  <AnalysisProgressRing entry={analysis} />
                </button>
              )}
              {!item.read && (
                <button type="button" onClick={() => onMarkItemRead(item.id)} title="标记为已读">
                  <Check className="h-[15px] w-[15px]" strokeWidth={2} />
                </button>
              )}
              {item.inboxVisible !== false && (
                <button
                  type="button"
                  onClick={() => onDeleteItem(item.id)}
                  title={item.starred ? '移出收件箱（收藏会继续显示）' : '移出收件箱'}
                >
                  <Archive className="h-[15px] w-[15px]" strokeWidth={1.9} />
                </button>
              )}
              <button
                type="button"
                className={`is-persistent${item.starred ? ' is-on' : ''}`}
                onClick={() => onToggleStar(item.id)}
                title={item.starred ? '取消收藏' : '收藏'}
              >
                <Bookmark className="h-[15px] w-[15px]" strokeWidth={1.9} fill={item.starred ? 'currentColor' : 'none'} />
              </button>
            </div>
          </div>
          <div className="rss-card-main">
            <div className="rss-card-text">
              <h3 className="rss-card-title"><button type="button" className="text-left">{item.title}</button></h3>
              {item.summary && item.summary.trim() !== item.title.trim() ? <p className="rss-card-summary">{item.summary}</p> : null}
            </div>
            {media === 'thumb' && <RSSCoverImage link={item.link} coverImage={item.coverImage} variant="thumb" />}
          </div>
          {media === 'preview' && <RSSCoverImage link={item.link} coverImage={item.coverImage} variant="preview" />}
          {topics.length > 0 && <div className="rss-classification-labels">
            {topics.map((entry) => <span key={entry.definitionId} title={entry.reason}>#{entry.name}{entry.stale ? ' · 需更新' : ''}</span>)}
          </div>}
          {curation?.reason && <p className="rss-card-reason">推荐理由：{curation.reason}</p>}
          {grouped && <RSSGroupedReports group={item.eventGroup!} query={query!} revision={queryRevision!} active={active} onSelect={onItemClick} />}
        </article>
      </div>
    </>
  )
}, areRSSFeedItemRowPropsEqual)

export default function RSSFeed({
  active = true,
  toolsVisible = false,
  view = null,
  definitions = [],
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
  renderMoreActions,
  settingsOpen, nextPage, loadingMore, queryError, inbox = true, onLoadMore, onReloadQuery, query, queryRevision,
}: RSSFeedProps) {
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  // A destructive source delete routes through a modal confirm (danger styled)
  // so an accidental click on the row's X can't drop a feed and its articles.
  const { modalProps, showConfirm } = useModal()
  const sourceMenuRef = useRef<HTMLDivElement>(null)
  const toolsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active || !toolsVisible) { setTaskMenuOpen(false); setSourceMenuOpen(false); setMoreMenuOpen(false) }
  }, [active, toolsVisible])

  useEffect(() => {
    if (!sourceMenuOpen && !moreMenuOpen && !taskMenuOpen) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (sourceMenuOpen && !sourceMenuRef.current?.contains(target)) setSourceMenuOpen(false)
      if ((moreMenuOpen || taskMenuOpen) && !toolsRef.current?.contains(target)) { setMoreMenuOpen(false); setTaskMenuOpen(false) }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sourceMenuOpen, moreMenuOpen, taskMenuOpen])

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
  const sourceLabel = selectedSourceEntry ? selectedSourceEntry.name : selectedSource ? '所选信源' : '全部源'
  const curatedIds = useMemo(() => definitions.filter((entry) => entry.kind === 'curated').map((entry) => entry.id).join(','), [definitions])
  // Like AIHOT's 精选 page, the curated collection opens with the multi-source events of the last two days.
  const onCuratedCollection = definitions.find((entry) => entry.id === query?.collectionId)?.kind === 'curated'
  const listHeader = onCuratedCollection && toolsVisible ? <RSSHotEvents active={active} onSelect={onItemClick} /> : null
  const shouldShowBootstrapSkeleton = loading && items.length === 0
  const closeMenus = () => { setMoreMenuOpen(false); setTaskMenuOpen(false) }

  const taskMenuPanel = taskMenuOpen ? (
    <LiquidFloatingPanel
      className="rss-task-menu-panel overflow-hidden rounded-[18px]"
      sourceSelector="[data-liquid-scroll-root='rss-feed-list']"
      radius={18}
      style={{
        ...chatMenuSurfaceStyle,
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: WORKBENCH_HEADER_EDGE_X,
        zIndex: 30,
        width: 384,
        maxWidth: `calc(100% - ${WORKBENCH_HEADER_EDGE_X * 2}px)`,
        padding: 0,
      }}
    >
      <div className="flex items-center justify-between" style={{ padding: '16px 14px 8px 20px' }}>
        <div className="min-w-0">
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)', lineHeight: 1.3 }}>分析任务</div>
          <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--text-light)', lineHeight: 1.3 }}>
            {analysisJobs.length} 条记录 · {activeJobsCount} 个进行中
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTaskMenuOpen(false)}
          className="rss-btn rss-btn--icon"
          title="关闭"
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>
      {analysisJobs.length === 0 ? (
        <div className="px-4 pb-10 pt-6 text-center text-[12px]" style={{ color: 'var(--text-light)' }}>
          暂无任务记录
        </div>
      ) : (
        <div
          className="rss-feed-scroll"
          style={{ display: 'grid', gap: 2, maxHeight: 360, overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 8px 12px' }}
        >
          {analysisJobs.map((job) => {
            const isQueued = job.status === 'queued'
            const isPaused = job.status === 'paused'
            const isRunning = job.status === 'running_script' || job.status === 'running_subagent'
            const canDelete = !isRunning
            const canToggle = isQueued || isPaused
            const detailText = taskDetailText(job)
            const roundedProgress = Math.max(0, Math.min(100, Math.round(job.progress || 0)))
            return (
              <div key={job.id} className="rss-task-menu-row group rounded-[12px] transition-colors hover:bg-[var(--sx-raised-hover)]" style={{ padding: '10px 12px' }}>
                <div className="grid items-center" style={{ columnGap: 12, gridTemplateColumns: '18px minmax(0, 1fr) 60px' }}>
                  <div className="flex h-6 items-center justify-center">
                    <AnalysisProgressRing entry={{ progress: roundedProgress, status: job.status, sourceWarning: job.sourceWarning }} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] font-medium" style={{ color: 'var(--text-title)', lineHeight: 1.4 }} title={job.title}>
                      {job.title}
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-light)' }}>
                      <span className="shrink-0">{taskTypeLabel(job.action)}</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{roundedProgress}%</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0" style={{ color: taskStageTone(job.status) }}>
                        {job.sourceWarning ? '完成 · 有范围提示' : taskStageLabel(job.status)}
                      </span>
                    </div>
                    {detailText ? (
                      <div className="mt-1 truncate text-[11.5px]" style={{ color: job.error ? 'var(--sx-danger-text)' : 'var(--text-light)' }} title={detailText}>
                        {detailText}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      disabled={!canToggle}
                      onClick={() => {
                        if (isPaused) onResumeAnalysisJob(job.id)
                        else if (isQueued) onPauseAnalysisJob(job.id)
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded-[8px] hover:bg-[var(--sx-hover)] disabled:opacity-35"
                      style={{ color: canToggle ? 'var(--text-secondary)' : 'var(--text-light)' }}
                      title={isPaused ? '继续任务' : isQueued ? '暂停任务' : '当前阶段不可切换'}
                    >
                      {isPaused ? <Play className="h-[13px] w-[13px]" /> : <Pause className="h-[13px] w-[13px]" />}
                    </button>
                    <button
                      type="button"
                      disabled={!canDelete}
                      onClick={() => onDeleteAnalysisJob(job.id)}
                      className="flex h-6 w-6 items-center justify-center rounded-[8px] hover:bg-[var(--sx-hover)] hover:text-[var(--sx-danger-text)] disabled:opacity-35"
                      style={{ color: 'var(--text-light)' }}
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

  const moreMenuPanel = moreMenuOpen ? (
    <LiquidFloatingPanel
      className="rss-more-menu-panel overflow-hidden rounded-[14px]"
      sourceSelector="[data-liquid-scroll-root='rss-feed-list']"
      role="menu"
      radius={14}
      style={{
        ...chatMenuSurfaceStyle,
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: WORKBENCH_HEADER_EDGE_X,
        zIndex: 30,
        width: 232,
        maxWidth: `calc(100% - ${WORKBENCH_HEADER_EDGE_X * 2}px)`,
      }}
    >
      <div className="rss-menu">
        {renderMoreActions?.(closeMenus)}
        <div className="rss-menu-gap" />
        <button
          type="button"
          className="rss-menu-item ready-floating-menu-item"
          disabled={!inbox}
          aria-label="清空当前筛选范围中的全部内容"
          title="把当前筛选范围移出收件箱；收藏与历史底稿保留"
          onClick={() => { closeMenus(); onClearRead() }}
        >
          <Archive size={15} strokeWidth={1.8} />清空当前范围
        </button>
        <button
          type="button"
          className="rss-menu-item ready-floating-menu-item"
          aria-label="打开 RSS 设置"
          onClick={() => { closeMenus(); onOpenSettings() }}
        >
          <Settings size={15} strokeWidth={1.8} />订阅与刷新设置
        </button>
      </div>
    </LiquidFloatingPanel>
  ) : null

  return (
    <div
      className="rss-feed-surface content-surface-panel rss-workbench-surface relative flex flex-col flex-1 min-h-0"
      style={{ padding: 0, background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
    >
      <RSSTopbarTools show={toolsVisible}>
        <div ref={toolsRef} className="rss-toolbar-actions flex items-center" style={{ gap: 2 }}>
          <RSSSearchField />
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rss-toolbar-icon-button"
            data-tooltip={refreshLabel}
            aria-label={selectedSource ? `刷新当前源：${selectedSourceEntry?.name || '所选订阅源'}` : '刷新全部订阅源'}
          >
            <RefreshCw className={`h-[15px] w-[15px] ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={onAddSource}
            className="rss-toolbar-icon-button"
            data-tooltip="添加源"
            aria-label="添加 RSS 源"
          >
            <Plus className="h-[16px] w-[16px]" strokeWidth={1.9} />
          </button>
          {analysisJobs.length > 0 && (
            <button
              type="button"
              onClick={() => { setMoreMenuOpen(false); setTaskMenuOpen((open) => !open) }}
              className="rss-toolbar-icon-button"
              data-tooltip={taskMenuOpen ? undefined : '任务'}
              aria-expanded={taskMenuOpen}
              aria-label={activeJobsCount > 0 ? `查看分析任务，${activeJobsCount} 个进行中` : '查看分析任务'}
            >
              <ListTodo className="h-[15px] w-[15px]" strokeWidth={1.9} />
              {activeJobsCount > 0 ? <span className="rss-toolbar-active-dot" /> : null}
            </button>
          )}
          <button
            type="button"
            onClick={() => { setTaskMenuOpen(false); setMoreMenuOpen((open) => !open) }}
            className={`rss-toolbar-icon-button ${settingsOpen ? 'is-active' : ''}`}
            data-tooltip={moreMenuOpen ? undefined : '更多'}
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            aria-label="更多操作"
          >
            <MoreHorizontal className="h-[16px] w-[16px]" strokeWidth={1.9} />
          </button>
          {taskMenuPanel}
          {moreMenuPanel}
        </div>
      </RSSTopbarTools>

      <RSSWorkspaceHeading
        view={view}
        loading={loading}
        definitions={definitions}
        status={toolsVisible ? <RSSProcessingPanel active={active} /> : null}
        filtersAside={(
          <div ref={sourceMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setSourceMenuOpen((open) => !open)}
              className="rss-quiet-select"
              title={sourceLabel}
              aria-haspopup="listbox"
              aria-expanded={sourceMenuOpen}
            >
              <span>{sourceLabel}</span>
              <ChevronDown className="h-[13px] w-[13px]" strokeWidth={2} />
            </button>
            {sourceMenuOpen && (
              <LiquidFloatingPanel
                className="rss-source-menu-panel overflow-hidden rounded-[12px]"
                sourceSelector="[data-liquid-scroll-root='rss-feed-list']"
                role="listbox"
                radius={14}
                style={{ ...chatMenuSurfaceStyle, position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 30, width: 280, maxWidth: 'calc(100cqw - 32px)' }}
              >
                <div className="rss-feed-scroll" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 1, maxHeight: 320, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={!selectedSource}
                    onClick={() => { onSourceChange(null); setSourceMenuOpen(false) }}
                    className={`ready-floating-menu-item rss-menu-item ${!selectedSource ? 'is-selected' : ''}`}
                  >
                    <Check className="h-[13px] w-[13px] shrink-0" style={{ color: 'var(--color-blue)', opacity: selectedSource ? 0 : 1 }} strokeWidth={2.5} />
                    <span style={{ flex: 1, minWidth: 0 }}>全部源</span>
                  </button>
                  {sources.map((source) => {
                    const isSelected = source.id === selectedSource
                    return (
                      <div
                        key={source.id}
                        className={`ready-floating-menu-item flex min-w-0 items-center gap-1 rounded-[9px] ${isSelected ? 'is-selected' : ''}`}
                        style={{ padding: '0 4px 0 10px' }}
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => { onSourceChange(source.id); setSourceMenuOpen(false) }}
                          className="flex min-w-0 flex-1 items-center gap-2.5"
                          style={{ padding: '8px 0', textAlign: 'left' }}
                          title={source.name}
                        >
                          <Check className="h-[13px] w-[13px] shrink-0" style={{ color: 'var(--color-blue)', opacity: isSelected ? 1 : 0 }} strokeWidth={2.5} />
                          <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, color: 'var(--text-body)' }}>{source.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={async (event) => {
                            event.stopPropagation()
                            setSourceMenuOpen(false)
                            const confirmed = await showConfirm(
                              `删除订阅源「${source.name}」后，其下文章会一并移除，且无法恢复。确定删除吗？`,
                              '删除订阅源',
                            )
                            if (confirmed) onDeleteSource(source.id)
                          }}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--sx-hover)] hover:text-[var(--sx-danger-text)]"
                          style={{ color: 'var(--text-light)' }}
                          title="删除该源"
                          aria-label={`删除 ${source.name}`}
                        >
                          <X className="h-[12px] w-[12px]" strokeWidth={2.4} />
                        </button>
                      </div>
                    )
                  })}
                  {sources.length === 0 && (
                    <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-light)' }}>暂无订阅源</div>
                  )}
                </div>
              </LiquidFloatingPanel>
            )}
          </div>
        )}
      />

      <div className="rss-feed-list" data-rss-loaded-count={items.length}>
        {queryError && <div className="rss-query-error" role="alert">{queryError}<button type="button" onClick={onReloadQuery}>重新读取</button></div>}
        {shouldShowBootstrapSkeleton ? (
          <div style={{ padding: '0 var(--rss-row-x)' }}>
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={`rss-skeleton-${index}`} className="rss-skeleton" aria-hidden>
                <span style={{ width: `${64 + (index % 3) * 10}px` }} />
                <span style={{ width: `${54 + (index % 2) * 16}%`, height: 14 }} />
                <span style={{ width: `${78 + (index % 2) * 10}%` }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="rss-empty">
            <Inbox size={26} strokeWidth={1.5} />
            <p>{queryError ? '当前范围暂时无法读取' : '这里还没有资讯'}</p>
          </div>
        ) : (
          <RSSVirtualList key={query ? rssQueryKey(query) : 'rss-feed'} items={items} selectedItemId={selectedItemId} header={listHeader}>{(item, index) => {
            const date = dayKey(itemTimestamp(item))
            const heading = index === 0 || dayKey(itemTimestamp(items[index - 1])) !== date ? dayHeading(itemTimestamp(item)) : null
            return (
              <RSSFeedItemRow
                item={item}
                heading={heading}
                isSelected={selectedItemId === item.id}
                analysis={analysisProgressMap[item.id]}
                query={query}
                queryRevision={queryRevision}
                active={active}
                curatedIds={curatedIds}
                media={onCuratedCollection ? 'preview' : 'thumb'}
                onItemClick={onItemClick}
                onMarkItemRead={onMarkItemRead}
                onToggleStar={onToggleStar}
                onDeleteItem={onDeleteItem}
                onOpenAnalysisOutput={onOpenAnalysisOutput}
              />
            )
          }}</RSSVirtualList>
        )}
        {nextPage && <button type="button" className="rss-load-more" disabled={loading || loadingMore} onClick={onLoadMore}>{loadingMore ? '正在读取…' : '加载更多'}</button>}
      </div>
      <Modal {...modalProps} danger confirmLabel="删除" />
    </div>
  )
}
