import RSSDefinitionEditor from '../../components/rss/RSSDefinitionEditor'
import RSSProcessingPanel from '../../components/rss/RSSProcessingPanel'
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, AlertCircle, ExternalLink } from 'lucide-react'
import RSSFeed from '../../components/rss/RSSFeed'
import RSSNavigation from '../../components/rss/RSSNavigation'
import RSSWorkspaceToolbar from '../../components/rss/RSSWorkspaceToolbar'
import RSSArticleReader from '../../components/rss/RSSArticleReader'
import AddSourceModal from '../../components/rss/AddSourceModal'
import RSSSettingsPanel from '../../components/rss/RSSSettingsPanel'
import Modal from '../../components/ui/Modal'
import { useModal } from '../../components/ui/useModal'
import { useRSSAgentAdapter } from '../../modules/rss/useRSSAgentAdapter'
import { useRSSWorkspace } from '../../modules/rss/useRSSWorkspace'
import { toRSSItem } from '../../modules/rss/workspace-query'
import {
  DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS,
  getRSSAutoRefreshWarning,
  getRSSFetchAllResultWarning,
  getRSSRefreshOutcome,
  parseRSSAutoRefreshInterval,
  RSS_AUTO_REFRESH_INTERVAL_KEY,
} from '../../modules/rss/settings'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
  WORKBENCH_SUPPORT_PANEL_WIDTH,
} from '../../modules/workbench/chrome'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useRSSSession } from '../../stores/useRSSSession'
import { getRSSAnalysisPollState, type RSSAnalysisProgressPollResult } from '../../modules/rss/analysisPollState'
import { getRSSAddSourceStatusMessage } from '../../modules/rss/add-source-status'
import type { RSSItem, RSSSource } from '../../components/rss/RSSFeed'
import type { AddSourceSuccessInfo } from '../../components/rss/AddSourceModal'
import type { RSSBrowserOpenActionData } from '../../modules/rss/types'

const RSS_MODE_SHELL_STYLE = {
  background: 'var(--workbench-module-surface-bg)',
  '--workbench-support-panel-width': `${WORKBENCH_SUPPORT_PANEL_WIDTH}px`,
} as CSSProperties & { '--workbench-support-panel-width': string }

type RSSAnalysisStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'

