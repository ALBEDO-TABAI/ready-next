import { z } from 'zod'

export const RSS_PROCESSING_METHOD = 'rss-organize-v1'
export const RSS_PROCESSING_SETTINGS_KEY = 'rss:processing'
export const RSSProcessingSettingsSchema = z.object({ enabled: z.boolean(), dailyLimit: z.number().int().min(1).max(10000) }).strict()
export type RSSProcessingSettings = z.infer<typeof RSSProcessingSettingsSchema>
export type RSSProcessingJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'unknown' | 'canceled' | 'stale'
export interface RSSProcessingDefinition { id: string; name: string; description: string; ruleRevision: number }
export interface RSSProcessingJob {
  id: string; itemId: string; title: string; articleRevision: string; method: string; definitions: RSSProcessingDefinition[]
  trigger: 'automatic' | 'manual'; status: RSSProcessingJobStatus; message: string | null
  createdAt: number; startedAt: number | null; finishedAt: number | null
}
export interface RSSProcessingStatus {
  settings: RSSProcessingSettings; callsToday: number; pending: number; running: number
  blocked: 'model' | 'limit' | 'disabled' | null
}
export const RSSProcessingListSchema = z.object({
  itemId: z.string().min(1).optional().describe('可选文章 ID'),
  offset: z.number().int().nonnegative().optional().default(0).describe('续页使用 nextOffset'),
  limit: z.number().int().min(1).max(100).optional().default(30).describe('每页 1–100 条，默认 30'),
  snapshot: z.number().int().nonnegative().optional().describe('续页沿用首次返回的 snapshot，避免新任务插入挤动分页'),
}).strict()
export type RSSProcessingListInput = z.input<typeof RSSProcessingListSchema>
export interface RSSProcessingList { jobs: RSSProcessingJob[]; total: number; nextOffset: number | null; snapshot: number }
export const RSSReprocessSchema = z.object({ itemId: z.string().min(1), expectedArticleRevision: z.string().min(1) }).strict()

export const RSSJudgmentSchema = z.object({ decisions: z.array(z.object({
  definitionId: z.string().min(1), included: z.boolean().nullable(), reason: z.string().trim().min(1).max(600), evidence: z.string().trim().min(1).max(500).nullable(),
}).strict()).min(1).max(8) }).strict()
export type RSSJudgment = z.infer<typeof RSSJudgmentSchema>
