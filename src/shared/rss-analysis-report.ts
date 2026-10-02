import { z } from 'zod'

export const RSSReadAnalysisReportSchema = z.object({
  jobId: z.string().min(1).describe('已保存的分析任务 ID'),
  offset: z.number().int().nonnegative().optional().default(0).describe('首读为 0；续读使用 nextOffset'),
  length: z.number().int().min(2).max(24000).optional().default(12000).describe('每段字符数，最多 24000'),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('续读必须沿用首次返回的 revision'),
}).strict()
export type RSSReadAnalysisReportInput = z.input<typeof RSSReadAnalysisReportSchema>
export interface RSSAnalysisReportPage {
  jobId: string; itemId: string; title: string; sourceUrl: string; sourceWarning: string | null
  revision: string; publishedAt: string; text: string; offset: number; totalLength: number; nextOffset: number | null
}
