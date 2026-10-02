import { RSSReadExcerptSchema } from './rss-excerpt'
import { z } from 'zod'
import { RSSQuerySchema, RSSReadArticleSchema } from './rss-workspace'

/** A frozen read request, not a copy of the article or a filesystem path. */
export const RSSReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('excerpt'), read: RSSReadExcerptSchema }).strict(),
  z.object({ kind: z.literal('digest'), read: z.object({ reportId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict() }).strict(),
  z.object({ kind: z.literal('article'), read: RSSReadArticleSchema.extend({ expectedRevision: z.string().min(1) }) }).strict(),
  z.object({ kind: z.literal('query'), query: RSSQuerySchema.safeExtend({ cursor: z.never().optional(), expectedRevision: z.number().int().nonnegative() }) }).strict(),
])
export type RSSReference = z.infer<typeof RSSReferenceSchema>
export type RSSNavigableReference = Exclude<RSSReference, { kind: 'query' }>
export const RSSReferenceResourceSchema = z.object({ id: z.string().uuid(), name: z.string().min(1), reference: RSSReferenceSchema }).strict()

export function rssReferencePath(reference: RSSReference): string {
  return `rss-reference://${encodeURIComponent(JSON.stringify(reference))}`
}

export type RSSReferenceResource = z.infer<typeof RSSReferenceResourceSchema>

export const RSSReadReferenceSchema = z.object({
  referenceId: z.string().uuid().describe('本轮 RSS 资料引用的 id'),
  cursor: z.string().max(1000).optional().describe('查询续页时使用返回的 nextCursor'),
  offset: z.number().int().nonnegative().optional().describe('正文、选区或刊物续页时原样使用返回的 nextOffset'),
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


export function rssCitationUrl(reference: RSSNavigableReference): string {
  return `ready-rss://reference?data=${encodeURIComponent(JSON.stringify(RSSReferenceSchema.parse(reference))).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`
}
export function parseRSSCitationUrl(href: string): RSSNavigableReference | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'ready-rss:' || url.hostname !== 'reference' || url.username || url.password || url.port || url.pathname && url.pathname !== '/') return null
    if (url.hash || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('data')) return null
    const reference = RSSReferenceSchema.parse(JSON.parse(url.searchParams.get('data') || ''))
    return reference.kind === 'query' ? null : reference
  } catch { return null }
}
