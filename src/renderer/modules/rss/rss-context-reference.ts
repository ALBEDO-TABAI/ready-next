import { formatRSSReference } from '../../../shared/rss-reference'
import { useMode } from '../../stores/useMode'
import { useRSSSession } from '../../stores/useRSSSession'
import { rssQueryKey } from './workspace-query'

/** Describe only the confirmed visible view; reads never fetch or mark an article read. */
export async function buildRSSContext(): Promise<string | null> {
  const visible = () => { const mode = useMode.getState(); return mode.workbenchMode === 'rss' || mode.splitMode === 'rss' }
  if (!visible()) return null
  const { view, query, selectedItemId, selectedItemExpectedRevision, selectedExcerpt, digestVisible, selectedDigestId } = useRSSSession.getState()
  if (digestVisible) {
    if (!selectedDigestId) return null
    const result = await window.electronAPI.rss.readDigests({ view: 'entries', reportId: selectedDigestId, limit: 1 })
    if (!result.success || result.data?.view !== 'entries') throw new Error('当前刊物无法读取。')
    const current = useRSSSession.getState()
    if (!visible() || !current.digestVisible || current.selectedDigestId !== selectedDigestId) return null
    return formatRSSReference('当前 RSS 刊物', { kind: 'digest', read: { reportId: selectedDigestId, offset: 0, limit: 20 } })
  }
  if (selectedItemId && selectedItemExpectedRevision && selectedExcerpt) {
    const read = { format: 'reading-v1' as const, itemId: selectedItemId, expectedRevision: selectedItemExpectedRevision, range: selectedExcerpt, offset: 0, length: 12000 }
    const result = await window.electronAPI.rss.readExcerpt({ ...read, length: 1 })
    if (!result.success || !result.data) throw new Error('当前引用位置已变化，请重新引用。')
    const current = useRSSSession.getState()
    if (!visible() || current.digestVisible || current.selectedItemId !== selectedItemId || current.selectedItemExpectedRevision !== selectedItemExpectedRevision || current.selectedExcerpt !== selectedExcerpt) return null
    return formatRSSReference(`${result.data.article.title} · 当前定位选区`, { kind: 'excerpt', read })
  }
  if (!view || rssQueryKey(query) !== rssQueryKey(view.query)) return null
  const references = [formatRSSReference('当前 RSS 筛选结果', { kind: 'query', query: { ...view.query, expectedRevision: view.revision } })]
  if (selectedItemId && typeof window !== 'undefined' && window.electronAPI?.rss) {
    const result = await window.electronAPI.rss.readArticle({ itemId: selectedItemId, expectedRevision: selectedItemExpectedRevision || undefined, length: 1 })
    if (!result.success || !result.data) throw new Error('当前 RSS 文章无法读取，请稍后重新发送。')
    references.push(formatRSSReference(result.data.article.title, {
      kind: 'article', read: { itemId: selectedItemId, expectedRevision: result.data.article.revision, offset: 0, length: 12000 },
    }))
  }
  const current = useRSSSession.getState()
  if (!visible() || current.digestVisible || current.view !== view || current.selectedItemId !== selectedItemId || current.selectedItemExpectedRevision !== selectedItemExpectedRevision || current.selectedExcerpt !== selectedExcerpt || rssQueryKey(current.query) !== rssQueryKey(query)) return null
  return references.join('\n\n')
}
