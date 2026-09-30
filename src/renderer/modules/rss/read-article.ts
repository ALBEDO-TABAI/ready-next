import type { RSSArticleExcerpt, RSSReadArticleInput } from '../../../shared/rss-workspace'

interface ArticleReaderAPI {
  readArticle(input: RSSReadArticleInput): Promise<{ success: boolean; data?: RSSArticleExcerpt; error?: string }>
}

export async function readSavedRSSArticle(api: ArticleReaderAPI, itemId: string, signal: AbortSignal, expectedRevision?: string): Promise<RSSArticleExcerpt> {
  let first: RSSArticleExcerpt | undefined
  let offset = 0
  const chunks: string[] = []
  do {
    signal.throwIfAborted()
    const result = await api.readArticle({ itemId, offset, length: 24000,
      ...(first || expectedRevision ? { expectedRevision: first?.article.revision || expectedRevision } : {}) })
    signal.throwIfAborted()
    if (!result.success || !result.data) throw new Error(result.error || '文章读取失败')
    first ??= result.data
    chunks.push(result.data.text)
    if (result.data.nextOffset === null) break
    offset = result.data.nextOffset
  } while (true)
  return { ...first, text: chunks.join(''), offset: 0, nextOffset: null }
}
