import { z } from 'zod'
import { RSSReadAnalysisReportSchema } from './rss-analysis-report'

export const RSSAnalysisAssetKindSchema = z.enum(['corrected_transcript', 'structured_transcript', 'source_article', 'scene_scores', 'source_video'])
export type RSSAnalysisAssetKind = z.infer<typeof RSSAnalysisAssetKindSchema>
export const RSSReadAnalysisAssetsSchema = RSSReadAnalysisReportSchema.extend({
  kind: z.enum(['list', ...RSSAnalysisAssetKindSchema.options]).optional().default('list').describe('list 检查本任务的已保存产物；其余种类读取文字或本地视频引用，不下载、不分析'),
}).refine((input) => !['list', 'source_video'].includes(input.kind) || input.offset === 0 && !input.expectedRevision, '目录和视频引用不支持文字续读参数。')
export type RSSReadAnalysisAssetsInput = z.input<typeof RSSReadAnalysisAssetsSchema>
