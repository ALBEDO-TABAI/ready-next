import RSSVirtualList from './RSSVirtualList'
import type { RSSDefinition, RSSMembership } from '../../../shared/rss-organization'
import type { RSSArticleSummary, RSSQueryInput, RSSQueryResult } from '../../../shared/rss-workspace'
import RSSGroupedReports from './RSSGroupedReports'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
import { FloatPanel } from '../ui/float/FloatPanel'
import { Button, IconButton } from '../ui/Button'
import { EmptyState, Skeleton } from '../ui/Display'
import { anchorOf, openFloat } from '../ui/float/float-store'
import { openMenu } from '../ui/float/open-menu'
import { confirmDialog } from '../ui/float/Dialog'
import type { MenuEntry } from '../ui/float/Menu'
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
  moreMenuEntries?: () => MenuEntry[]
  settingsOpen: boolean
  nextPage?: boolean
  loadingMore?: boolean
  queryError?: string | null
  inbox?: boolean
  onLoadMore?: () => void
  onReloadQuery?: () => void
}

function progressStroke(status: AnalysisStatus | undefined): string {
  if (status === 'failed') return 'var(--rn-bad)'
  if (status === 'running_script' || status === 'running_subagent' || status === 'queued') {
    return 'var(--rn-accent)'
  }
  return 'var(--rn-ink-3)'
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
  if (status === 'failed') return 'var(--rn-bad)'
  return 'var(--rn-ink-2)'
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

  if (entry?.sourceWarning) return <TriangleAlert className="h-[13px] w-[13px]" style={{ color: 'var(--rn-warn)' }} />
  if (status === 'success') {
    return <Check className="h-[13px] w-[13px]" style={{ color: 'var(--rn-ink-2)' }} strokeWidth={2.4} />
  }

  return (
    <span className="rss-ring relative flex h-[16px] w-[16px] items-center justify-center">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--rn-fill-3)" strokeWidth="1.8" />
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
      {running && <Loader2 className="absolute h-[8px] w-[8px] animate-spin" style={{ color: 'var(--rn-accent)' }} />}
      {status === 'failed' && <TriangleAlert className="absolute h-[9px] w-[9px]" style={{ color: 'var(--rn-bad)' }} />}
      {status === 'paused' && <CircleDashed className="absolute h-[9px] w-[9px]" style={{ color: 'var(--rn-ink-2)' }} />}
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
                <IconButton
                  size="sm"
                  className="is-persistent"
                  icon={<AnalysisProgressRing entry={analysis} />}
                  onClick={() => onOpenAnalysisOutput(item.id)}
                  title={analysis.sourceWarning || progressLabel(analysis)}
                  data-rss-analysis-job-id={analysis.jobId}
                />
              )}
              {!item.read && <IconButton size="sm" icon={<Check strokeWidth={2} />} onClick={() => onMarkItemRead(item.id)} title="标记为已读" />}
              {item.inboxVisible !== false && (
                <IconButton size="sm" icon={<Archive />} onClick={() => onDeleteItem(item.id)}
                  title={item.starred ? '移出收件箱（收藏会继续显示）' : '移出收件箱'} />
              )}
              <IconButton
                size="sm"
                className="is-persistent"
                active={item.starred}
                icon={<Bookmark fill={item.starred ? 'currentColor' : 'none'} />}
                onClick={() => onToggleStar(item.id)}
                title={item.starred ? '取消收藏' : '收藏'}
              />
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
  moreMenuEntries,
  settingsOpen, nextPage, loadingMore, queryError, inbox = true, onLoadMore, onReloadQuery, query, queryRevision,
}: RSSFeedProps) {
  // The analysis task list follows live job progress, so it stays a panel placed in the top bar (the shared FloatPanel);
  // the more and source menus are floats of the one float host (W1 §5).
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active || !toolsVisible) setTaskMenuOpen(false)
  }, [active, toolsVisible])

  useEffect(() => {
    if (!taskMenuOpen) return
    const handler = (event: MouseEvent) => { if (!toolsRef.current?.contains(event.target as Node)) setTaskMenuOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [taskMenuOpen])

  const isRefreshing = loading || refreshing
  const selectedSourceEntry = useMemo(
    () => sources.find((source) => source.id === selectedSource) ?? null,
    [selectedSource, sources]
  )
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
  const openMoreMenu = (anchor: HTMLElement) => {
    setTaskMenuOpen(false)
    openMenu(anchorOf(anchor), [
      ...(moreMenuEntries?.() ?? []),
      { kind: 'separator' },
      { id: 'clear', label: '清空当前范围', icon: <Archive />, disabled: !inbox, onSelect: onClearRead },
      { id: 'settings', label: '订阅与刷新设置', icon: <Settings />, onSelect: onOpenSettings },
    ], { placement: 'bottom-end', label: '更多操作' })
  }
  // A destructive source delete asks first (danger styled), so a stray click on a row's ✕ cannot drop a feed and its articles.
  const deleteSource = async (source: RSSSource) => {
    const confirmed = await confirmDialog({ title: '删除订阅源', body: `删除订阅源「${source.name}」后，其下文章会一并移除，且无法恢复。确定删除吗？`, confirmLabel: '删除', danger: true })
    if (confirmed) onDeleteSource(source.id)
  }
  const openSourceMenu = (anchor: HTMLElement) => openFloat({
    anchor: anchorOf(anchor), placement: 'bottom-end', offset: 8, role: 'listbox', label: '订阅源', className: 'rss-source-menu-panel',
    render: close => <SourcePicker sources={sources} selected={selectedSource}
      onChoose={(id) => { close(); onSourceChange(id) }} onDelete={(source) => { close(); void deleteSource(source) }} />,
  })

  const taskMenuPanel = taskMenuOpen ? (
    <FloatPanel
      className="rss-task-menu-panel"
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: WORKBENCH_HEADER_EDGE_X,
        zIndex: 30,
        width: 384,
        maxWidth: `calc(100% - ${WORKBENCH_HEADER_EDGE_X * 2}px)`,
      }}
    >
      <div className="rss-task-menu__head">
        <div className="min-w-0">
          <div className="rss-task-menu__title">分析任务</div>
          <div className="rss-task-menu__meta">{analysisJobs.length} 条记录 · {activeJobsCount} 个进行中</div>
        </div>
        <IconButton size="sm" icon={<X />} title="关闭" onClick={() => setTaskMenuOpen(false)} />
      </div>
      {analysisJobs.length === 0 ? (
        <EmptyState title="暂无任务记录" />
      ) : (
        <div className="rss-task-menu__list rn-scroll">
          {analysisJobs.map((job) => {
            const isQueued = job.status === 'queued'
            const isPaused = job.status === 'paused'
            const isRunning = job.status === 'running_script' || job.status === 'running_subagent'
            const canDelete = !isRunning
            const canToggle = isQueued || isPaused
            const detailText = taskDetailText(job)
            const roundedProgress = Math.max(0, Math.min(100, Math.round(job.progress || 0)))
            return (
              <div key={job.id} className="rss-task-menu-row">
                <div className="flex h-6 items-center justify-center">
                  <AnalysisProgressRing entry={{ progress: roundedProgress, status: job.status, sourceWarning: job.sourceWarning }} />
                </div>
                <div className="min-w-0">
                  <div className="rss-task-menu-row__title" title={job.title}>{job.title}</div>
                  <div className="rss-task-menu-row__meta">
                    <span>{taskTypeLabel(job.action)}</span>
                    <span>·</span>
                    <span>{roundedProgress}%</span>
                    <span>·</span>
                    <span style={{ color: taskStageTone(job.status) }}>
                      {job.sourceWarning ? '完成 · 有范围提示' : taskStageLabel(job.status)}
                    </span>
                  </div>
                  {detailText ? (
                    <div className="rss-task-menu-row__detail" data-error={job.error ? 'true' : undefined} title={detailText}>{detailText}</div>
                  ) : null}
                </div>
                <div className="rss-task-menu-row__actions">
                  <IconButton
                    size="sm"
                    disabled={!canToggle}
                    icon={isPaused ? <Play /> : <Pause />}
                    onClick={() => {
                      if (isPaused) onResumeAnalysisJob(job.id)
                      else if (isQueued) onPauseAnalysisJob(job.id)
                    }}
                    title={isPaused ? '继续任务' : isQueued ? '暂停任务' : '当前阶段不可切换'}
                  />
                  <IconButton
                    size="sm"
                    className="rss-task-menu-row__delete"
                    disabled={!canDelete}
                    icon={<Trash2 />}
                    onClick={() => onDeleteAnalysisJob(job.id)}
                    title={canDelete ? '删除任务' : '运行中任务暂不可删除'}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </FloatPanel>
  ) : null

  return (
    <div
      className="rss-feed-surface content-surface-panel rss-workbench-surface relative flex flex-col flex-1 min-h-0"
      style={{ padding: 0, background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
    >
      <RSSTopbarTools show={toolsVisible}>
        <div ref={toolsRef} className="rss-toolbar-actions flex items-center" style={{ gap: 2 }}>
          <RSSSearchField />
          <IconButton
            onClick={onRefresh}
            disabled={refreshing}
            icon={<RefreshCw className={refreshing ? 'animate-spin' : ''} />}
            title={selectedSource ? `刷新当前源：${selectedSourceEntry?.name || '所选订阅源'}` : '刷新全部订阅源'}
            aria-busy={isRefreshing || undefined}
          />
          <IconButton onClick={onAddSource} icon={<Plus />} title="添加 RSS 源" />
          {analysisJobs.length > 0 && (
            <IconButton
              className="rss-toolbar-task"
              onClick={() => setTaskMenuOpen((open) => !open)}
              active={taskMenuOpen}
              aria-expanded={taskMenuOpen}
              icon={<><ListTodo />{activeJobsCount > 0 ? <span className="rss-toolbar-active-dot" /> : null}</>}
              title={activeJobsCount > 0 ? `查看分析任务，${activeJobsCount} 个进行中` : '查看分析任务'}
            />
          )}
          <IconButton
            onClick={(event) => openMoreMenu(event.currentTarget)}
            className={settingsOpen ? 'rss-toolbar-on' : undefined}
            aria-haspopup="menu"
            icon={<MoreHorizontal />}
            title="更多操作"
          />
          {taskMenuPanel}
        </div>
      </RSSTopbarTools>

      <RSSWorkspaceHeading
        view={view}
        loading={loading}
        definitions={definitions}
        status={toolsVisible ? <RSSProcessingPanel active={active} /> : null}
        filtersAside={(
          <Button
            variant="ghost"
            size="sm"
            className="rss-source-select"
            onClick={(event) => openSourceMenu(event.currentTarget)}
            title={sourceLabel}
            aria-haspopup="listbox"
          >
            <span>{sourceLabel}</span>
            <ChevronDown />
          </Button>
        )}
      />

      <div className="rss-feed-list" data-rss-loaded-count={items.length}>
        {queryError && <div className="rss-query-error" role="alert">{queryError}<Button variant="ghost" size="sm" onClick={onReloadQuery}>重新读取</Button></div>}
        {shouldShowBootstrapSkeleton ? (
          <div className="rss-skeleton-list" aria-hidden>
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={`rss-skeleton-${index}`} className="rss-skeleton">
                <Skeleton width={64 + (index % 3) * 10} height={10} />
                <Skeleton width={`${54 + (index % 2) * 16}%`} height={14} />
                <Skeleton width={`${78 + (index % 2) * 10}%`} height={10} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Inbox />} title={queryError ? '当前范围暂时无法读取' : '这里还没有资讯'} />
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
        {nextPage && <Button variant="ghost" size="sm" className="rss-load-more" disabled={loading || loadingMore} onClick={onLoadMore}>{loadingMore ? '正在读取…' : '加载更多'}</Button>}
      </div>
    </div>
  )
}

// The source filter's list: a float of the shared host drawn with the menu rows; each source carries its own delete.
function SourcePicker({ sources, selected, onChoose, onDelete }: {
  sources: RSSSource[]; selected: string | null; onChoose(id: string | null): void; onDelete(source: RSSSource): void
}) {
  return <div className="rn-menu rss-source-menu" role="presentation">
    <div className="rss-source-menu__list rn-scroll">
      <button type="button" role="option" aria-selected={!selected} className="rn-menu__item" onClick={() => onChoose(null)}>
        <span className="rn-menu__check">{!selected ? <Check size={14} /> : null}</span>
        <span className="rn-menu__label">全部源</span>
      </button>
      {sources.map((source) => {
        const isSelected = source.id === selected
        return (
          <div key={source.id} className="rss-source-menu__row">
            <button type="button" role="option" aria-selected={isSelected} className="rn-menu__item" title={source.name} onClick={() => onChoose(source.id)}>
              <span className="rn-menu__check">{isSelected ? <Check size={14} /> : null}</span>
              <span className="rn-menu__label">{source.name}</span>
            </button>
            <IconButton size="sm" className="rss-source-menu__delete" icon={<X />} title={`删除 ${source.name}`} onClick={() => onDelete(source)} />
          </div>
        )
      })}
      {sources.length === 0 && <EmptyState title="暂无订阅源" />}
    </div>
  </div>
}
