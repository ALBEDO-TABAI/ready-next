import type { RSSDefinition, RSSMembership } from './rss-organization'
import type { RSSEventMembership, RSSEventSummary } from './rss-events'
import { z } from 'zod'

export const RSS_SEARCH_MAX_LENGTH = 300

/** All RSS readers use these scopes; library includes items dismissed from the inbox. */
export const RSSQuerySchema = z.object({
  scope: z.enum(['inbox', 'library']).optional().default('inbox').describe('inbox 当前收件箱；library 含历史底稿'),
  filter: z.enum(['all', 'unread', 'starred']).optional().default('all').describe('all、unread 或 starred'),
  collectionId: z.string().min(1).optional().describe('栏目定义 ID'),
  categoryId: z.string().min(1).optional().describe('主题定义 ID，与栏目及其他条件取交集'),
  eventId: z.string().min(1).optional().describe('可选事件 ID，保留其他筛选条件'),
  sourceId: z.string().trim().min(1).optional().describe('可选订阅源 ID'),
  search: z.string().trim().max(RSS_SEARCH_MAX_LENGTH).optional().default('').describe('按字面关键词搜索，不触发网络获取'),
  searchIn: z.enum(['title_summary', 'body']).optional().default('title_summary').describe('title_summary 标题摘要；body 已保存正文'),
  from: z.number().int().nonnegative().optional().describe('时间范围起点，Unix 毫秒，包含'),
  until: z.number().int().nonnegative().optional().describe('时间范围终点，Unix 毫秒，不包含'),
  sort: z.enum(['newest', 'oldest', 'relevance']).optional().default('newest').describe('newest、oldest 或 relevance（最终分从高到低）'),
  limit: z.number().int().min(1).max(100).optional().default(50).describe('每页 1–100 条，默认 50'),
  cursor: z.string().max(1000).optional().describe('上一页返回的 nextCursor；其他查询条件保持相同'),
  expectedRevision: z.number().int().nonnegative().optional().describe('可选，固定当前界面或导出所引用的资料版本'),
}).strict().refine((query) => query.from === undefined || query.until === undefined || query.from < query.until, {
  message: 'from must precede until',
})

export type RSSQueryInput = z.input<typeof RSSQuerySchema>
export type RSSQuery = z.output<typeof RSSQuerySchema>
export type RSSBodyStatus = 'missing' | 'loading' | 'ready' | 'partial' | 'stale' | 'login_required' | 'failed'

export interface RSSArticleSummary {
  event?: RSSEventMembership
  eventGroup?: RSSEventSummary & { matchingCount: number; matchingUnread: number; matchingStarred: number; displayTime: number }
  classifications: RSSMembership[]
  id: string
  revision: string
  sourceRevision: string
  sourceId: string
  source: string
  title: string
  link: string
  summary: string
  author: string | null
  /** Epoch milliseconds; a missing publication date stays missing. */
  publishedAt: number | null
  collectedAt: number
  coverImage: string | null
  read: boolean
  starred: boolean
  inboxVisible: boolean
  bodyStatus: RSSBodyStatus
}

export interface RSSQueryResult {
  /** Present only on the workspace card projection; total still counts matching articles. */
  cardTotal?: number
  definitions: RSSDefinition[]
  query: Omit<RSSQuery, 'cursor' | 'expectedRevision'>
  revision: number
  total: number
  unreadTotal: number
  lastFetchAt: number | null
  items: RSSArticleSummary[]
  nextCursor: string | null
}

export interface RSSArticle extends RSSArticleSummary {
  body: {
    fetching: boolean
    status: RSSBodyStatus
    revision: string | null
    markdown: string | null
    fetchedAt: number | null
    sourceUrl: string
    error: string | null
  }
}

export const RSSReadArticleSchema = z.object({
  itemId: z.string().min(1).describe('文章 ID'),
  expectedRevision: z.string().min(1).optional().describe('文章版本；连续读取时沿用首次返回版本'),
  offset: z.number().int().nonnegative().optional().default(0).describe('读取位置，使用上次返回的 nextOffset'),
  length: z.number().int().min(1).max(24000).optional().default(12000).describe('本次最多读取字符数，默认 12000、上限 24000'),
}).strict()

export const RSSLoadArticleSchema = z.object({ itemId: z.string().min(1), force: z.boolean().default(false) }).strict()

export const RSSSaveNoteSchema = z.object({ itemId: z.string().min(1), expectedRevision: z.string().min(1), defaultDirectory: z.string().optional() }).strict()
export type RSSSaveNoteInput = z.infer<typeof RSSSaveNoteSchema>
export type RSSNoteSaveResult = { canceled: true } | { canceled: false; path: string; itemId: string; revision: string }
export type RSSQueryExportResult = { canceled: true } | { canceled: false; path: string; query: RSSQueryResult['query']; revision: number; total: number }

export type RSSReadArticleInput = z.input<typeof RSSReadArticleSchema>
export interface RSSArticleExcerpt {
  article: Omit<RSSArticle, 'body'>
  body: Omit<RSSArticle['body'], 'markdown'>
  text: string
  textKind: 'body' | 'source_summary'
  offset: number
  totalLength: number
  nextOffset: number | null
}
