import { RSSReferenceResourceSchema, type RSSReferenceResource } from '../../../../shared/rss-reference'
import type { RSSStore } from '../../database/rss-store'
import type { ResourceVersionReference } from './codex-turn-input-builder'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export const RSS_READ_TOOL_NAMES = ['rss_query_items', 'rss_read_article', 'rss_read_reference', 'rss_read_processing', 'rss_read_excerpt', 'rss_read_digests', 'rss_read_events', 'rss_read_analysis_report', 'rss_read_catalog', 'rss_read_analysis_assets'] as const

export function rssResourceVersion(resource: RSSReferenceResource): ResourceVersionReference {
  const digest = digestCanonicalJson(resource)
  return { logicalResourceId: resource.id, currentVersion: `sha256:${digest}`, currentDigest: digest, supersedesVersion: null, policyEpoch: 1 }
}

/** Validate the exact saved scope; no content is copied into the native request. */
export function validateRSSResource(store: RSSStore, value: RSSReferenceResource): RSSReferenceResource {
  const resource = RSSReferenceResourceSchema.parse(value), reference = resource.reference
  if (reference.kind === 'query') store.content.query(reference.query)
  else if (reference.kind === 'article') store.content.readArticle(reference.read)
  else if (reference.kind === 'excerpt') store.content.readExcerpt(reference.read)
  else store.digests.read({ view: 'entries', ...reference.read })
  return resource
}

export function rssResourceBindingsMatch(resources: readonly RSSReferenceResource[], references: readonly ResourceVersionReference[], allowedTools: readonly string[]): boolean {
  if (!resources.length) return true
  if (new Set(resources.map((r) => r.id)).size !== resources.length || RSS_READ_TOOL_NAMES.some((name) => !allowedTools.includes(name))) return false
  return resources.every((resource) => {
    const expected = rssResourceVersion(resource), actual = references.find((ref) => ref.logicalResourceId === resource.id)
    return actual?.currentDigest === expected.currentDigest && actual.currentVersion === expected.currentVersion && actual.policyEpoch === expected.policyEpoch
  })
}

type RSSWorkbenchSelection = { kind: 'rss_reference'; id: string; name: string; reference: RSSReferenceResource['reference']; origin?: 'workbench' }

const STALE_RSS_REFERENCE = new Set(['article_changed', 'cursor_stale'])

/**
 * Workbench references follow what the user is looking at, so they never block a send:
 * a view that moved since capture is rebound to the saved current version, an unreadable
 * one is dropped, and a thread frozen without RSS read tools simply runs without it.
 * References the user attached on purpose keep their exact version and are returned as
 * `explicitBlocked` when the thread cannot read them.
 */
export function settleWorkbenchRSSSelections<T extends { kind: string }>(input: {
  store: RSSStore
  selections: readonly T[]
  threadCanReadRSS: boolean
}): { selections: T[]; explicitBlocked: boolean } {
  let explicitBlocked = false
  const selections: T[] = []
  for (const selection of input.selections) {
    if (selection.kind !== 'rss_reference') { selections.push(selection); continue }
    const rss = selection as unknown as RSSWorkbenchSelection
    if (rss.origin !== 'workbench') {
      if (!input.threadCanReadRSS) explicitBlocked = true
      selections.push(selection)
      continue
    }
    if (!input.threadCanReadRSS) continue
    const { origin: _origin, ...selected } = rss
    const current = currentWorkbenchReference(input.store, { id: rss.id, name: rss.name, reference: rss.reference })
    if (current) selections.push({ ...selected, reference: current } as unknown as T)
  }
  return { selections, explicitBlocked }
}

function currentWorkbenchReference(store: RSSStore, resource: RSSReferenceResource): RSSReferenceResource['reference'] | null {
  try {
    validateRSSResource(store, resource)
    return resource.reference
  } catch (error) {
    const stale = error instanceof Error && STALE_RSS_REFERENCE.has(error.message)
    if (!stale) return null
    const reference = resource.reference
    try {
      if (reference.kind === 'query') {
        const { expectedRevision: _stale, ...query } = reference.query
        return { kind: 'query', query: { ...query, expectedRevision: store.content.query({ ...query, limit: 1 }).revision } }
      }
      if (reference.kind === 'article' || reference.kind === 'excerpt') {
        const article = store.content.readArticle({ itemId: reference.read.itemId, length: 1 }).article
        return { kind: 'article', read: { itemId: article.id, expectedRevision: article.revision, offset: 0, length: 12000 } }
      }
    } catch {
      // silent-catch: an unreadable workbench view is dropped; the send continues without it.
    }
    return null
  }
}
