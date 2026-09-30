import type { RSSRefreshOutcome } from './settings'
import { useEffect } from 'react'
import { useRSSSession } from '../../stores/useRSSSession'
import { rssQueryKey } from './workspace-query'
import type { RSSItem } from '../../components/rss/RSSFeed'
import { useWorkspace } from '../../stores/useWorkspace'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'
import { createRSSAgentHandler, type RSSAnalysisProgressLike } from './rss-agent-handler'

interface UseRSSAgentAdapterParams {
  isActive: boolean
  items: RSSItem[]
  selectedSource: string | null
  selectedItem: RSSItem | null
  loadRSSData: () => Promise<void>
  handleRefresh: () => Promise<RSSRefreshOutcome>
  handleItemClick: (item: RSSItem) => void
  setSelection: (payload: {
    selectedItemId?: string | null
    selectedItemTitle?: string | null
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
    setSelection,
    setAnalysisProgressMap,
  } = params

  useEffect(() => {
    setSelection({
      selectedItemId: selectedItem?.id ?? null,
      selectedItemTitle: selectedItem?.title ?? null,
    })
  }, [selectedItem, setSelection])

  useEffect(() => {
    return registerModuleAgentHandler(
      'rss',
      createRSSAgentHandler({
        items,
        getView: () => {
          const state = useRSSSession.getState()
          return params.isActive && state.view && rssQueryKey(state.view.query) === rssQueryKey(state.query) ? state.view : null
        },
        selectedSource,
        selectedItem,
        loadRSSData,
        handleRefresh,
        handleItemClick,
            setAnalysisProgressMap,
        getWorkspaceRoot: () => useWorkspace.getState().workspaceRoot,
        rssApi: window.electronAPI?.rss,
        documentApi: window.electronAPI?.document,
      }),
    )
  }, [
    params.isActive,
    handleItemClick,
    handleRefresh,
    items,
    loadRSSData,
    selectedItem,
    selectedSource,
    setAnalysisProgressMap,
  ])
}
