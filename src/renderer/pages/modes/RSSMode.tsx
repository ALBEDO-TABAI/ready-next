import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, AlertCircle, ExternalLink } from 'lucide-react'
import RSSFeed from '../../components/rss/RSSFeed'
import PreviewBrowser from '../../components/rss/PreviewBrowser'
import AddSourceModal from '../../components/rss/AddSourceModal'
import RSSSettingsPanel from '../../components/rss/RSSSettingsPanel'
import Modal from '../../components/ui/Modal'
import { useModal } from '../../components/ui/useModal'
import { useRSSAgentAdapter } from '../../modules/rss/useRSSAgentAdapter'
import { fetchRSSWarmSnapshot } from '../../modules/rss/rssWarmLoader'
import { getRSSWarmCache, primeRSSWarmCache, setRSSWarmCache } from '../../modules/rss/rssWarmCache'
import {
  DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS,
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
import { useMode } from '../../stores/useMode'
import { useRSSSession } from '../../stores/useRSSSession'
import { isWorkbenchModePairActive } from '../../modules/workbench/mode-split'
import { openRSSItemInBrowserTab } from '../../modules/rss/open-rss-item-in-browser'
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
  isMotionSettled?: boolean
}

interface AddSourceDraftState {
  browserPresetUrl: string
  browserPresetName: string
  browserPresetLabel: string | null
}

interface RSSModeSnapshot {
  items: RSSItem[]
  sources: RSSSource[]
  isMock: boolean
  fetchedAt: number
}

