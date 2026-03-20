import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { RefreshCw, AlertCircle } from 'lucide-react'
import RSSFeed from '../../components/rss/RSSFeed'
import PreviewBrowser from '../../components/rss/PreviewBrowser'
import AddSourceModal from '../../components/rss/AddSourceModal'
import { useRSSAgentAdapter } from '../../modules/rss/useRSSAgentAdapter'
import { WORKBENCH_SUPPORT_PANEL_WIDTH } from '../../modules/workbench/chrome'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSItem, RSSSource } from '../../components/rss/RSSFeed'

const AUTO_REFRESH_INTERVAL = 15 * 60 * 1000 // 15 minutes

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

export default function RSSMode({ isActive = true }: { isActive?: boolean }) {
  const selectedSourceId = useRSSSession((state) => state.selectedSourceId)
  const setFeedSnapshot = useRSSSession((state) => state.setFeedSnapshot)
  const setSelection = useRSSSession((state) => state.setSelection)
  const setLastAnalysis = useRSSSession((state) => state.setLastAnalysis)
  const selectedSource = selectedSourceId
  const [items, setItems] = useState<RSSItem[]>([])
  const [sources, setSources] = useState<RSSSource[]>([])
  const [selectedItem, setSelectedItem] = useState<RSSItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all')
  const [isMock, setIsMock] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [newItemIds, setNewItemIds] = useState<Set<string>>(new Set())
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [analysisProgressMap, setAnalysisProgressMap] = useState<Record<string, RSSItemAnalysisProgressState>>({})
  const [analysisJobs, setAnalysisJobs] = useState<RSSAnalysisJobState[]>([])
  const [hasHydrated, setHasHydrated] = useState(false)
  const previousItemIdsRef = useRef<Set<string>>(new Set())
  const sourcesRef = useRef<RSSSource[]>([])
  const becameVisibleRef = useRef(false)
  const shouldPoll = isActive && hasHydrated

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

  const loadRSSData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.rss.getItems()
        if (result.success === false) {
          setError(result.error || '获取 RSS 项目失败')
          setItems([])
        } else if (result.data) {
          const newItems: RSSItem[] = result.data.map((item) => ({
            id: item.id,
            sourceId: item.sourceId,
            title: item.title,
            link: item.link,
            summary: item.summary ?? '',
            author: item.author ?? '',
            source: item.source ?? '',
            publishedAt: item.publishedAt ? new Date(item.publishedAt).toLocaleString() : '',
            read: item.read,
            starred: item.starred,
            coverImage: item.coverImage ?? undefined,
          }))

          // Track newly arrived items
          if (previousItemIdsRef.current.size > 0) {
            const freshIds = new Set<string>()
            for (const item of newItems) {
              if (!previousItemIdsRef.current.has(item.id)) {
                freshIds.add(item.id)
              }
            }
            if (freshIds.size > 0) {
              setNewItemIds(freshIds)
              // Clear new indicator after 30 seconds
              setTimeout(() => setNewItemIds(new Set()), 30000)
            }
          }
          previousItemIdsRef.current = new Set(newItems.map(i => i.id))
          setItems(newItems)
          setIsMock(result.mock || false)

          // Compute source counts from actual unread items
          const sourcesResult = await window.electronAPI.rss.getSources()
          if (sourcesResult.success === false) {
            setError(prev => prev || sourcesResult.error || '获取 RSS 源失败')
            setSources([])
          } else if (sourcesResult.data) {
            const unreadCounts = computeUnreadCounts(newItems)
            setSources(sourcesResult.data.map((s) => ({
              id: s.id,
              name: s.name,
              count: unreadCounts.get(s.id) ?? 0,
              platform: s.platform,
              url: s.url,
            })))
          }
        } else {
          // No data but success — load sources anyway
          const sourcesResult = await window.electronAPI.rss.getSources()
          if (sourcesResult.success !== false && sourcesResult.data) {
            setSources(sourcesResult.data.map((s) => ({
              id: s.id,
              name: s.name,
              count: 0,
              platform: s.platform,
              url: s.url,
            })))
          }
        }
      } else {
        setIsMock(true)
        setItems([
          {
            id: '1', sourceId: '1', title: 'AI 创作工具的下一个十年',
            link: 'https://36kr.com/p/123456', summary: '探讨 AI 如何改变内容创作行业...',
            source: '36氪', publishedAt: new Date(Date.now() - 3600000).toLocaleString(),
            read: false, starred: false,
          },
          {
            id: '2', sourceId: '2', title: '自媒体运营的核心方法论',
            link: 'https://www.huxiu.com/article/789', summary: '从 0 到 1 打造个人 IP 的实战经验...',
            source: '虎嗅', publishedAt: new Date(Date.now() - 7200000).toLocaleString(),
            read: false, starred: true,
          },
        ])
        setSources([
          { id: '1', name: '36氪', count: 15 },
          { id: '2', name: '虎嗅', count: 12 },
        ])
        previousItemIdsRef.current = new Set(['1', '2'])
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '加载 RSS 数据时发生错误'
      console.log('RSS data load error:', err)
      setError(errorMessage)
      setItems([])
      setSources([])
    } finally {
      setLoading(false)
    }
  }, [computeUnreadCounts])

  useEffect(() => {
    if (!isActive) {
      becameVisibleRef.current = false
      return
    }

    if (becameVisibleRef.current) return
    becameVisibleRef.current = true
    let cancelled = false

    const syncVisibleData = async () => {
      await loadRSSData()
      if (!cancelled && !hasHydrated) {
        setHasHydrated(true)
      }
    }

    void syncVisibleData()
    return () => {
      cancelled = true
    }
  }, [hasHydrated, isActive, loadRSSData])

  const fetchAnalysisProgress = useCallback(async (itemIds: string[]): Promise<boolean> => {
    if (!window.electronAPI?.rss?.getItemAnalysisProgress) return false
    if (itemIds.length === 0) {
      setAnalysisProgressMap({})
      return false
    }

    try {
      const result = await window.electronAPI.rss.getItemAnalysisProgress({ itemIds })
      if (!result.success || !result.data) return false
      setAnalysisProgressMap(result.data as Record<string, RSSItemAnalysisProgressState>)
      return Object.values(result.data).some(
        (entry) => entry.status === 'queued' || entry.status === 'running_script' || entry.status === 'running_subagent',
      )
    } catch {
      return false
    }
  }, [])

  const fetchAnalysisJobs = useCallback(async () => {
    if (!window.electronAPI?.rss?.listItemAnalysisJobs) return
    try {
      const result = await window.electronAPI.rss.listItemAnalysisJobs({ limit: 120 })
      if (!result.success || !result.data) return
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
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    if (!shouldPoll) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const running = await fetchAnalysisProgress(visibleItemIds)
      await fetchAnalysisJobs()
      if (disposed) return
      timer = setTimeout(tick, running ? 1400 : 9000)
    }

    void tick()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [fetchAnalysisJobs, fetchAnalysisProgress, shouldPoll, visibleItemIds])

  // Task 6: Auto-refresh every 15 minutes
  useEffect(() => {
    if (!shouldPoll) return
    const interval = setInterval(async () => {
      try {
        await window.electronAPI?.rss?.fetchAll()
        await loadRSSData()
      } catch {
        // silent fail on auto-refresh
      }
    }, AUTO_REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [loadRSSData, shouldPoll])

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

  const handleItemClick = useCallback((item: RSSItem) => {
    setSelectedItem(item)
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
  }, [computeUnreadCounts])

  const handleToggleStar = useCallback((itemId: string) => {
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, starred: !i.starred } : i))
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.rss.toggleStarred(itemId)
    }
  }, [])

  // Task 6: Manual refresh with loading state
  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const latestSelectedSourceId = useRSSSession.getState().selectedSourceId
        const selectedSourceEntry = latestSelectedSourceId
          ? sourcesRef.current.find((source) => source.id === latestSelectedSourceId) ?? null
          : null

        if (selectedSourceEntry) {
          const result = await window.electronAPI.rss.refreshSource(selectedSourceEntry.id)
          if (!result.success) {
            setStatusMessage(result.error || '刷新失败')
          } else if (result.data?.running) {
            setStatusMessage(`${selectedSourceEntry.name} 正在刷新中`)
          } else if (result.data?.errors?.length) {
            setStatusMessage(`${selectedSourceEntry.name} 刷新完成，但存在错误：${result.data.errors[0]}`)
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
    const deleteIds = scoped.map((item) => item.id)
    if (deleteIds.length === 0) {
      setStatusMessage('当前范围内没有可清空的内容')
      return
    }

    const deleteSet = new Set(deleteIds)
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
      for (const id of deleteIds) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
    setSelectedItem((prev) => (prev && deleteSet.has(prev.id) ? null : prev))

    await window.electronAPI?.rss?.deleteItems(deleteIds)
    setStatusMessage(`已清空 ${deleteIds.length} 条内容`)
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
      await window.electronAPI?.rss?.deleteItems([itemId])
    },
    [computeUnreadCounts],
  )

  const handleDownloadItem = useCallback(async (item: RSSItem) => {
    void item
    if (!window.electronAPI?.document?.openFolder) {
      setStatusMessage('当前环境暂不支持选择下载目录')
      return false
    }
    const result = await window.electronAPI.document.openFolder()
    if (!result.success || !result.path) {
      if (result.error) {
        setStatusMessage(`目录选择失败：${result.error}`)
      }
      return false
    }
    setStatusMessage(`已选择目录：${result.path}`)
    return true
  }, [])

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

  const handleAddSourceSuccess = useCallback(() => {
    loadRSSData()
  }, [loadRSSData])

  // Error state
  if (error && !loading && items.length === 0) {
    return (
      <div className="workbench-mode-root items-center justify-center">
        <div className="text-center p-8">
          <AlertCircle className="w-16 h-16 mx-auto mb-4 text-[var(--color-red)]" />
          <h3 className="text-[16px] font-semibold text-[var(--text-title)] mb-2">加载失败</h3>
          <p className="text-[13px] text-[var(--text-muted)] mb-4 max-w-[300px]">{error}</p>
          <button
            onClick={loadRSSData}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-blue)] text-white text-[13px] hover:brightness-95 transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="workbench-mode-root rss-mode-shell" style={{ background: 'color-mix(in srgb, var(--bg-content) 18%, transparent)' }}>
      <div className="flex-1 min-h-0 px-3 pb-3 pt-2">
        <div
          className="workbench-canvas-shell flex h-full min-h-0 overflow-hidden"
          style={{ background: 'color-mix(in srgb, var(--bg-content) 18%, transparent)' }}
        >
          {/* Feed list (shrinks when preview is open) */}
          <div
            className={`rss-feed-sheet content-surface-panel flex-shrink-0 overflow-hidden flex flex-col transition-all duration-300 relative ${
              selectedItem ? 'border-r border-[var(--border-default)]' : 'flex-1'
            }`}
            style={{
              width: selectedItem ? WORKBENCH_SUPPORT_PANEL_WIDTH : undefined,
              minWidth: selectedItem ? WORKBENCH_SUPPORT_PANEL_WIDTH : undefined,
              background: 'color-mix(in srgb, var(--bg-content) 18%, transparent)',
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
              onDownloadItem={handleDownloadItem}
              onOpenAnalysisOutput={handleOpenAnalysisOutput}
              onRefresh={handleRefresh}
              onAddSource={() => setShowAddModal(true)}
              onClearRead={handleClearRead}
              onPauseAnalysisJob={handlePauseAnalysisJob}
              onResumeAnalysisJob={handleResumeAnalysisJob}
              onDeleteAnalysisJob={handleDeleteAnalysisJob}
            />
            {statusMessage && (
              <div
                className="glass-surface-floating absolute top-[62px] right-4 z-20 rounded-lg px-3 py-2 text-[12px]"
                style={{
                  background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-secondary)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {statusMessage}
              </div>
            )}
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
      />
    </div>
  )
}
