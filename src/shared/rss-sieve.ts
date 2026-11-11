import { z } from 'zod'
import type { RSSArticleSummary } from './rss-workspace'

export const RSS_RELEVANCE_METHOD = 'rss-sieve-relevance-v1'
export type RSSWorkKind = 'page' | 'project' | 'calendar' | 'book'
export interface RSSWorkEntry { title: string; kind: RSSWorkKind }

export const RSSRelevanceSchema = z.object({
  score: z.number().min(0).max(100), because: z.enum(['standard', 'interest', 'work']),
  reason: z.string().trim().min(1).transform(value => Array.from(value).slice(0, 40).join('')), workRef: z.string().min(1).nullable(),
}).strict()
export type RSSRelevance = z.infer<typeof RSSRelevanceSchema> & { summaryOnly: boolean; workKind?: RSSWorkKind }
export const RSSWorkPrivacySchema = z.object({
  answer: z.enum(['unanswered', 'enabled', 'later']).default('unanswered'), enabled: z.boolean().default(false),
  pages: z.boolean().default(true), calendar: z.boolean().default(true), books: z.boolean().default(true),
}).strict()
export const RSSWorkPrivacyPatchSchema = z.object({
  answer: RSSWorkPrivacySchema.shape.answer.removeDefault().optional(), enabled: z.boolean().optional(),
  pages: z.boolean().optional(), calendar: z.boolean().optional(), books: z.boolean().optional(),
}).strict()
export type RSSWorkPrivacy = z.infer<typeof RSSWorkPrivacySchema>
export const RSS_FEEDBACK_TARGET = { source: 'source', topic: 'topic', shallow: 'source', known: 'topic' } as const
export const RSSBehaviorSchema = z.object({
  id: z.string().min(1), itemId: z.string().min(1), at: z.number().int().nonnegative(),
  action: z.enum(['open', 'finish', 'star', 'highlight', 'note', 'fastcard', 'document', 'ask_ai', 'more', 'less', 'remove']),
  topicId: z.string().min(1).optional(), reason: z.enum(['source', 'topic', 'shallow', 'known']).optional(),
}).strict().superRefine((value, ctx) => {
  if (['more', 'less'].includes(value.action) && !value.reason) ctx.addIssue({ code: 'custom', message: '请选择调整原因' })
  if (value.reason && RSS_FEEDBACK_TARGET[value.reason] === 'topic' && !value.topicId) ctx.addIssue({ code: 'custom', message: '请选择话题' })
})
export type RSSBehaviorInput = z.infer<typeof RSSBehaviorSchema>
export type RSSBehavior = RSSBehaviorInput & { sourceId: string; topicIds: string[] }
export const RSSSieveQuerySchema = z.object({ topicId: z.string().min(1).optional(), threshold: z.number().min(0).max(100).default(60) }).strict()
export type RSSSieveQuery = z.input<typeof RSSSieveQuerySchema>
export type RSSSieveFactor = 'model' | 'source' | 'topic' | 'freshness' | 'duplicate' | 'manual'
export interface RSSSieveScore {
  explore?: boolean
  score: number
  eligible: boolean
  pinned: boolean
  reason: string
  factors: { factor: RSSSieveFactor; contribution: number }[]
}
export interface RSSSieveItem extends RSSArticleSummary { sieve: RSSSieveScore; relevance: RSSRelevance | null }
export interface RSSSieveResult { items: RSSSieveItem[]; remaining: RSSSieveItem[]; remainingCount: number }
export interface RSSWorkContextSnapshot { text: string; entries: RSSWorkEntry[] }
export interface RSSFocus { version: number; text: string }
export interface RSSSieveAPI {
  sieveRelevance(itemId: string): Promise<RSSSieveResponse<RSSRelevance | null>>
  sieveQuery(input?: RSSSieveQuery): Promise<RSSSieveResponse<RSSSieveResult>>
  sieveToday(): Promise<RSSSieveResponse<RSSSieveItem[]>>
  sieveRecordBehavior(input: RSSBehaviorInput): Promise<RSSSieveResponse<RSSBehavior>>
  sievePrivacy(): Promise<RSSSieveResponse<RSSWorkPrivacy>>
  sieveConfigurePrivacy(input: Partial<RSSWorkPrivacy>): Promise<RSSSieveResponse<RSSWorkPrivacy>>
  sieveWorkContext(): Promise<RSSSieveResponse<RSSWorkContextSnapshot>>
  sieveExcludedPages(): Promise<RSSSieveResponse<string[]>>
  sieveExcludePage(input: { objectId: string; excluded: boolean }): Promise<RSSSieveResponse<string[]>>
  sieveFocus(): Promise<RSSSieveResponse<RSSFocus>>
  sieveSaveFocus(input: { text: string; expectedVersion: number }): Promise<RSSSieveResponse<RSSFocus>>
}
export type RSSSieveResponse<T> = { success: true; data: T } | { success: false; error: string }

export const RSSCalibrationDecisionSchema = z.object({ week:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), expectedVersion:z.number().int().nonnegative(), text:z.string().max(8000).optional() }).strict()
export type RSSCalibrationDecision = z.infer<typeof RSSCalibrationDecisionSchema>
export interface RSSCalibration { week:string; baseVersion:number; status:'queued'|'running'|'pending'|'accepted'|'dismissed'|'failed'|'unknown'; text:string|null; explanation:string|null; stale:boolean }
export interface RSSSieveMetrics { from:number; until:number; screened:number; hits:number; hitRate:number|null; missed:number }
export const RSSNotificationSettingsSchema = z.object({ quietStart:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), quietEnd:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict()
export type RSSNotificationSettings = z.infer<typeof RSSNotificationSettingsSchema>
export const RSSTopicNotificationSchema = z.object({ topicId:z.string().min(1), urgent:z.boolean() }).strict()
export interface RSSSieveAPI {
  sievePendingOpen(): Promise<RSSSieveResponse<{id:string;itemId:string}|null>>
  sieveAckOpen(id:string): Promise<RSSSieveResponse<void>>
  onSieveOpenPending(handler:()=>void): ()=>void
  sieveCalibration(): Promise<RSSSieveResponse<RSSCalibration|null>>
  sieveAcceptCalibration(input: RSSCalibrationDecision): Promise<RSSSieveResponse<RSSFocus>>
  sieveDismissCalibration(input: { week:string }): Promise<RSSSieveResponse<RSSCalibration>>
  sieveMetrics(): Promise<RSSSieveResponse<RSSSieveMetrics>>
  sieveNotificationSettings(): Promise<RSSSieveResponse<RSSNotificationSettings>>
  sieveSaveNotificationSettings(input: RSSNotificationSettings): Promise<RSSSieveResponse<RSSNotificationSettings>>
  sieveTopicNotifications(): Promise<RSSSieveResponse<{topicId:string;urgent:boolean}[]>>
  sieveSaveTopicNotification(input: {topicId:string;urgent:boolean}): Promise<RSSSieveResponse<{topicId:string;urgent:boolean}>>
  importOpml(input: {xml:string}): Promise<RSSSieveResponse<{added:number;existing:number;sourceIds:string[]}>>
}

export const RSSSieveSettingsSchema = z.object({ explore: z.boolean() }).strict()
export type RSSSieveSettings = z.infer<typeof RSSSieveSettingsSchema>
export interface RSSSieveAPI {
  sieveSettings(): Promise<RSSSieveResponse<RSSSieveSettings>>
  sieveSaveSettings(input: RSSSieveSettings): Promise<RSSSieveResponse<RSSSieveSettings>>
}
