import { userOpenedObject } from '../../modules/workbench/navigation-open-event'
import RSSDigestPanel from '../../components/rss/RSSDigestPanel'
import RSSDefinitionEditor from '../../components/rss/RSSDefinitionEditor'
import PreviewBrowser from '../../components/rss/PreviewBrowser'
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, ExternalLink, MessageSquareQuote } from 'lucide-react'
import RSSFeed from '../../components/rss/RSSFeed'
import RSSNavigation from '../../components/rss/RSSNavigation'
import { ShellNavigator } from '../../modules/workbench/shell/ShellSidebar'
import { NavigationBackEntry } from '../../modules/workbench/NavigationBackEntry'
import { RSSTopbarContext } from '../../components/rss/rss-topbar-context'
import RSSArticleReader from '../../components/rss/RSSArticleReader'
import { addRSSReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import { exportRSSQuery } from '../../modules/rss/export-query'
import AddSourceModal from '../../components/rss/AddSourceModal'
import RSSSettingsPanel from '../../components/rss/RSSSettingsPanel'
import { RSSSieveView } from '../../components/rss/RSSSieveView'
import { RSSSieveSettings } from '../../components/rss/RSSSieveSettings'
import { noteRSSBehavior } from '../../modules/rss/record-behavior'
import { Button } from '../../components/ui/Button'
import { confirmDialog } from '../../components/ui/float/Dialog'
import { useRSSSelectionCommandBridge } from '../../modules/rss/useRSSSelectionCommandBridge'
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
import type { RSSFeedNotice, RSSItem, RSSSource } from '../../components/rss/RSSFeed'
import type { AddSourceSuccessInfo } from '../../components/rss/AddSourceModal'
import type { RSSBrowserOpenActionData } from '../../modules/rss/types'

const RSS_MODE_SHELL_STYLE = {
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
  const pendingReveal = useRSSSession((state) => state.pendingReveal)
  const digestVisible = useRSSSession((state) => state.digestVisible)
  const setDigestView = useRSSSession((state) => state.setDigestView)
  const sieveVisible = useRSSSession((state) => state.sieveVisible)
  const setSieveView = useRSSSession((state) => state.setSieveView)
  const notificationOpenRevision = useRSSSession((state) => state.notificationOpenRevision)
  const selectedSourceId = query.sourceId || null
  const setQuery = useRSSSession((state) => state.setQuery)
  const setSelection = useRSSSession((state) => state.setSelection)
  const browserTabs = useBrowserTabs((state) => state.tabs)
  const activeBrowserTabId = useBrowserTabs((state) => state.activeTabId)
  const selectedSource = selectedSourceId
  const [showOrganization, setShowOrganization] = useState(false)
  // Set when the editor opens on one column from another view (the digest's 收录范围); closing returns there.
  const [organizationFocus, setOrganizationFocus] = useState<string | undefined>()
  // A topic opened from 筛子设置 returns there when its editor closes; opened from elsewhere, closing leaves both.
  const [editorFromSettings, setEditorFromSettings] = useState(false)
  // The live page opened beside the reader; it belongs to the article being read.
  const [originalItem, setOriginalItem] = useState<RSSItem | null>(null)
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
  const [notice, setNotice] = useState<RSSFeedNotice | null>(null)
  const [topbarLead, setTopbarLead] = useState<HTMLDivElement | null>(null)
  const [topbarTools, setTopbarTools] = useState<HTMLDivElement | null>(null)
  const topbarSlots = useMemo(() => ({ lead: topbarLead, tools: topbarTools }), [topbarLead, topbarTools])
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
  const exporting = useRef(false)
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
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), notice.action ? 8000 : 4500)
    return () => clearTimeout(timer)
  }, [notice])

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

    void confirmDialog({ title, body: message }).then((confirmed) => {
      if (!confirmed) return
      void window.electronAPI?.browser?.openForCaptureTarget(statusAction.url)
    })
  }, [statusAction])

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

  const addSourceRequested = useRSSSession(state => state.addSourceRequested)
  useEffect(() => {
    if (!isActive || isSuspended || !addSourceRequested) return
    useRSSSession.getState().requestAddSource(false)
    handleAddSource()
  }, [addSourceRequested, handleAddSource, isActive, isSuspended])

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

  const requestedCalibration = useRSSSession(state => state.requestedCalibration)
  useEffect(() => {
    if (!isActive || isSuspended || !requestedCalibration) return
    useRSSSession.getState().cancelReveal()
    setSelectedItem(null); setDigestView(false); setShowOrganization(false); setSieveView(true)
    useRSSSession.getState().requestCalibration(null)
  }, [requestedCalibration, isActive, isSuspended, setDigestView, setSieveView])

  const handleItemClick = useCallback((item: RSSItem, record = true) => {
    if (record) userOpenedObject({ mode: 'rss', ref: { kind: 'rss-item', id: item.id }, title: item.title })
    useRSSSession.getState().cancelReveal()
    setItemStateError(null)
    setSelectedItem(item)
    noteRSSBehavior({ itemId: item.id, action: 'open' })
  }, [])

  // A 必须知道 notification was clicked: open that article, then tell Main it was handled. An older request never
  // clears a newer one, because Main acknowledges by request id.
  useEffect(() => {
    if (!isActive || isSuspended) return
    let live = true
    void (async () => {
      const api = window.electronAPI.rss
      const pending = await api.sievePendingOpen()
      if (!live || !pending.success || !pending.data) return
      const request = pending.data
      const result = await api.readArticle({ itemId: request.itemId, length: 1 })
      if (!live) return
      if (result.success && result.data) {
        setDigestView(false); setShowOrganization(false)
        handleItemClick(toRSSItem(result.data.article))
      } else setStatusMessage(`通知里的文章打不开了：${result.error || '它可能已被删除'}`)
      await api.sieveAckOpen(request.id)
    })().catch((error: unknown) => { if (live) setStatusMessage(`通知里的文章打不开了：${error instanceof Error ? error.message : String(error)}`) })
    return () => { live = false }
  }, [isActive, isSuspended, notificationOpenRevision, handleItemClick, setDigestView])

  useEffect(() => {
    if (!isActive || isSuspended || !pendingReveal) return
    let live = true
    const request = pendingReveal
    const current = () => live && useRSSSession.getState().pendingReveal?.id === request.id
    void (async () => {
      try {
        const reference = request.reference
        if (reference.kind === 'query') {
          const result = await window.electronAPI.rss.queryItems(reference.query)
          if (!result.success || !result.data) throw new Error(result.error || '资讯查询无法读取')
          if (!current()) return
          setSelectedItem(null); setShowOrganization(false)
          useRSSSession.getState().replaceQuery(reference.query, result.data)
        } else if (reference.kind === 'digest') {
          const result = await window.electronAPI.rss.readDigests({ view: 'entries', ...reference.read, limit: 1 })
          if (!result.success) throw new Error(result.error || '刊物无法读取。')
          if (!current()) return
          setSelectedItem(null); setDigestView(true, reference.read.reportId)
        } else {
          const result = reference.kind === 'excerpt' ? await window.electronAPI.rss.readExcerpt({ ...reference.read, length: 1 })
            : await window.electronAPI.rss.readArticle({ ...reference.read, length: 1 })
          if (!result.success || !result.data) throw new Error(result.error || '引用文章无法读取。')
          if (!current()) return
          setDigestView(false); setShowOrganization(false)
          handleItemClick({ ...toRSSItem(result.data.article), pinnedRevision: reference.read.expectedRevision,
            ...(reference.kind === 'excerpt' ? { reveal: { id: request.id, range: reference.read.range } } : {}) }, false)
        }
      } catch (cause) {
        // silent-catch: a failed reveal is reported in the RSS status area.
        if (current()) {
          setSelectedItem(null); setDigestView(false)
          setStatusMessage(`引用定位失败：${cause instanceof Error && ['article_changed', 'cursor_stale'].includes(cause.message) ? '资料已变化，请重新引用。' : cause instanceof Error ? cause.message : String(cause)}`)
        }
      } finally { if (current()) useRSSSession.getState().finishReveal(request.id) }
    })()
    return () => { live = false; useRSSSession.getState().finishReveal(request.id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on pendingReveal.id: every requestReveal creates a new object with a fresh UUID, so the id identifies the request whose reference is captured here
  }, [pendingReveal?.id, isActive, isSuspended, handleItemClick, setDigestView, setQuery])

  const applySavedItemState = useCallback(async (itemId: string) => {
    await loadRSSData({ background: true })
    const saved = await window.electronAPI.rss.readArticle({ itemId, length: 1 })
    if (!saved.success || !saved.data) throw new Error(saved.error || '无法确认文章保存状态')
    const state = saved.data.article
    setSelectedItem((prev) => prev?.id === itemId ? prev.pinnedRevision
      ? { ...prev, read: state.read, starred: state.starred }
      : { ...prev, ...toRSSItem(state) } : prev)
    return state
  }, [loadRSSData])

  const handleToggleStar = useCallback(async (itemId: string) => {
    try {
      const result = await window.electronAPI.rss.toggleStarred(itemId)
      if (!result.success) throw new Error(result.error || '收藏保存失败')
      const state = await applySavedItemState(itemId)
      if (state.starred) noteRSSBehavior({ itemId, action: 'star' })
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

  useRSSSelectionCommandBridge({ active: isActive && !isSuspended, selectedItem, handleItemClick })

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
      noteRSSBehavior({ itemId, action: 'remove' })
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
    useRSSSession.getState().cancelReveal()
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

  const sieveShown = sieveVisible && !selectedItem && !digestVisible && !showOrganization
  const feedVisible = !sieveVisible && !selectedItem && !digestVisible && !showOrganization
  const readingId = selectedItem && !digestVisible && !showOrganization ? selectedItem.id : null
  useEffect(() => { setOriginalItem((current) => current && current.id === readingId ? current : null) }, [readingId])
  const surfaceActive = isActive && !isSuspended
  const toastText = statusMessage || (itemStateError ? `《${items.find((item) => item.id === itemStateError.itemId)?.title || '文章'}》：${itemStateError.message}` : null) || notice?.message || backgroundWarning
  const closeOverlays = () => { useRSSSession.getState().cancelReveal(); setSelectedItem(null) }

  return (
    <div className="workbench-mode-root rss-mode-shell" style={RSS_MODE_SHELL_STYLE}>
      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        {/* Same frame as Document and Browser: top bar + left rail on the canvas, content in a rounded frame. */}
        <div
          className="workbench-canvas-shell rss-workbench-canvas relative flex h-full min-h-0 overflow-hidden"
        >
          <RSSTopbarContext.Provider value={topbarSlots}>
            {/* 栏目导航在外壳唯一的侧栏里（W2-T4）。 */}
            <ShellNavigator mode="rss" label="资讯">
              <RSSNavigation
                definitions={definitions}
                managing={showOrganization}
                onSieve={() => { closeOverlays(); setDigestView(false); setShowOrganization(false); setSieveView(true) }}
                onDigests={() => { closeOverlays(); setShowOrganization(false); setSieveView(false); setDigestView(true) }}
                onManage={(focus) => { closeOverlays(); setDigestView(false); setEditorFromSettings(false); setOrganizationFocus(focus); setShowOrganization(true) }}
                onSources={() => setSettingsOpen((open) => !open)}
                onNavigate={(patch) => { closeOverlays(); setDigestView(false); setShowOrganization(false); setSieveView(false); setQuery(patch) }}
              />
            </ShellNavigator>
            <div className="rss-topbar workbench-tabs-surface no-drag">
              <NavigationBackEntry mode="rss" />
              <div className="rss-topbar__lead" ref={setTopbarLead}>
                {feedVisible && <span>资讯</span>}
              </div>
              <div className="rss-topbar__tools" ref={setTopbarTools} />
            </div>
            <div className="rss-workbench-body">
              {/* The list stays mounted so returning from reading preserves scroll. */}
              <div className={`rss-feed-sheet content-surface-panel rss-content-frame`}>
                {/* 为你筛过的 stays mounted while an article from it is open, so closing the article returns to the same place. */}
                {sieveVisible && <RSSSieveView shown={sieveShown && surfaceActive} onOpen={(item) => handleItemClick(toRSSItem(item))} />}
                <div className="flex min-h-0 flex-1 flex-col" style={{ display: feedVisible ? undefined : 'none' }}>
                  <RSSFeed
                    active={surfaceActive && feedVisible}
                    toolsVisible={surfaceActive && feedVisible}
                    query={view?.query}
                    queryRevision={view?.revision}
                    view={view}
                    definitions={definitions}
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
                    moreMenuEntries={() => [
                      { id: 'reference', label: '引用当前结果', icon: <MessageSquareQuote />, disabled: loading || !view,
                        onSelect: () => { if (view) addRSSReferenceToAgentInput('RSS 筛选结果', { kind: 'query', query: { ...view.query, expectedRevision: view.revision } }) } },
                      { id: 'export', label: '导出当前结果', hint: 'JSON', icon: <Download />, disabled: loading || !view,
                        onSelect: () => {
                          if (!view || exporting.current) return
                          exporting.current = true
                          void exportRSSQuery(view).then((receipt) => {
                            if (receipt) setNotice({ message: `已导出发起时的 ${receipt.total} 条结果`, action: { label: '显示文件', run: () => { void window.electronAPI.document.showInFolder(receipt.path) } } })
                          }, (cause: unknown) => setNotice({ message: cause instanceof Error ? cause.message : String(cause) }))
                            .finally(() => { exporting.current = false })
                        } },
                    ]}
                    settingsOpen={settingsOpen}
                    nextPage={Boolean(view?.nextCursor)}
                    loadingMore={loadingMore}
                    queryError={error}
                    inbox={query.scope === 'inbox'}
                    onLoadMore={() => void loadMore()}
                    onReloadQuery={() => void reload().catch(() => {})}
                  />
                </div>

                {showOrganization && !organizationFocus && <RSSSieveSettings definitions={definitions} active={surfaceActive}
                  onEditTopic={(id) => { setEditorFromSettings(true); setOrganizationFocus(id) }} />}
                {showOrganization && organizationFocus && <RSSDefinitionEditor key={organizationFocus} initialId={organizationFocus} definitions={definitions} active={surfaceActive}
                  onClose={() => { setOrganizationFocus(undefined); if (editorFromSettings) setEditorFromSettings(false); else setShowOrganization(false) }} onSaved={(deletedId) => {
                  const current = useRSSSession.getState().query
                  if (deletedId && (current.collectionId === deletedId || current.categoryId === deletedId)) setQuery({ collectionId: undefined, categoryId: undefined, scope: 'inbox', filter: 'all' })
                }} />}

                {digestVisible && !showOrganization && <RSSDigestPanel active={surfaceActive} view={view} definitions={definitions} feedSources={sources}
                  onEditDefinition={(id) => { setOrganizationFocus(id); setShowOrganization(true) }} />}

                {/* Article rendering shares the document typography, without active widgets. */}
                {selectedItem && !digestVisible && !showOrganization && (
                  <RSSArticleReader
                    reveal={selectedItem.reveal}
                    expectedRevision={selectedItem.pinnedRevision}
                    onSelectRelated={handleItemClick}
                    active={surfaceActive}
                    definitions={definitions}
                    key={selectedItem.id}
                    item={selectedItem.pinnedRevision ? selectedItem : items.find((item) => item.id === selectedItem.id) || selectedItem}
                    onClose={handleClosePreview}
                    onOpened={handleMarkItemRead}
                    onBodyLoaded={handleBodyLoaded}
                    onToggleStar={handleToggleStar}
                    notice={itemStateError?.itemId === selectedItem.id ? itemStateError.message : null}
                    onOpenOriginal={setOriginalItem}
                  />
                )}
                {originalItem && selectedItem?.id === originalItem.id && !digestVisible && !showOrganization && (
                  <PreviewBrowser key={`original:${originalItem.id}`} item={originalItem} isActive={surfaceActive} onClose={() => setOriginalItem(null)} />
                )}

                {(toastText || statusAction || notice?.action) && (
                  <div className="rss-toast rn-float" role="status">
                    {toastText ? <div>{toastText}</div> : null}
                    {notice?.action && !statusMessage ? (
                      <Button variant="ghost" size="sm" onClick={() => { notice.action!.run(); setNotice(null) }}>{notice.action.label}</Button>
                    ) : null}
                    {statusAction ? (
                      <Button variant="ghost" size="sm" icon={<ExternalLink />} onClick={() => void handleStatusAction()}>{statusAction.label}</Button>
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
            </div>
          </RSSTopbarContext.Provider>
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
    </div>
  )
}
