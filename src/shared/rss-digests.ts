import { z } from 'zod'
import { RSSQuerySchema } from './rss-workspace'
import type { RSSMembership } from './rss-organization'

export const RSSDigestSettingsSchema = z.object({ enabled: z.boolean(), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict()
export type RSSDigestSettings = z.infer<typeof RSSDigestSettingsSchema>
export const RSSDigestReadSchema = z.object({
  view: z.enum(['editions', 'entries', 'sources', 'coverage', 'criteria']).optional().default('editions').describe('editions 刊物目录；entries 条目；sources 某条全部依据；coverage 订阅覆盖；criteria 发布时的分类与精选标准'),
  reportId: z.string().min(1).optional().describe('除目录外必填，已保存刊物 ID'), groupKey: z.string().min(1).optional().describe('sources 视图必填，沿用条目的 groupKey'),
  offset: z.number().int().nonnegative().optional().default(0).describe('续页使用返回的 nextOffset'), limit: z.number().int().min(1).max(50).optional().default(20).describe('每页 1–50 条，默认 20'),
  snapshot: z.number().int().nonnegative().optional().describe('刊物目录续页沿用首次返回的 snapshot'),
}).strict().superRefine((value, ctx) => {
  if (value.view === 'editions' && value.reportId !== undefined) ctx.addIssue({ code: 'custom', message: '目录读取不接受刊物 ID', path: ['reportId'] })
  if (value.view !== 'sources' && value.groupKey !== undefined) ctx.addIssue({ code: 'custom', message: '只有 sources 视图接受条目 ID', path: ['groupKey'] })
  if (value.view !== 'editions' && value.snapshot !== undefined) ctx.addIssue({ code: 'custom', message: '只有目录续页接受 snapshot', path: ['snapshot'] })
  if (value.view !== 'editions' && !value.reportId) ctx.addIssue({ code: 'custom', message: '请选择已保存刊物', path: ['reportId'] })
  if (value.view === 'sources' && !value.groupKey) ctx.addIssue({ code: 'custom', message: '请选择刊物条目', path: ['groupKey'] })
})
export type RSSDigestReadInput = z.input<typeof RSSDigestReadSchema>
export const RSSDigestGenerateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('range'), query: RSSQuerySchema.safeExtend({ expectedRevision: z.number().int().nonnegative(), cursor: z.never().optional() }) }).strict(),
  z.object({ kind: z.literal('regenerate'), reportId: z.string().min(1) }).strict(),
])
export type RSSDigestGenerateInput = z.infer<typeof RSSDigestGenerateSchema>
export interface RSSDigestSource {
  sieve?: import('./rss-sieve').RSSSieveScore;
  itemId: string; articleRevision: string; title: string; link: string; sourceId: string; source: string;
  quote: string; quoteKind: 'event_evidence' | 'source_summary' | 'saved_body' | 'title'; quoteTruncated: boolean;
  sourceRole: 'direct' | 'secondary' | 'unknown'; bodyStatus: string; factId: string | null; eventId: string | null; evidenceId: string | null;
  availableAt: number; carriedOver: boolean; curation: RSSMembership | null; topics: RSSMembership[];
}
export interface RSSDigestHeader {
  id: string; kind: 'daily' | 'range'; editionKey: string; version: number; from: number; until: number; timezone: string; createdAt: number;
  query: unknown; scopeLabel: string; ruleCount: number; total: number; referenceCount: number; needsUpdate: boolean;
  lead: { title: string; source: string } | null;
  coverage: { matchingArticles: number; pendingArticles: number; unresolvedArticles: number; failedArticles: number; missingBodies: number; carriedOverArticles: number; duplicateOrPublishedArticles: number };
}
export interface RSSDigestCriteria { id: string; name: string; description: string; ruleRevision: number; kind: string }
export interface RSSDigestEntry { section: string; groupKey: string; referenceCount: number; source: RSSDigestSource }
export interface RSSDigestFetch { sourceId: string; success: boolean; attemptedAt: string; warning: string | null; error: string | null }
export interface RSSDigestCoverageSource { id: string; name: string; url: string; lastFetchedAt: number | null; enabled: boolean; fetch: RSSDigestFetch | null }
export type RSSDigestReadResult =
  | { view: 'criteria'; report: RSSDigestHeader; criteria: RSSDigestCriteria[]; total: number; nextOffset: number | null }
  | { view: 'editions'; editions: RSSDigestHeader[]; total: number; nextOffset: number | null; snapshot: number }
  | { view: 'entries'; report: RSSDigestHeader; entries: RSSDigestEntry[]; total: number; nextOffset: number | null }
  | { view: 'sources'; report: RSSDigestHeader; sources: RSSDigestSource[]; total: number; nextOffset: number | null }
  | { view: 'coverage'; report: RSSDigestHeader; sources: RSSDigestCoverageSource[]; total: number; nextOffset: number | null }
export interface RSSDigestScheduleState extends RSSDigestSettings { timezone: string; nextRunAt: string | null; error: string | null }
