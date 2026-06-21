/**
 * Zod schemas for the 4 memory domain tools (Phase 2.5 PR 2).
 *
 * SSOT for both dispatch-time validation and LLM-facing SkillParamDefinition[]
 * via zod-param-derivation.ts. Descriptions and enum values mirror the legacy
 * hand-rolled params in memory-tools.ts byte-for-byte; the golden snapshot
 * test locks that equivalence.
 *
 * Pure module — Zod only, no electron / runtime / database imports.
 */

import { z } from 'zod'

const SourceTypeEnum = z.enum(['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'])

export const MemoryCreateSchema = z.object({
  category: z
    .enum(['summary', 'learning'])
    .describe('记忆类别：summary(当前任务/当前 scope 摘要，30天后过期) 或 learning(常驻 agent 记忆，长期保留)'),
  title: z.string().describe('记忆标题，简短描述'),
  content: z.string().describe('记忆内容，详细信息'),
  tags: z.array(z.string()).optional().describe('标签列表，用于分类和检索'),
  priority: z.number().optional().describe('优先级，0-10，数字越大优先级越高'),
})

export const MemorySearchSchema = z.object({
  query: z.string().optional().describe('搜索关键词，在标题和摘要中搜索'),
  layer: z
    .enum(['l0', 'l1', 'l2'])
    .optional()
    .describe('存储层级：l0(常驻), l1(当前 scope), l2(触发规则)'),
  source_type: SourceTypeEnum
    .optional()
    .describe('来源分类：resident_agent, resident_user, scope_memory, trigger_rule'),
  category: z
    .enum(['summary', 'learning', 'trigger', 'rule'])
    .optional()
    .describe('记忆类别：summary, learning, trigger, rule'),
  limit: z.number().optional().describe('返回结果数量限制，默认10'),
})

export const MemoryUpdateSchema = z.object({
  memory_id: z.string().describe('记忆ID'),
  title: z.string().optional().describe('新标题'),
  summary: z.string().optional().describe('新摘要'),
  tags: z.array(z.string()).optional().describe('新标签列表'),
  priority: z.number().optional().describe('新优先级'),
  source_type: SourceTypeEnum
    .optional()
    .describe('新的来源分类：resident_agent, resident_user, scope_memory, trigger_rule'),
})

export const MemoryListRecentSchema = z.object({
  limit: z.number().optional().describe('返回数量，默认5'),
  source_type: SourceTypeEnum
    .optional()
    .describe('来源分类：resident_agent, resident_user, scope_memory, trigger_rule'),
})

// EP1-K1 — belief card tools. New cards default to status `staged` (do not
// enter injection until promoted); write path is whitelisted to
// knowledge/*.md, knowledge/sites/*.md, and per-agent
// agents/<agentId>/knowledge/[sites/]*.md (EP3-A2) by belief-card-store.
export const MemoryWriteCardSchema = z.object({
  rel_path: z
    .string()
    .describe('卡片相对路径，允许 knowledge/<slug>.md、knowledge/sites/<domain>.md，或专属某个 agent 的 agents/<agentId>/knowledge/<slug>.md、agents/<agentId>/knowledge/sites/<domain>.md'),
  title: z.string().describe('卡片标题，一句话'),
  description: z.string().describe('一行摘要，用作索引检索线索'),
  confidence: z.enum(['H', 'M', 'L']).describe('置信度：H/M/L'),
  tag: z
    .enum(['knowledge', 'self', 'preference', 'aspire'])
    .describe('标签：knowledge(外部事实) / self(工作方式) / preference(用户偏好) / aspire(开放问题)'),
  body: z.string().describe('卡片正文 markdown，可用 [[slug]] 链接其他卡'),
  status: z
    .enum(['staged', 'active'])
    .optional()
    .describe('请求状态：模型写入会被强制 staged；active 只来自确认/晋升流程'),
  source: z.string().optional().describe('来源，一行 provenance'),
  site: z.string().optional().describe('站点域名，仅站点卡(knowledge/sites/*.md)需要'),
})

export const MemoryReadCardSchema = z.object({
  rel_path: z
    .string()
    .describe('卡片相对路径：knowledge/<slug>.md、knowledge/sites/<domain>.md，或 agents/<agentId>/knowledge/[sites/]<slug>.md'),
  include_staged: z
    .boolean()
    .optional()
    .describe('是否包含待确认(staged)卡片，默认 false'),
})

export type MemoryToolName =
  | 'memory_create'
  | 'memory_search'
  | 'memory_update'
  | 'memory_list_recent'
  | 'memory_write_card'
  | 'memory_read_card'

export const MEMORY_SCHEMAS: Record<MemoryToolName, z.ZodObject<z.ZodRawShape>> = {
  memory_create: MemoryCreateSchema,
  memory_search: MemorySearchSchema,
  memory_update: MemoryUpdateSchema,
  memory_list_recent: MemoryListRecentSchema,
  memory_write_card: MemoryWriteCardSchema,
  memory_read_card: MemoryReadCardSchema,
}
