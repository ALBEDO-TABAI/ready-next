import { parseReadyUri, toReadyUri, type ReadyRef } from './ready-ref'
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
  const value = RSSReferenceSchema.parse(reference)
  if (value.kind === 'query') return toReadyUri({ kind: 'rss-query', query: value.query })
  if (value.kind === 'digest') return toReadyUri({ kind: 'rss-digest', id: value.read.reportId, offset: value.read.offset, limit: value.read.limit })
  if (value.kind === 'excerpt') {
    const { itemId, ...read } = value.read
    return toReadyUri({ kind: 'rss-item', id: itemId, excerpt: read })
  }
  const { itemId, ...read } = value.read
  return toReadyUri({ kind: 'rss-item', id: itemId, article: read })
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
  return rssReferencePath(reference)
}

/** Navigation only: callers must never add these references to the frozen read authority. */
export function rssReferenceFromReadyRef(ref: ReadyRef): RSSReference | null {
  if (ref.kind === 'rss-query') return RSSReferenceSchema.parse({ kind: 'query', query: ref.query })
  if (ref.kind === 'rss-digest') return RSSReferenceSchema.parse({ kind: 'digest', read: { reportId: ref.id, offset: ref.offset, limit: ref.limit } })
  if (ref.kind !== 'rss-item') return null
  if (ref.excerpt) return RSSReferenceSchema.parse({ kind: 'excerpt', read: { itemId: ref.id, ...ref.excerpt } })
  if (ref.article) return RSSReferenceSchema.parse({ kind: 'article', read: { itemId: ref.id, ...ref.article } })
  return null
}

export function parseRSSCitationUrl(href: string): RSSNavigableReference | null {
  const parsed = parseReadyUri(href)
  if (!parsed.ok) return null
  const reference = rssReferenceFromReadyRef(parsed.ref)
  return reference && reference.kind !== 'query' ? reference : null
}
