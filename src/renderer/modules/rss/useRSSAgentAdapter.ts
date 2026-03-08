import { useEffect } from 'react'
import type { RSSItem } from '../../components/rss/RSSFeed'
import { useWorkspace } from '../../stores/useWorkspace'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'
import { createRSSAgentHandler, type RSSAnalysisProgressLike } from './rss-agent-handler'

interface UseRSSAgentAdapterParams {
  items: RSSItem[]
  selectedSource: string | null
  selectedItem: RSSItem | null
  loadRSSData: () => Promise<void>
  handleRefresh: () => Promise<void>
  handleItemClick: (item: RSSItem) => void
  setFeedSnapshot: (payload: { totalItems?: number; unreadItems?: number; lastFetchAt?: number | null }) => void
  setSelection: (payload: {
    selectedSourceId?: string | null
    selectedItemId?: string | null
    selectedItemTitle?: string | null
  }) => void
  setLastAnalysis: (payload: {
    jobId?: string | null
    itemId?: string | null
    status?: string | null
    reportPath?: string | null
    manifestPath?: string | null
  }) => void
  setAnalysisProgressMap: React.Dispatch<React.SetStateAction<Record<string, RSSAnalysisProgressLike>>>
}

export function useRSSAgentAdapter(params: UseRSSAgentAdapterParams): void {
  const {
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
  } = params

  useEffect(() => {
    setSelection({
      selectedSourceId: selectedSource,
      selectedItemId: selectedItem?.id ?? null,
      selectedItemTitle: selectedItem?.title ?? null,
    })
    setFeedSnapshot({
      totalItems: items.length,
      unreadItems: items.filter((item) => !item.read).length,
      lastFetchAt: Date.now(),
    })
  }, [items, selectedItem, selectedSource, setFeedSnapshot, setSelection])

  useEffect(() => {
    return registerModuleAgentHandler(
      'rss',
      createRSSAgentHandler({
        items,
        selectedSource,
        selectedItem,
        loadRSSData,
        handleRefresh,
        handleItemClick,
        setLastAnalysis,
        setAnalysisProgressMap,
        getWorkspaceRoot: () => useWorkspace.getState().workspaceRoot,
        rssApi: window.electronAPI?.rss,
        documentApi: window.electronAPI?.document,
      }),
    )
  }, [
    handleItemClick,
    handleRefresh,
    items,
    loadRSSData,
    selectedItem,
    selectedSource,
    setAnalysisProgressMap,
    setLastAnalysis,
  ])
}
