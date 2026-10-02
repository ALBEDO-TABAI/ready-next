import { useEffect, useRef } from 'react'
import type { RSSItem } from '../../components/rss/RSSFeed'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'
import { toRSSItem, rssQueryKey } from './workspace-query'
import { useRSSSession } from '../../stores/useRSSSession'

export function useRSSSelectionCommandBridge(params: {
  active: boolean
  selectedItem: RSSItem | null
  handleItemClick(item: RSSItem): void
}): void {
  const { active, selectedItem, handleItemClick } = params
  const generation = useRef(0)
  useEffect(() => {
    useRSSSession.getState().setSelection({ selectedItemId: selectedItem?.id || null, selectedItemTitle: selectedItem?.title || null,
      selectedExcerpt: selectedItem?.reveal?.range || null, selectedItemExpectedRevision: selectedItem?.pinnedRevision || selectedItem?.revision || null })
  }, [selectedItem])
  // Showing or hiding the surface invalidates a selection that is still reading.
  useEffect(() => { generation.current++ }, [active])
  // Registered while RSS is mounted, as in 0.8: an Agent selection made from another mode
  // lands here without switching the visible workbench.
  useEffect(() => {
    const unregister = registerModuleAgentHandler('rss', async ({ action, args }) => {
      if (action !== 'rss.selectItem') throw new Error('rss_renderer_action_not_supported')
      const incarnation = generation.current
      const itemId = String(args.itemId || '').trim(), query = rssQueryKey(useRSSSession.getState().query)
      const interaction = useRSSSession.getState().interactionRevision
      const response = await window.electronAPI.rss.readArticle({ itemId, offset: 0, length: 1 })
      if (generation.current !== incarnation || useRSSSession.getState().interactionRevision !== interaction || rssQueryKey(useRSSSession.getState().query) !== query) throw new Error('rss_surface_generation_changed')
      if (!response.success || !response.data) throw new Error(response.error || 'rss_item_unavailable')
      handleItemClick(toRSSItem(response.data.article))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (generation.current !== incarnation || useRSSSession.getState().selectedItemId !== itemId) throw new Error('rss_selection_not_applied')
      return { ok: true, applied: true, itemId, selectedItemId: itemId, surfaceGeneration: incarnation, summary: `已选中 RSS 条目：《${response.data.article.title}》。` }
    })
    return () => { generation.current++; unregister() }
  }, [handleItemClick])
}
