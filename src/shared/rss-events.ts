import { z } from 'zod'
export const RSS_EVENT_METHOD = 'rss-event-v1'

export const RSSEventDecisionSchema = z.object({
  kind: z.enum(['new', 'duplicate', 'progress', 'insufficient']), eventId: z.string().min(1).nullable(), factId: z.string().min(1).nullable(),
  quote: z.string().trim().min(1).max(600).nullable(), sourceRole: z.enum(['direct', 'secondary', 'unknown']), reason: z.string().trim().min(1).max(600),
}).strict()
export type RSSEventDecision = z.infer<typeof RSSEventDecisionSchema>
export interface RSSEventMembership {
  eventId: string | null; factId: string | null; revision: number; articleRevision: string
  quote: string | null; sourceRole: RSSEventDecision['sourceRole']; relation: 'original' | 'duplicate' | 'progress' | null
  manual: boolean; reason: string; stale: boolean
}
export interface RSSEventMember extends RSSEventMembership {
  itemId: string; title: string; link: string; sourceId: string; source: string; read: boolean; starred: boolean; publishedAt: number | null
  factAvailableAt: number | null
}
export interface RSSEventSummary {
  id: string; revision: number; title: string; representativeId: string; memberCount: number; sourceCount: number; factCount: number
  unreadCount: number; starredCount: number; staleCount: number; latestAt: number; unseenFactCount: number
}
export interface RSSEventFact {
  id: string; availableAt: number; evidenceId: string; itemId: string; articleRevision: string; quote: string
  title: string; link: string; source: string; sourceRole: RSSEventDecision['sourceRole']; publishedAt: number | null; historical: boolean
  seen: boolean
}
export interface RSSEventCandidate {
  id: string; revision: number; title: string; titleTruncated: boolean; factsTruncated: boolean
  facts: Array<{ id: string; evidenceId: string; itemId: string; articleRevision: string; quote: string; title: string; titleTruncated: boolean; link: string; linkTruncated: boolean; publishedAt: number | null; historical: boolean }>
}
export interface RSSEventContext {
  membershipRevision: number; manual: boolean; reused: boolean; candidates: RSSEventCandidate[]
  since: number; candidateLimit: number; truncated: boolean
}
export const RSSEventReadSchema = z.object({
  eventId: z.string().min(1).describe('事件 ID'), expectedRevision: z.number().int().positive().optional().describe('续页沿用事件 revision'),
  offset: z.number().int().nonnegative().optional().default(0).describe('续页使用 nextOffset'),
  limit: z.number().int().min(1).max(100).optional().default(30).describe('每页 1–100 条'),
}).strict()
export type RSSEventReadInput = z.input<typeof RSSEventReadSchema>
export interface RSSEventReadResult { summary: RSSEventSummary; members: RSSEventMember[]; total: number; nextOffset: number | null }
export const RSSEventMoveSchema = z.object({
  itemId: z.string().min(1), expectedArticleRevision: z.string().min(1), expectedMembershipRevision: z.number().int().nonnegative(),
  quote: z.string().trim().min(1).max(600).optional(),
  targetEventId: z.string().min(1).nullable(), expectedEventRevision: z.number().int().positive().optional(), targetFactId: z.string().min(1).optional(),
}).strict().refine((value) => value.targetEventId ? value.expectedEventRevision !== undefined : value.targetFactId === undefined, '移动需要目标事件版本；拆开不能指定其他事实。')
export type RSSEventMoveInput = z.infer<typeof RSSEventMoveSchema>
export const RSSEventMergeSchema = z.object({
  fromEventId: z.string().min(1), expectedFromRevision: z.number().int().positive(), intoEventId: z.string().min(1), expectedIntoRevision: z.number().int().positive(),
}).strict().refine((value) => value.fromEventId !== value.intoEventId, '不能合并到自身。')
export type RSSEventMergeInput = z.infer<typeof RSSEventMergeSchema>
export const RSSSeenFactsSchema = z.object({ factIds: z.array(z.string().min(1)).min(1).max(100) }).strict()

export const RSSReadEventsSchema = z.object({
  view: z.enum(['list', 'members', 'facts']).optional().default('list').describe('list 事件目录；members 当前报道；facts 包含历史依据的事实与进展'),
  eventId: z.string().min(1).optional().describe('读取成员或事实时必填'),
  search: z.string().trim().max(200).optional().default('').describe('仅事件目录使用，搜索已保存标题或事实摘句'),
  expectedRevision: z.number().int().nonnegative().optional().describe('续页使用首次返回的 revision'),
  offset: z.number().int().nonnegative().optional().default(0).describe('续页使用 nextOffset'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('每页 1–100 条，默认 20'),
}).strict().refine((input) => input.view === 'list' ? !input.eventId : !!input.eventId && !input.search, '目录与事件读取参数不能混用。')
export type RSSReadEventsInput = z.input<typeof RSSReadEventsSchema>
export type RSSReadEventsResult = { revision: number; total: number; nextOffset: number | null } & (
  { view: 'list'; events: RSSEventSummary[] } | { view: 'members'; summary: RSSEventSummary; members: RSSEventMember[] } | { view: 'facts'; summary: RSSEventSummary; facts: RSSEventFact[] }
)
