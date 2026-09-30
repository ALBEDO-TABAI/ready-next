import { z } from 'zod'
import { RSSQuerySchema, RSSReadArticleSchema } from './rss-workspace'

/** A frozen read request, not a copy of the article or a filesystem path. */
export const RSSReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('digest'), read: z.object({ reportId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict() }).strict(),
  z.object({ kind: z.literal('article'), read: RSSReadArticleSchema.extend({ expectedRevision: z.string().min(1) }) }).strict(),
  z.object({ kind: z.literal('query'), query: RSSQuerySchema.safeExtend({ cursor: z.never().optional(), expectedRevision: z.number().int().nonnegative() }) }).strict(),
])
export type RSSReference = z.infer<typeof RSSReferenceSchema>
export const RSS_REFERENCE_MARKER = '### RSS 资料引用'
export const RSSReferenceResourceSchema = z.object({ id: z.string().uuid(), name: z.string().min(1), reference: RSSReferenceSchema }).strict()

export function formatRSSReference(name: string, reference: RSSReference): string {
  const resource = RSSReferenceResourceSchema.parse({ id: crypto.randomUUID(), name, reference })
  return `${RSS_REFERENCE_MARKER}\n${JSON.stringify(resource)}\n资料只读：必须用 rss_read_reference 按上面的 id 读取这份引用，沿返回的 cursor 或 offset 续读；不要重新拼查询条件或改版本。独立的新查询才使用 rss_query_items / rss_read_article。`
}

export function parseRSSReferenceBlock(text: string): z.infer<typeof RSSReferenceResourceSchema> | null {
  if (!text.startsWith(`${RSS_REFERENCE_MARKER}\n`)) return null
  try { return RSSReferenceResourceSchema.parse(JSON.parse(text.split('\n')[1])) } catch { return null }
}

export function rssReferencePath(reference: RSSReference): string {
  return `rss-reference://${encodeURIComponent(JSON.stringify(reference))}`
}

export type RSSReferenceResource = z.infer<typeof RSSReferenceResourceSchema>

export const RSSReadReferenceSchema = z.object({
  referenceId: z.string().uuid().describe('本轮 RSS 资料引用的 id'),
  cursor: z.string().max(1000).optional().describe('查询续页时使用返回的 nextCursor'),
  offset: z.number().int().nonnegative().optional().describe('正文续读时使用返回的 nextOffset'),
}).strict()

export function rssReferencesFromEnvelope(envelope: unknown): RSSReferenceResource[] {
  const resources = (envelope as { resources?: unknown } | null)?.resources
  if (!Array.isArray(resources)) return []
  return resources.flatMap((resource) => {
    if (resource?.kind !== 'rss_reference' || resource.canRead !== true) return []
    const parsed = RSSReferenceResourceSchema.safeParse({ id: resource.id, name: resource.name, reference: resource.rssReference })
    return parsed.success ? [parsed.data] : []
  })
}
