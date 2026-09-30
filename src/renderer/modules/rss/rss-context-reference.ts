import { formatRSSReference } from '../../../shared/rss-reference'
import { useMode } from '../../stores/useMode'
import { useRSSSession } from '../../stores/useRSSSession'
import { rssQueryKey } from './workspace-query'

/** Describe only the confirmed visible view; reads never fetch or mark an article read. */
export async function buildRSSContext(): Promise<string | null> {
  const visible = () => { const mode = useMode.getState(); return mode.workbenchMode === 'rss' || mode.splitMode === 'rss' }
  if (!visible()) return null
  const { view, query, selectedItemId } = useRSSSession.getState()
  if (!view || rssQueryKey(query) !== rssQueryKey(view.query)) return null
  const references = [formatRSSReference('当前 RSS 筛选结果', { kind: 'query', query: { ...view.query, expectedRevision: view.revision } })]
  if (selectedItemId && typeof window !== 'undefined' && window.electronAPI?.rss) {
    const result = await window.electronAPI.rss.readArticle({ itemId: selectedItemId, length: 1 })
    if (!result.success || !result.data) throw new Error('当前 RSS 文章无法读取，请稍后重新发送。')
    references.push(formatRSSReference(result.data.article.title, {
      kind: 'article', read: { itemId: selectedItemId, expectedRevision: result.data.article.revision, offset: 0, length: 12000 },
    }))
  }
  const current = useRSSSession.getState()
  if (!visible() || current.view !== view || current.selectedItemId !== selectedItemId || rssQueryKey(current.query) !== rssQueryKey(query)) return null
  return references.join('\n\n')
}
