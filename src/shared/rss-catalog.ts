import { z } from 'zod'

export const RSSReadCatalogSchema = z.object({
  view: z.enum(['sources', 'definitions', 'analysis', 'judgments', 'evidence']).describe('sources 全部来源含停用；definitions 栏目与规则；analysis 全部分析任务；judgments 历史分类判断；evidence 全部事件依据含撤回和信息不足'),
  itemId: z.string().min(1).optional().describe('仅 analysis、judgments、evidence 可按文章 ID 筛选'),
  eventId: z.string().min(1).optional().describe('仅 evidence 可按当前事件归属筛选'),
  cursor: z.string().min(1).max(4000).optional().describe('续页原样使用 nextCursor；资料变化须重新读取，不追加旧页'),
  limit: z.number().int().min(1).max(100).optional().default(30).describe('每页 1–100 条，默认 30'),
}).strict().refine((input) => (!input.itemId || !['sources', 'definitions'].includes(input.view)) && (!input.eventId || input.view === 'evidence'), '目录筛选与 view 不匹配。')
export type RSSReadCatalogInput = z.input<typeof RSSReadCatalogSchema>
