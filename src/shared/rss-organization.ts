import { z } from 'zod'

export const RSSDefinitionKindSchema = z.enum(['all', 'unread', 'starred', 'history', 'curated', 'topic'])
export const RSSDefinitionIconSchema = z.enum(['inbox', 'mail', 'bookmark', 'archive', 'sparkles', 'tag', 'video', 'code', 'book', 'lightbulb'])
export interface RSSDefinition {
  id: string
  kind: z.infer<typeof RSSDefinitionKindSchema>
  name: string
  description: string
  icon: z.infer<typeof RSSDefinitionIconSchema>
  position: number
  visible: boolean
  revision: number
  ruleRevision: number
  filterIds: string[]
}

export const RSSDefinitionWriteSchema = z.object({
  id: z.string().min(1).optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000),
  icon: RSSDefinitionIconSchema.default('tag'),
  position: z.number().int().min(0).default(100),
  visible: z.boolean().default(true),
  filterIds: z.array(z.string().min(1)).default([]),
}).strict().refine((value) => !value.id || value.expectedRevision !== undefined, { message: '修改栏目需要当前版本。' })
export type RSSDefinitionWrite = z.input<typeof RSSDefinitionWriteSchema>
export const RSSDefinitionDeleteSchema = z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive() }).strict()
export const RSSMembershipWriteSchema = z.object({
  itemId: z.string().min(1), expectedArticleRevision: z.string().min(1),
  definitionId: z.string().min(1), expectedRuleRevision: z.number().int().positive(),
  decision: z.boolean().nullable(),
}).strict()
export type RSSMembershipWrite = z.infer<typeof RSSMembershipWriteSchema>

export interface RSSMembership {
  definitionId: string
  name: string
  kind: 'topic' | 'curated'
  included: boolean | null
  origin: 'manual' | 'legacy' | 'model' | 'unclassified'
  reason: string
  evidence: string | null
  stale: boolean
  ruleRevision: number | null
  currentRuleRevision: number
  contentRevision: string | null
}

export function rssArticleRevision(sourceRevision: string, bodyItemRevision: string | null, bodyRevision: string | null): string {
  return `${sourceRevision}:${sourceRevision === bodyItemRevision ? bodyRevision ?? 'none' : 'none'}`
}

export const RSS_DEFAULT_DEFINITIONS: ReadonlyArray<Pick<RSSDefinition, 'id' | 'kind' | 'name' | 'description' | 'icon' | 'position'>> = [
  { id: 'all', kind: 'all', name: '全部动态', description: '收件箱中的全部资讯与收藏。', icon: 'inbox', position: 0 },
  { id: 'unread', kind: 'unread', name: '未读', description: '尚未阅读的资讯。', icon: 'mail', position: 10 },
  { id: 'starred', kind: 'starred', name: '收藏', description: '已收藏的资讯。', icon: 'bookmark', position: 20 },
  { id: 'history', kind: 'history', name: '历史底稿', description: '包含已移出收件箱的保存资料。', icon: 'archive', position: 30 },
  { id: 'curated', kind: 'curated', name: '精选', description: '优先选择有明确新进展、可靠来源和实际参考价值的资讯，排除重复转述与缺少具体信息的宣传。', icon: 'sparkles', position: 40 },
]
