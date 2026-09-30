import { RSSReadReferenceSchema } from '../../../../shared/rss-reference'
/**
 * RSS domain schemas; saved-content reads share their schema with the IPC API.
 *
 * SSOT for dispatch-time validation + LLM-facing SkillParamDefinition[] via
 * zod-param-derivation. Descriptions mirror the legacy hand-rolled params in
 * rss-tools.ts byte-for-byte; the golden snapshot test locks equivalence.
 *
 * Note: analysisType is kept as plain z.string() (not z.enum) to preserve
 * byte-equivalence with the current LLM payload. Tightening to an enum is a
 * follow-up PR since it would change the emitted JSONSchema.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'
import { RSSQuerySchema, RSSReadArticleSchema } from '../../../../shared/rss-workspace'

export const RssAddSourceSchema = z.object({
  name: z.string().describe('订阅源名称'),
  url: z.string().describe('订阅源 URL'),
})

export const RssFetchUpdatesSchema = z.object({})

export const RssSelectItemSchema = z.object({
  itemId: z.string().optional().describe('可选，条目 ID'),
  title: z.string().optional().describe('可选，条目标题关键词'),
})

export const RssAnalyzeItemSchema = z.object({
  itemId: z.string().optional().describe('可选，条目 ID'),
  title: z.string().optional().describe('可选，条目标题关键词'),
  analysisType: z.string().describe('copy 或 visual'),
})

export const RssCaptureSessionSchema = z.object({})

export type RssToolName =
  | 'rss_add_source'
  | 'rss_fetch_updates'
  | 'rss_select_item'
  | 'rss_analyze_item'
  | 'rss_capture_session'
  | 'rss_query_items'
  | 'rss_read_article'
  | 'rss_read_reference'

export const RSS_SCHEMAS: Record<RssToolName, z.ZodObject<z.ZodRawShape>> = {
  rss_add_source: RssAddSourceSchema,
  rss_fetch_updates: RssFetchUpdatesSchema,
  rss_select_item: RssSelectItemSchema,
  rss_analyze_item: RssAnalyzeItemSchema,
  rss_capture_session: RssCaptureSessionSchema,
  rss_query_items: RSSQuerySchema,
  rss_read_article: RSSReadArticleSchema,
  rss_read_reference: RSSReadReferenceSchema,
}
