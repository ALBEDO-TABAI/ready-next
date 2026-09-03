import { useEffect, useRef } from 'react'
import type { RSSItem } from '../../components/rss/RSSFeed'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'

interface UseRSSSelectionCommandBridgeParams {
  items: RSSItem[]
  selectedSource: string | null
  selectedItem: RSSItem | null
  handleItemClick: (item: RSSItem) => void
  setFeedSnapshot: (payload: { totalItems?: number; unreadItems?: number; lastFetchAt?: number | null }) => void
  setSelection: (payload: {
    selectedSourceId?: string | null
    selectedItemId?: string | null
    selectedItemTitle?: string | null
  }) => void
}

export function useRSSSelectionCommandBridge(params: UseRSSSelectionCommandBridgeParams): void {
  const {
    items,
    selectedSource,
    selectedItem,
    handleItemClick,
    setFeedSnapshot,
    setSelection,
  } = params
  const surfaceGeneration = useRef(0)

  useEffect(() => {
    setSelection({
      selectedSourceId: selectedSource,
      selectedItemId: selectedItem?.id ?? null,
      selectedItemTitle: selectedItem?.title ?? null,
    })
    setFeedSnapshot({
      totalItems: items.length,
      unreadItems: items.filter((item) => !item.read).length,
    })
  }, [items, selectedItem, selectedSource, setFeedSnapshot, setSelection])

  useEffect(() => {
    surfaceGeneration.current += 1
  }, [items])

  useEffect(() => {
    return registerModuleAgentHandler('rss', async ({ action, args }) => {
      if (action !== 'rss.selectItem') throw new Error('rss_renderer_action_not_supported')
      const itemId = String(args.itemId || '').trim()
      const item = items.find((candidate) => candidate.id === itemId)
      if (!item) throw new Error('rss_item_not_on_current_surface')
      const expectedSurfaceGeneration = surfaceGeneration.current
      handleItemClick(item)
      await new Promise<void>((resolveApplied) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolveApplied()))
      })
      if (surfaceGeneration.current !== expectedSurfaceGeneration) {
        throw new Error('rss_surface_generation_changed')
      }
      return {
        ok: true,
        applied: true,
        itemId: item.id,
        selectedItemId: item.id,
        surfaceGeneration: expectedSurfaceGeneration,
        summary: `已选中 RSS 条目：《${item.title}》。`,
      }
    })
  }, [handleItemClick, items])
}
