import { z } from 'zod'
import { RSSReadingRangeSchema, type RSSReadingRange } from './rss-reading'
import type { RSSArticleExcerpt, RSSArticleSummary } from './rss-workspace'

export const RSSReadExcerptSchema = z.object({
  format: z.literal('reading-v1').describe('阅读映射版本，必须原样沿用引用中的 reading-v1'),
  itemId: z.string().min(1).describe('已保存文章 ID'),
  expectedRevision: z.string().min(1).describe('引用绑定的完整文章版本'),
  range: RSSReadingRangeSchema.describe('引用原样携带的阅读文字范围，不从相同句子猜位置'),
  offset: z.number().int().nonnegative().optional().default(0).describe('选区内续读位置，沿用 nextOffset'),
  length: z.number().int().min(1).max(24000).optional().default(12000).describe('最多读取字符数；始终限制在选区内'),
}).strict()
export type RSSReadExcerptInput = z.input<typeof RSSReadExcerptSchema>
export type RSSExcerptArticle = Omit<RSSArticleSummary, 'summary' | 'classifications' | 'event' | 'eventGroup' | 'coverImage'>
export interface RSSSelectionExcerpt extends Omit<RSSArticleExcerpt, 'textKind' | 'article' | 'body'> {
  article: RSSExcerptArticle; body: Omit<RSSArticleExcerpt['body'], 'error'>; textKind: 'reading_text'; textSource: 'body' | 'source_summary'; range: RSSReadingRange
}