interface RSSItemAnalysisProgressState {
  sourceWarning?: string | null
  itemId: string
  jobId: string
  action: 'copy' | 'visual'
  status: RSSAnalysisStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

interface RSSAnalysisJobState {
  sourceWarning?: string | null
  id: string
  itemId: string
  action: 'copy' | 'visual'
  title: string
  status: RSSAnalysisStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

interface RSSModeProps {
  isActive?: boolean
  isSuspended?: boolean
  isMotionSettled?: boolean
}

interface AddSourceDraftState {
  browserPresetUrl: string
  browserPresetName: string
  browserPresetLabel: string | null
}

export default function RSSMode({
  isActive = true,
  isSuspended = false,
  isMotionSettled = true,
}: RSSModeProps) {
  const navigate = useNavigate()
  const { query, view, items, sources, definitions, loading, loadingMore, error, reload, loadMore, hasHydrated } = useRSSWorkspace(isActive && !isSuspended)
  const selectedSourceId = query.sourceId || null
  const setQuery = useRSSSession((state) => state.setQuery)
  const setSelection = useRSSSession((state) => state.setSelection)
  const browserTabs = useBrowserTabs((state) => state.tabs)
  const activeBrowserTabId = useBrowserTabs((state) => state.activeTabId)
  const selectedSource = selectedSourceId
  const [showOrganization, setShowOrganization] = useState(false)
  const [selectedItem, setSelectedItem] = useState<RSSItem | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [autoRefreshIntervalMs, setAutoRefreshIntervalMs] = useState(DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS)
  const [addSourceDraft, setAddSourceDraft] = useState<AddSourceDraftState>({
    browserPresetUrl: '',
    browserPresetName: '',
    browserPresetLabel: null,
  })
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [itemStateError, setItemStateError] = useState<{ itemId: string; action: 'read' | 'star'; message: string } | null>(null)
  const [statusAction, setStatusAction] = useState<RSSBrowserOpenActionData | null>(null)
  const [analysisBackgroundWarning, setAnalysisBackgroundWarning] = useState<string | null>(null)
  const [autoRefreshWarning, setAutoRefreshWarning] = useState<string | null>(null)
  const [analysisProgressMap, setAnalysisProgressMap] = useState<Record<string, RSSItemAnalysisProgressState>>({})
  const [analysisJobs, setAnalysisJobs] = useState<RSSAnalysisJobState[]>([])
  const sourcesRef = useRef<RSSSource[]>([])
  const lastModalActionKeyRef = useRef<string | null>(null)
  const suspendedRef = useRef(isSuspended)
  const pendingAutoRefreshSnapshotRef = useRef<Parameters<typeof getRSSAutoRefreshWarning>[0] | null>(null)
  suspendedRef.current = isSuspended
  const shouldPoll = isActive && !isSuspended && hasHydrated
  const backgroundWarning = autoRefreshWarning || analysisBackgroundWarning
  const { modalProps, showConfirm } = useModal()
  const activeBrowserTab = useMemo(
    () => browserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null,
    [activeBrowserTabId, browserTabs],
  )
  const activeBrowserPageLabel = useMemo(() => {
    if (!activeBrowserTab?.url) return null
    const label = activeBrowserTab.title?.trim() || activeBrowserTab.domain?.trim() || activeBrowserTab.url
    return `当前页：${label}`
  }, [activeBrowserTab])
  const visibleItemIds = useMemo(() => items.map((item) => item.id), [items])
  const loadRSSData = useCallback(async (_options?: { background?: boolean }) => { await reload() }, [reload])

  useEffect(() => {
    sourcesRef.current = sources
  }, [sources])

  useEffect(() => {
    let cancelled = false
    const loadAutoRefreshSetting = async () => {
      if (!window.electronAPI?.settings?.get) return
      const result = await window.electronAPI.settings.get(RSS_AUTO_REFRESH_INTERVAL_KEY)
      if (cancelled || !result.success) return
      setAutoRefreshIntervalMs(parseRSSAutoRefreshInterval(result.data))
    }
    void loadAutoRefreshSetting()
    return () => {
      cancelled = true
    }
  }, [])

  const fetchAnalysisProgress = useCallback(async (itemIds: string[]): Promise<RSSAnalysisProgressPollResult> => {
    if (!window.electronAPI?.rss?.getItemAnalysisProgress) return { ok: true, hasActiveWork: false }
    if (itemIds.length === 0) {
      setAnalysisProgressMap({})
      return { ok: true, hasActiveWork: false }
    }

    try {
      const result = await window.electronAPI.rss.getItemAnalysisProgress({ itemIds })
      if (!result.success || !result.data) return { ok: false, hasActiveWork: false }
      const progressMap = result.data as Record<string, RSSItemAnalysisProgressState>
      setAnalysisProgressMap(progressMap)
      return {
        ok: true,
        hasActiveWork: Object.values(progressMap).some(
          (entry) =>
            entry.status === 'queued' || entry.status === 'running_script' || entry.status === 'running_subagent',
        ),
      }
    } catch {
      // silent-catch: failure is surfaced by getRSSAnalysisPollState as the RSS background-warning banner.
      return { ok: false, hasActiveWork: false }
    }
  }, [])

  const fetchAnalysisJobs = useCallback(async (): Promise<boolean> => {
    if (!window.electronAPI?.rss?.listItemAnalysisJobs) return true
    try {
      const result = await window.electronAPI.rss.listItemAnalysisJobs({ limit: 120 })
      if (!result.success || !result.data) return false
      const jobs = result.data.map((job) => ({
        id: job.id,
        itemId: job.itemId,
        action: job.action,
        title: job.title,
        status: job.status as RSSAnalysisStatus,
        progress: Number(job.progress) || 0,
        message: job.message ?? null,
        error: job.error ?? null,
        outputDir: job.outputDir,
        reportPath: job.reportPath,
        sourceWarning: job.sourceWarning ?? null,
        updatedAt: job.updatedAt,
      }))
      setAnalysisJobs(jobs)
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    if (!shouldPoll) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const progress = await fetchAnalysisProgress(visibleItemIds)
      const jobsOk = await fetchAnalysisJobs()
      const pollState = getRSSAnalysisPollState(progress, jobsOk)
      setAnalysisBackgroundWarning(pollState.backgroundWarning)
      if (disposed) return
      timer = setTimeout(tick, pollState.nextDelayMs)
    }

    void tick()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [fetchAnalysisJobs, fetchAnalysisProgress, shouldPoll, visibleItemIds])

  useEffect(() => {
    const rss = window.electronAPI?.rss
    if (!rss?.autoRefreshStatus || !rss.onAutoRefreshCompleted) return

    const applySnapshot = (snapshot: Parameters<typeof getRSSAutoRefreshWarning>[0]) => {
      setAutoRefreshWarning(getRSSAutoRefreshWarning(snapshot))
    }
    const unsubscribe = rss.onAutoRefreshCompleted((snapshot) => {
      if (suspendedRef.current) {
        pendingAutoRefreshSnapshotRef.current = snapshot
        return
      }
      applySnapshot(snapshot)
      void loadRSSData({ background: true }).catch(() => {})
    })
    void rss.autoRefreshStatus().then((result) => {
      if (!result.success || !result.data) return
      if (suspendedRef.current) pendingAutoRefreshSnapshotRef.current = result.data
      else applySnapshot(result.data)
    })
    return unsubscribe
  }, [loadRSSData])

  useEffect(() => {
    if (isSuspended) return
    const pending = pendingAutoRefreshSnapshotRef.current
    if (!pending) return
    pendingAutoRefreshSnapshotRef.current = null
    setAutoRefreshWarning(getRSSAutoRefreshWarning(pending))
    void loadRSSData({ background: true }).catch(() => {})
  }, [isSuspended, loadRSSData])

  useEffect(() => {
    if (!shouldPoll) return
    void fetchAnalysisJobs()
    void fetchAnalysisProgress(visibleItemIds)
  }, [fetchAnalysisJobs, fetchAnalysisProgress, shouldPoll, visibleItemIds])

  useEffect(() => {
    if (!statusMessage) return
    const timer = setTimeout(() => setStatusMessage(null), 4500)
    return () => clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    if (!statusAction) return
    const timer = setTimeout(() => setStatusAction(null), 6000)
    return () => clearTimeout(timer)
  }, [statusAction])

  useEffect(() => {
    if (!statusAction) return
    if (!(statusAction.reason === 'login' || statusAction.reason === 'verify')) return
    const actionKey = `${statusAction.reason}:${statusAction.url}`
    if (lastModalActionKeyRef.current === actionKey) return
    lastModalActionKeyRef.current = actionKey

    const title = statusAction.reason === 'login' ? '需要先登录' : '需要先扫码验证'
    const message =
      statusAction.reason === 'login'
        ? '这个账号当前需要先在 Ready 浏览器里登录后才能继续刷新。现在要打开对应主页吗？'
        : '这个账号当前需要先在 Ready 浏览器里打开目标主页，并按页面提示完成扫码验证。现在要跳转过去吗？'

    void showConfirm(message, title).then((confirmed) => {
      if (!confirmed) return
      void window.electronAPI?.browser?.openForCaptureTarget(statusAction.url)
    })
  }, [showConfirm, statusAction])

  const handleSourceChange = useCallback((sourceId: string | null) => {
    setQuery({ sourceId: sourceId || undefined })
  }, [setQuery])

  const handleAddSource = useCallback(() => {
    setAddSourceDraft({
      browserPresetUrl: activeBrowserTab?.url || '',
      browserPresetName: activeBrowserTab?.title?.trim() || '',
      browserPresetLabel: activeBrowserPageLabel || null,
    })
    setShowAddModal(true)
  }, [activeBrowserPageLabel, activeBrowserTab])

  const handleDeleteSource = useCallback(async (sourceId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    const result = await window.electronAPI.rss.removeSource(sourceId)
    if (!result.success) {
      setStatusMessage(result.error ? `删除源失败：${result.error}` : '删除源失败')
      return
    }
    if (selectedSourceId === sourceId) setQuery({ sourceId: undefined })
    setSelectedItem((prev) => prev?.sourceId === sourceId ? null : prev)
    await loadRSSData()
  }, [loadRSSData, selectedSourceId, setQuery])

  const handleItemClick = useCallback((item: RSSItem) => {
    setItemStateError(null)
    setSelectedItem(item)
  }, [])

  const applySavedItemState = useCallback(async (itemId: string) => {
    await loadRSSData({ background: true })
    const saved = await window.electronAPI.rss.readArticle({ itemId, length: 1 })
    if (!saved.success || !saved.data) throw new Error(saved.error || '无法确认文章保存状态')
    const state = saved.data.article
    setSelectedItem((prev) => prev?.id === itemId ? { ...prev, ...toRSSItem(state) } : prev)
  }, [loadRSSData])

  const handleToggleStar = useCallback(async (itemId: string) => {
    try {
      const result = await window.electronAPI.rss.toggleStarred(itemId)
      if (!result.success) throw new Error(result.error || '收藏保存失败')
      await applySavedItemState(itemId)
      setItemStateError((previous) => previous?.itemId === itemId && previous.action === 'star' ? null : previous)
    } catch (cause) { setItemStateError({ itemId, action: 'star', message: cause instanceof Error ? cause.message : String(cause) }) }
  }, [applySavedItemState])

  const handleRefresh = useCallback(async () => {
    if (refreshing) return getRSSRefreshOutcome({ success: true, data: { running: true } })
    setRefreshing(true)
    setStatusAction(null)
    const sourceId = useRSSSession.getState().query.sourceId
    try {
      const label = sourcesRef.current.find((source) => source.id === sourceId)?.name || '所选订阅源'
      setStatusMessage(sourceId ? `${label} 正在刷新…` : '正在刷新全部 RSS 源…')
      let outcome: import('../../modules/rss/settings').RSSRefreshOutcome
      if (sourceId) {
        const result = await window.electronAPI.rss.refreshSource(sourceId)
        setStatusAction(result.data?.browserAction || null)
        outcome = getRSSRefreshOutcome(result, label)
      } else {
        const result = await window.electronAPI.rss.fetchAll()
        setAutoRefreshWarning(getRSSFetchAllResultWarning(result))
        outcome = getRSSRefreshOutcome(result)
      }
      try { await loadRSSData(); outcome.viewUpdated = true }
      catch { /* silent-catch: refresh outcome reports that the view did not update. */ outcome.viewUpdated = false; outcome.summary += '；列表暂未更新，请重新读取。' }
      setStatusMessage(outcome.summary)
      return outcome
    } catch (cause) {
      const outcome = getRSSRefreshOutcome({ success: false, error: cause instanceof Error ? cause.message : '刷新失败' })
      setStatusMessage(outcome.summary)
      if (!sourceId) setAutoRefreshWarning(outcome.summary)
      return outcome
    } finally { setRefreshing(false) }
  }, [loadRSSData, refreshing])

  const handleStatusAction = useCallback(async () => {
    if (!statusAction?.url) return
    await window.electronAPI?.browser?.openForCaptureTarget(statusAction.url)
  }, [statusAction])

  const handleOpenExternalServices = useCallback(() => {
    navigate('/settings?section=external-services')
  }, [navigate])

  const handleAutoRefreshIntervalChange = useCallback((intervalMs: number) => {
    setAutoRefreshIntervalMs(intervalMs)
    if (intervalMs <= 0) setAutoRefreshWarning(null)
  }, [])

  useRSSAgentAdapter({
    items,
    selectedSource,
    selectedItem,
    loadRSSData,
    handleRefresh,
    handleItemClick,
    setSelection,
    isActive,
    setAnalysisProgressMap,
  })

  const handleMarkItemRead = useCallback(async (itemId: string) => {
    try {
      const result = await window.electronAPI.rss.markRead(itemId)
      if (!result.success) throw new Error(result.error || '已读状态保存失败')
      await applySavedItemState(itemId)
      setItemStateError((previous) => previous?.itemId === itemId && previous.action === 'read' ? null : previous)
    } catch (cause) { setItemStateError({ itemId, action: 'read', message: cause instanceof Error ? cause.message : String(cause) }) }
  }, [applySavedItemState])

  const handleClearRead = useCallback(async () => {
    if (!view) return
    try {
      const result = await window.electronAPI.rss.dismissQuery({ ...view.query, expectedRevision: view.revision })
      if (!result.success || !result.data) throw new Error(result.error || '清空失败')
      await loadRSSData()
      setStatusMessage(`已按发起时的筛选范围移出 ${result.data.dismissed} 条内容，保留收藏与历史底稿`)
    } catch (cause) { /* silent-catch: the operation failure remains visible in the RSS status area. */ setStatusMessage(cause instanceof Error && cause.message === 'cursor_stale' ? '资料已更新，请重新读取后再清空。' : cause instanceof Error ? cause.message : String(cause)) }
  }, [loadRSSData, view])

  const handleDeleteItem = useCallback(async (itemId: string) => {
    try {
      const result = await window.electronAPI.rss.deleteItems({ itemIds: [itemId] })
      if (!result.success) throw new Error(result.error || '移出收件箱失败')
      await loadRSSData()
      setStatusMessage('已移出收件箱，历史底稿仍保留')
      setSelectedItem((prev) => prev?.id === itemId ? null : prev)
    } catch (cause) { /* silent-catch: the operation failure remains visible in the RSS status area. */ setStatusMessage(cause instanceof Error ? cause.message : String(cause)) }
  }, [loadRSSData])

  const handleOpenAnalysisOutput = useCallback(
    async (itemId: string) => {
      const progress = analysisProgressMap[itemId]
      if (!progress) {
        setStatusMessage('暂无分析结果')
        return
      }
      const targetPath = progress.reportPath || progress.outputDir
      if (!targetPath) {
        setStatusMessage('暂无可打开的分析目录')
        return
      }
      const result = await window.electronAPI?.document?.showInFolder?.(targetPath)
      if (!result?.success) {
        setStatusMessage(result?.error ? `打开失败：${result.error}` : '打开目录失败')
      }
    },
    [analysisProgressMap],
  )

  const handlePauseAnalysisJob = useCallback(async (jobId: string) => {
    const result = await window.electronAPI?.rss?.pauseAnalysisJob?.({ jobId })
    if (!result?.success) {
      setStatusMessage(result?.error ? `暂停失败：${result.error}` : '暂停失败')
      return
    }
    setStatusMessage('任务已暂停')
    await fetchAnalysisJobs()
    await fetchAnalysisProgress(visibleItemIds)
  }, [fetchAnalysisJobs, fetchAnalysisProgress, visibleItemIds])

  const handleResumeAnalysisJob = useCallback(async (jobId: string) => {
    const result = await window.electronAPI?.rss?.resumeAnalysisJob?.({ jobId })
    if (!result?.success) {
      setStatusMessage(result?.error ? `继续失败：${result.error}` : '继续失败')
      return
    }
    setStatusMessage('任务已继续')
    await fetchAnalysisJobs()
    await fetchAnalysisProgress(visibleItemIds)
  }, [fetchAnalysisJobs, fetchAnalysisProgress, visibleItemIds])

  const handleDeleteAnalysisJob = useCallback(async (jobId: string) => {
    const result = await window.electronAPI?.rss?.deleteAnalysisJob?.({ jobId })
    if (!result?.success || !result.data?.deleted) {
      const reason = result?.data?.reason || result?.error || '删除失败'
      setStatusMessage(`删除失败：${reason}`)
      return
    }
    setStatusMessage('任务记录已删除')
    await fetchAnalysisJobs()
    await fetchAnalysisProgress(visibleItemIds)
  }, [fetchAnalysisJobs, fetchAnalysisProgress, visibleItemIds])

  const handleClosePreview = useCallback(() => {
    setSelectedItem(null)
  }, [])

  const handleBodyLoaded = useCallback(async (article: import('../../../shared/rss-workspace').RSSArticleExcerpt['article']) => {
    setSelectedItem((previous) => previous?.id === article.id ? toRSSItem(article) : previous)
    await loadRSSData({ background: true })
  }, [loadRSSData])

  const handleAddSourceSuccess = useCallback((source?: AddSourceSuccessInfo) => {
    void loadRSSData().then(() => {
      if (source?.id) {
        setQuery({ sourceId: source.id })
        setSelection({
          selectedItemId: null,
          selectedItemTitle: null,
        })
      }
      const statusMessage = getRSSAddSourceStatusMessage(source)
      if (statusMessage) setStatusMessage(statusMessage)
    }).catch((cause) => setStatusMessage(String(cause)))
  }, [loadRSSData, setQuery, setSelection])

  // Error state
  if (error && !loading && items.length === 0) {
    return (
      <div className="workbench-mode-root items-center justify-center">
        <div className="text-center p-8">
          <AlertCircle className="w-16 h-16 mx-auto mb-4 text-[var(--color-red)]" />
          <h3 className="text-[16px] font-semibold text-[var(--text-title)] mb-2">加载失败</h3>
          <p className="text-[13px] text-[var(--text-muted)] mb-4 max-w-[300px]">{error}</p>
          <button
            onClick={() => {
              void loadRSSData()
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-blue)] text-white text-[13px] hover:brightness-95 transition-[filter]"
          >
            <RefreshCw className="w-4 h-4" />
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="workbench-mode-root rss-mode-shell" style={RSS_MODE_SHELL_STYLE}>
      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        <div
          className="workbench-canvas-shell relative flex h-full min-h-0 overflow-hidden"
          style={{ background: 'var(--workbench-module-surface-bg)' }}
        >
          <RSSNavigation definitions={definitions} onManage={() => { setSelectedItem(null); setShowOrganization((value) => !value) }} onNavigate={(patch) => { setSelectedItem(null); setQuery(patch) }} />
          {/* Keep the list mounted so returning from reading preserves scroll. */}
          <div
            className={`rss-feed-sheet content-surface-panel flex-1 overflow-hidden flex flex-col relative`}
            style={{
              background: 'var(--workbench-module-surface-bg)',
              display: selectedItem ? 'none' : undefined,
            }}
          >
            {showOrganization && <RSSDefinitionEditor definitions={definitions} onClose={() => setShowOrganization(false)} onSaved={(deletedId) => {
              const current = useRSSSession.getState().query
              if (deletedId && (current.collectionId === deletedId || current.categoryId === deletedId)) setQuery({ collectionId: undefined, categoryId: undefined, scope: 'inbox', filter: 'all' })
            }} />}
            <RSSWorkspaceToolbar view={view} loading={loading} definitions={definitions} />
            <RSSProcessingPanel active={isActive && !isSuspended} />
            <RSSFeed
              active={isActive && !isSuspended}
              items={items}
              sources={sources}
              selectedSource={selectedSource}
              selectedItemId={selectedItem?.id ?? null}
              loading={loading}
              refreshing={refreshing}
              analysisProgressMap={analysisProgressMap}
              analysisJobs={analysisJobs}
              onSourceChange={handleSourceChange}
              onItemClick={handleItemClick}
              onMarkItemRead={handleMarkItemRead}
              onToggleStar={handleToggleStar}
              onDeleteItem={handleDeleteItem}
              onOpenAnalysisOutput={handleOpenAnalysisOutput}
              onRefresh={handleRefresh}
              onAddSource={handleAddSource}
              onDeleteSource={handleDeleteSource}
              onClearRead={handleClearRead}
              onOpenSettings={() => setSettingsOpen((open) => !open)}
              onPauseAnalysisJob={handlePauseAnalysisJob}
              onResumeAnalysisJob={handleResumeAnalysisJob}
              onDeleteAnalysisJob={handleDeleteAnalysisJob}
              settingsOpen={settingsOpen}
              nextPage={Boolean(view?.nextCursor)}
              loadingMore={loadingMore}
              queryError={error}
              inbox={query.scope === 'inbox'}
              onLoadMore={() => void loadMore()}
              onReloadQuery={() => void reload().catch(() => {})}
            />
            {(statusMessage || itemStateError || backgroundWarning || statusAction) && (
              <div
                className="glass-surface-floating absolute top-[62px] right-4 z-20 rounded-lg px-3 py-2 text-[12px]"
                style={{
                  background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-secondary)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {statusMessage || itemStateError || backgroundWarning ? (
                  <div>{statusMessage || (itemStateError ? `《${items.find((item) => item.id === itemStateError.itemId)?.title || '文章'}》：${itemStateError.message}` : backgroundWarning)}</div>
                ) : null}
                {statusAction ? (
                  <button
                    onClick={() => void handleStatusAction()}
                    className="mt-2 inline-flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={{
                      borderColor: 'var(--border-default)',
                      color: 'var(--text-title)',
                      background: 'rgba(255,255,255,0.74)',
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {statusAction.label}
                  </button>
                ) : null}
              </div>
            )}
            <RSSSettingsPanel
              open={settingsOpen}
              sources={sources}
              selectedSourceId={selectedSource}
              autoRefreshIntervalMs={autoRefreshIntervalMs}
              onAutoRefreshIntervalChange={handleAutoRefreshIntervalChange}
              onClose={() => setSettingsOpen(false)}
              onReloadData={() => loadRSSData({ background: true })}
              onOpenExternalServices={handleOpenExternalServices}
            />
          </div>

          {/* Article rendering shares the document typography, without active widgets. */}
          {selectedItem && (
            <RSSArticleReader
              active={isActive && !isSuspended}
              definitions={definitions}
              key={selectedItem.id}
              item={items.find((item) => item.id === selectedItem.id) || selectedItem}
              onClose={handleClosePreview}
              onOpened={handleMarkItemRead}
              onBodyLoaded={handleBodyLoaded}
              onToggleStar={handleToggleStar}
              notice={itemStateError?.itemId === selectedItem.id ? itemStateError.message : null}
            />
          )}
        </div>
      </div>

      {/* Add Source Modal */}
      <AddSourceModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSuccess={handleAddSourceSuccess}
        browserPresetUrl={addSourceDraft.browserPresetUrl}
        browserPresetName={addSourceDraft.browserPresetName}
        browserPresetLabel={addSourceDraft.browserPresetLabel}
      />
      <Modal {...modalProps} />
    </div>
  )
}