export default function RSSMode({
  isActive = true,
  isMotionSettled = true,
}: RSSModeProps) {
  const navigate = useNavigate()
  const initialWarmCache = useMemo(() => getRSSWarmCache(), [])
  const selectedSourceId = useRSSSession((state) => state.selectedSourceId)
  const setFeedSnapshot = useRSSSession((state) => state.setFeedSnapshot)
  const setSelection = useRSSSession((state) => state.setSelection)
  const setLastAnalysis = useRSSSession((state) => state.setLastAnalysis)
  const browserTabs = useBrowserTabs((state) => state.tabs)
  const activeBrowserTabId = useBrowserTabs((state) => state.activeTabId)
  const workbenchMode = useMode((state) => state.workbenchMode)
  const splitMode = useMode((state) => state.splitMode)
  const selectedSource = selectedSourceId
  const [items, setItems] = useState<RSSItem[]>(() => initialWarmCache?.items || [])
  const [sources, setSources] = useState<RSSSource[]>(() => initialWarmCache?.sources || [])
  const [selectedItem, setSelectedItem] = useState<RSSItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all')
  const [isMock, setIsMock] = useState(() => initialWarmCache?.isMock || false)
  const [error, setError] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [autoRefreshIntervalMs, setAutoRefreshIntervalMs] = useState(DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS)
  const [addSourceDraft, setAddSourceDraft] = useState<AddSourceDraftState>({
    browserPresetUrl: '',
    browserPresetName: '',
    browserPresetLabel: null,
  })
  const [newItemIds, setNewItemIds] = useState<Set<string>>(new Set())
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [statusAction, setStatusAction] = useState<RSSBrowserOpenActionData | null>(null)
  const [backgroundWarning, setBackgroundWarning] = useState<string | null>(null)
  const [analysisProgressMap, setAnalysisProgressMap] = useState<Record<string, RSSItemAnalysisProgressState>>({})
  const [analysisJobs, setAnalysisJobs] = useState<RSSAnalysisJobState[]>([])
  const [hasHydrated, setHasHydrated] = useState(() => Boolean(initialWarmCache))
  const previousItemIdsRef = useRef<Set<string>>(new Set(initialWarmCache?.items.map((item) => item.id) || []))
  const sourcesRef = useRef<RSSSource[]>([])
  const becameVisibleRef = useRef(false)
  const lastModalActionKeyRef = useRef<string | null>(null)
  const shouldPoll = isActive && hasHydrated
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
  const shouldOpenItemsInBrowserPane = isWorkbenchModePairActive({
    workbenchMode,
    splitMode,
    firstMode: 'browser',
    secondMode: 'rss',
  })

  const computeUnreadCounts = useCallback((list: RSSItem[]) => {
    const counts = new Map<string, number>()
    for (const item of list) {
      if (!item.read) {
        counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1)
      }
    }
    return counts
  }, [])

  const getScopedItems = useCallback(
    (list: RSSItem[]) =>
      list.filter((item) => {
        if (selectedSource && item.sourceId !== selectedSource) return false
        if (filter === 'unread' && item.read) return false
        if (filter === 'starred' && !item.starred) return false
        return true
      }),
    [filter, selectedSource],
  )

  const visibleItemIds = useMemo(() => {
    return getScopedItems(items)
      .map((item) => item.id)
      .slice(0, 240)
  }, [getScopedItems, items])

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

  const applyRSSSnapshot = useCallback((snapshot: RSSModeSnapshot) => {
    setItems(snapshot.items)
    setSources(snapshot.sources)
    setIsMock(snapshot.isMock)
    previousItemIdsRef.current = new Set(snapshot.items.map((item) => item.id))
  }, [])

  const loadRSSSnapshot = useCallback(async () => {
    try {
      return await fetchRSSWarmSnapshot()
    } catch (err) {
      throw (err instanceof Error ? err : new Error('加载 RSS 数据时发生错误'))
    }
  }, [])

  const loadRSSData = useCallback(async (options?: { background?: boolean }) => {
    if (!options?.background) {
      setLoading(true)
    }
    setError(null)
    try {
      const snapshot = await loadRSSSnapshot()

      if (previousItemIdsRef.current.size > 0) {
        const freshIds = new Set<string>()
        for (const item of snapshot.items) {
          if (!previousItemIdsRef.current.has(item.id)) {
            freshIds.add(item.id)
          }
        }
        if (freshIds.size > 0) {
          setNewItemIds(freshIds)
          setTimeout(() => setNewItemIds(new Set()), 30000)
        }
      }

      applyRSSSnapshot(snapshot)
      setRSSWarmCache(snapshot)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '加载 RSS 数据时发生错误'
      console.log('RSS data load error:', err)
      setError(errorMessage)
      if (!options?.background) {
        setItems([])
        setSources([])
      }
    } finally {
      if (!options?.background) {
        setLoading(false)
      }
    }
  }, [applyRSSSnapshot, loadRSSSnapshot])

  const warmRefreshRSSData = useCallback(() => {
    void loadRSSData({ background: true })
  }, [loadRSSData])

  useEffect(() => {
    let cancelled = false
    // fire-and-forget: warm-cache snapshot prime on mode switch; if it fails, the next loadRSSData (`warmRefreshRSSData`) refresh cycle will hydrate the panel.
    void primeRSSWarmCache(loadRSSSnapshot)
      .then((snapshot) => {
        if (cancelled) return
        applyRSSSnapshot(snapshot)
        if (!hasHydrated) {
          setHasHydrated(true)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [applyRSSSnapshot, hasHydrated, loadRSSSnapshot])

  useEffect(() => {
    if (!isActive) {
      becameVisibleRef.current = false
      return
    }

    if (becameVisibleRef.current) return
    becameVisibleRef.current = true
    let cancelled = false

    const syncVisibleData = async () => {
      const cachedSnapshot = getRSSWarmCache()
      if (cachedSnapshot) {
        applyRSSSnapshot(cachedSnapshot)
        if (!cancelled && !hasHydrated) {
          setHasHydrated(true)
        }
        warmRefreshRSSData()
        return
      }
      await loadRSSData()
      if (!cancelled && !hasHydrated) {
        setHasHydrated(true)
      }
    }

    void syncVisibleData()
    return () => {
      cancelled = true
    }
  }, [applyRSSSnapshot, hasHydrated, isActive, loadRSSData])

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
      setBackgroundWarning(pollState.backgroundWarning)
      if (disposed) return
      timer = setTimeout(tick, pollState.nextDelayMs)
    }

    void tick()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [fetchAnalysisJobs, fetchAnalysisProgress, shouldPoll, visibleItemIds])

  // Auto-refresh interval is user-configurable, preserving 15 minutes as the upgrade default.
  useEffect(() => {
    if (!shouldPoll) return
    if (autoRefreshIntervalMs <= 0) return
    const interval = setInterval(async () => {
      try {
        await window.electronAPI?.rss?.fetchAll()
        await loadRSSData()
        setBackgroundWarning(null)
      } catch {
        setBackgroundWarning('RSS 自动刷新失败，稍后会再次尝试。')
      }
    }, autoRefreshIntervalMs)
    return () => clearInterval(interval)
  }, [autoRefreshIntervalMs, loadRSSData, shouldPoll])

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

  useEffect(() => {
    if (!selectedItem) return
    const stillExists = items.some((item) => item.id === selectedItem.id)
    if (!stillExists) {
      setSelectedItem(null)
    }
  }, [items, selectedItem])

  useEffect(() => {
    if (!selectedSourceId) return
    const stillExists = sources.some((source) => source.id === selectedSourceId)
    if (!stillExists) {
      setSelection({ selectedSourceId: null })
    }
  }, [selectedSourceId, setSelection, sources])

  const handleSourceChange = useCallback((sourceId: string | null) => {
    setSelection({ selectedSourceId: sourceId })
  }, [setSelection])

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
    // `removeRSSSource` cascades to the source's items, so drop both from
    // local state to mirror main. The selectedSourceId effect resets the
    // filter to 全部源 when the active source disappears, so selection needs
    // no explicit handling here.
    setItems((prev) => prev.filter((item) => item.sourceId !== sourceId))
    setSources((prev) => prev.filter((source) => source.id !== sourceId))
    setSelectedItem((prev) => (prev?.sourceId === sourceId ? null : prev))
  }, [])

  const handleItemClick = useCallback((item: RSSItem) => {
    if (shouldOpenItemsInBrowserPane) {
      setSelectedItem(null)
      void openRSSItemInBrowserTab(item).then((opened) => {
        if (!opened) setSelectedItem(item)
      })
    } else {
      setSelectedItem(item)
    }
    // Mark as read locally
    setItems((prev) => {
      const next = prev.map((i) => (i.id === item.id ? { ...i, read: true } : i))
      const unreadCounts = computeUnreadCounts(next)
      setSources((prevSources) =>
        prevSources.map((source) => ({ ...source, count: unreadCounts.get(source.id) ?? 0 })),
      )
      return next
    })
    // Remove from new items
    setNewItemIds(prev => {
      if (prev.has(item.id)) {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      }
      return prev
    })
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.rss.markRead(item.id)
    }
  }, [computeUnreadCounts, shouldOpenItemsInBrowserPane])

  const handleToggleStar = useCallback((itemId: string) => {
    setItems(prev => {
      const current = prev.find((entry) => entry.id === itemId)
      if (!current) return prev
      const nextStarred = !current.starred
      const next = prev
        .map(i => i.id === itemId ? { ...i, starred: nextStarred } : i)
        .filter((entry) => !(entry.id === itemId && !nextStarred && entry.inboxVisible === false))
      const unreadCounts = computeUnreadCounts(next)
      setSources((prevSources) =>
        prevSources.map((source) => ({ ...source, count: unreadCounts.get(source.id) ?? 0 })),
      )
      return next
    })
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.rss.toggleStarred(itemId)
    }
  }, [computeUnreadCounts])

  // Task 6: Manual refresh with loading state
  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    setStatusAction(null)
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const latestSelectedSourceId = useRSSSession.getState().selectedSourceId
        const selectedSourceEntry = latestSelectedSourceId
          ? sourcesRef.current.find((source) => source.id === latestSelectedSourceId) ?? null
          : null
        setStatusMessage(
          selectedSourceEntry
            ? `${selectedSourceEntry.name} 正在刷新…`
            : '正在刷新全部 RSS 源…',
        )

        if (selectedSourceEntry) {
          const result = await window.electronAPI.rss.refreshSource(selectedSourceEntry.id)
          if (!result.success) {
            setStatusMessage(result.error || '刷新失败')
            setStatusAction(result.data?.browserAction || null)
          } else if (result.data?.running) {
            setStatusMessage(`${selectedSourceEntry.name} 正在刷新中`)
          } else if (result.data?.errors?.length) {
            setStatusMessage(`${selectedSourceEntry.name} 刷新完成，但存在错误：${result.data.errors[0]}`)
            setStatusAction(result.data?.browserAction || null)
          } else if (typeof result.data?.itemCount === 'number') {
            const writtenLabel = typeof result.data?.fetched === 'number'
              ? `，写入 ${result.data.fetched} 条`
              : ''
            setStatusMessage(`${selectedSourceEntry.name} 已刷新，共 ${result.data.itemCount} 条${writtenLabel}`)
          } else {
            setStatusMessage(result.data?.message || `${selectedSourceEntry.name} 已刷新`)
          }
        } else {
          const result = await window.electronAPI.rss.fetchAll()
          if (!result.success) {
            setStatusMessage(result.error || '刷新失败')
          } else if (result.data?.running) {
            setStatusMessage(result.data.message || 'RSS 正在刷新中')
          } else if (result.data?.errors?.length) {
            setStatusMessage(`刷新完成，但存在错误：${result.data.errors[0]}`)
          } else {
            setStatusMessage(result.data?.message || '刷新完成')
          }
        }
      }
      await loadRSSData()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [loadRSSData, refreshing])

  const handleStatusAction = useCallback(async () => {
    if (!statusAction?.url) return
    await window.electronAPI?.browser?.openForCaptureTarget(statusAction.url)
  }, [statusAction])

  const handleOpenExternalServices = useCallback(() => {
    navigate('/settings?section=external-services')
  }, [navigate])

  useRSSAgentAdapter({
    items,
    selectedSource,
    selectedItem,
    loadRSSData,
    handleRefresh,
    handleItemClick,
    setFeedSnapshot,
    setSelection,
    setLastAnalysis,
    setAnalysisProgressMap,
  })

  const handleMarkItemRead = useCallback(
    async (itemId: string) => {
      const item = items.find((entry) => entry.id === itemId)
      if (!item || item.read) return
      setItems((prev) => {
        const next = prev.map((entry) => (entry.id === itemId ? { ...entry, read: true } : entry))
        const unreadCounts = computeUnreadCounts(next)
        setSources((prevSources) =>
          prevSources.map((source) => ({ ...source, count: unreadCounts.get(source.id) ?? 0 })),
        )
        return next
      })
      await window.electronAPI?.rss?.markRead(itemId)
    },
    [computeUnreadCounts, items],
  )

  const handleClearRead = useCallback(async () => {
    const scoped = getScopedItems(items)
    const hideIds = scoped.filter((item) => !item.starred).map((item) => item.id)
    const preservedStarredCount = scoped.length - hideIds.length
    if (hideIds.length === 0) {
      setStatusMessage('当前范围内没有可清空的内容')
      return
    }

    const deleteSet = new Set(hideIds)
    setItems((prev) => {
      const next = prev.filter((item) => !deleteSet.has(item.id))
      const unreadCounts = computeUnreadCounts(next)
      setSources((prevSources) =>
        prevSources.map((source) => ({ ...source, count: unreadCounts.get(source.id) ?? 0 })),
      )
      return next
    })
    setNewItemIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of hideIds) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
    setSelectedItem((prev) => (prev && deleteSet.has(prev.id) ? null : prev))

    await window.electronAPI?.rss?.deleteItems({ itemIds: scoped.map((item) => item.id), preserveStarred: true })
    setStatusMessage(
      preservedStarredCount > 0
        ? `已清空 ${hideIds.length} 条内容，保留 ${preservedStarredCount} 条收藏`
        : `已清空 ${hideIds.length} 条内容`,
    )
  }, [computeUnreadCounts, getScopedItems, items])

  const handleDeleteItem = useCallback(
    async (itemId: string) => {
      const deleteSet = new Set([itemId])
      setItems((prev) => {
        const next = prev.filter((item) => !deleteSet.has(item.id))
        const unreadCounts = computeUnreadCounts(next)
        setSources((prevSources) =>
          prevSources.map((source) => ({ ...source, count: unreadCounts.get(source.id) ?? 0 })),
        )
        return next
      })
      setNewItemIds((prev) => {
        if (!prev.has(itemId)) return prev
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
      setSelectedItem((prev) => (prev?.id === itemId ? null : prev))
      await window.electronAPI?.rss?.deleteItems({ itemIds: [itemId], preserveStarred: false })
    },
    [computeUnreadCounts],
  )

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

  const handleAddSourceSuccess = useCallback((source?: AddSourceSuccessInfo) => {
    void loadRSSData().then(() => {
      if (source?.id) {
        setSelection({
          selectedSourceId: source.id,
          selectedItemId: null,
          selectedItemTitle: null,
        })
      }
      const statusMessage = getRSSAddSourceStatusMessage(source)
      if (statusMessage) setStatusMessage(statusMessage)
    })
  }, [loadRSSData, setSelection])

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
          {/* Feed list keeps its full width; preview floats above it */}
          <div
            className={`rss-feed-sheet content-surface-panel flex-1 overflow-hidden flex flex-col relative`}
            style={{
              background: 'var(--workbench-module-surface-bg)',
            }}
          >
            <RSSFeed
              items={items}
              sources={sources}
              filter={filter}
              selectedSource={selectedSource}
              selectedItemId={selectedItem?.id ?? null}
              loading={loading}
              refreshing={refreshing}
              isMock={isMock}
              hasPreview={!!selectedItem}
              newItemIds={newItemIds}
              analysisProgressMap={analysisProgressMap}
              analysisJobs={analysisJobs}
              onFilterChange={setFilter}
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
            />
            {(statusMessage || backgroundWarning || statusAction) && (
              <div
                className="glass-surface-floating absolute top-[62px] right-4 z-20 rounded-lg px-3 py-2 text-[12px]"
                style={{
                  background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-secondary)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {statusMessage || backgroundWarning ? (
                  <div>{statusMessage || backgroundWarning}</div>
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
              onAutoRefreshIntervalChange={setAutoRefreshIntervalMs}
              onClose={() => setSettingsOpen(false)}
              onReloadData={() => loadRSSData({ background: true })}
              onOpenExternalServices={handleOpenExternalServices}
            />
          </div>

          {/* Preview Browser */}
          {selectedItem && (
            <PreviewBrowser
              item={selectedItem}
              onClose={handleClosePreview}
              isActive={isActive}
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
