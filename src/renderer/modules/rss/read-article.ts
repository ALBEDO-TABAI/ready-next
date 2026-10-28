import type { RSSArticleExcerpt, RSSReadArticleInput } from '../../../shared/rss-workspace'

interface ArticleReaderAPI {
  readArticle(input: RSSReadArticleInput): Promise<{ success: boolean; data?: RSSArticleExcerpt; error?: string }>
}

export async function readSavedRSSArticle(api: ArticleReaderAPI, itemId: string, signal: AbortSignal, expectedRevision?: string): Promise<RSSArticleExcerpt> {
  let first: RSSArticleExcerpt | undefined
  let offset: number | null = 0
  const chunks: string[] = []
  while (offset !== null) {
    signal.throwIfAborted()
    const result = await api.readArticle({ itemId, offset, length: 24000,
      ...(first || expectedRevision ? { expectedRevision: first?.article.revision || expectedRevision } : {}) })
    signal.throwIfAborted()
    if (!result.success || !result.data) throw new Error(result.error || '文章读取失败')
    first ??= result.data
    chunks.push(result.data.text)
    offset = result.data.nextOffset
  }
  return { ...first!, text: chunks.join(''), offset: 0, nextOffset: null }
}

/**
 * Bodies saved before platform extraction, reader table handling and block-link handling: a script-rendered
 * page's state literal, a page table kept as HTML block, or a link around a whole card split across blocks
 * (`[![photo](src)` on one line, `## Title](href)` on the next). All read as source text in the reader.
 */
export function isOutdatedRSSExtraction(markdown: string): boolean {
  return /^window\.__(?:SSR__|INITIAL_STATE__)\b/m.test(markdown) || /^<table\b[^>]*>/m.test(markdown)
    || /^#{1,6} [^[\n]*\]\(/m.test(markdown) || /^\s*\[!\[[^\]\n]*\]\([^)\s]*\)\s*$/m.test(markdown)
}
