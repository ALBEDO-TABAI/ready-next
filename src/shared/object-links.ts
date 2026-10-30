import { z } from 'zod'
import { ReadyRefSchema } from './ready-ref'

export const ObjectLinkEndpointSchema = z.union([
  z.strictObject({ objectId: z.string().min(1) }),
  z.strictObject({ ref: ReadyRefSchema }),
])
export type ObjectLinkEndpoint = z.infer<typeof ObjectLinkEndpointSchema>
export const ObjectLinkQuerySchema = z.strictObject({
  endpoint: ObjectLinkEndpointSchema,
  limit: z.number().int().min(1).max(1000).optional(),
})
export type ObjectLinkQuery = z.infer<typeof ObjectLinkQuerySchema>
export const OBJECT_LINK_KINDS = ['wikilink', 'mdlink', 'embed', 'block-ref', 'frontmatter', 'ready-ref', 'annotation-source', 'canvas-node', 'calendar-link', 'card-source', 'agent-source'] as const
export type ObjectLinkKind = typeof OBJECT_LINK_KINDS[number]
export interface ObjectLink {
  id: string
  source: ObjectLinkEndpoint
  target: ObjectLinkEndpoint | null
  kind: ObjectLinkKind
  rawTarget: string
  fragment: string | null
  sourceLine: number | null
  sourceOffset: number | null
  resolved: boolean
  unresolvedReason: string | null
}
export type ObjectLinksResponse = { success: true; data: ObjectLink[] } | { success: false; error: string }
export interface ExtractedObjectLink {
  kind: ObjectLinkKind
  rawTarget: string
  targetText: string
  fragment: string | null
  sourceLine: number | null
  sourceOffset: number | null
}
