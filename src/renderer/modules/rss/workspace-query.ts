import { RSSQuerySchema, type RSSArticleSummary, type RSSQueryInput, type RSSQueryResult } from '../../../shared/rss-workspace'
import type { RSSDefinition } from '../../../shared/rss-organization'
import type { RSSItem } from '../../components/rss/RSSFeed'

export function rssQueryKey(input: RSSQueryInput): string {
  const { cursor: _cursor, expectedRevision: _revision, ...query } = RSSQuerySchema.parse(input)
  return JSON.stringify(query)
}

export function toRSSItem(item: Omit<RSSArticleSummary, 'summary' | 'classifications' | 'coverImage'> & Partial<Pick<RSSArticleSummary, 'summary' | 'classifications' | 'coverImage'>>): RSSItem {
  return { ...item, summary: item.summary || '', author: item.author || '', coverImage: item.coverImage || undefined,
    publishedAtMs: item.publishedAt, collectedAt: item.collectedAt,
    publishedAt: item.publishedAt === null ? '' : new Date(item.publishedAt).toLocaleString() }
}

export interface RSSQueryAPI {
  queryItems(query: RSSQueryInput): Promise<{ success: boolean; data?: RSSQueryResult; error?: string }>
}

/** Rebuild the already-visible window after a mutation without mixing revisions. */
export async function readRSSWindow(api: RSSQueryAPI, input: RSSQueryInput, count: number): Promise<RSSQueryResult> {
  const { cursor: _cursor, expectedRevision: _revision, ...query } = RSSQuerySchema.parse(input)
  let result: RSSQueryResult | undefined
  do {
    const response = await api.queryItems({ ...query, ...(result ? { cursor: result.nextCursor!, expectedRevision: result.revision } : {}) })
    if (!response.success || !response.data) throw new Error(response.error || '资讯读取失败')
    result = result ? { ...response.data, items: [...result.items, ...response.data.items] } : response.data
  } while (result.nextCursor && result.items.length < count)
  return result
}

/** A remembered column or category can disappear outside this view (another window, a restored database); fall back instead of querying a missing id. */
export function staleDefinitionFallback(query: RSSQueryInput, definitions: readonly RSSDefinition[]): Partial<RSSQueryInput> | null {
  if (query.collectionId && !definitions.some((definition) => definition.id === query.collectionId)) return { collectionId: undefined, categoryId: undefined, scope: 'inbox', filter: 'all' }
  if (query.categoryId && !definitions.some((definition) => definition.id === query.categoryId && definition.kind === 'topic')) return { categoryId: undefined }
  return null
}
