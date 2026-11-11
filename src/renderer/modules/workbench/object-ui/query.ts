import { searchPresentation } from '../../../../shared/search-presentation'
import type { DocTab } from '../../../stores/useDocTabs'
import { parseDocumentGraph, normalizeSearchText } from '../../../../shared/document-graph-parse'

export interface SearchResultItem {
  path: string
  name: string
  title: string
  typeLabel: import('../../../../shared/search-presentation').SearchPresentation['typeLabel']
  nameMatch: boolean
  snippet: string
  tagsHit: string[]
  linksHit: string[]
  sourceType: string
  sourceMeta?: Record<string, unknown> | null
  draft?: { tabId: string }
}

const MARK_START = '\u0001'
const MARK_END = '\u0002'

interface ParsedLocalQuery {
  tags: string[]
  wikilinks: string[]
  terms: string[]
}

function parseLocalQuery(raw: string): ParsedLocalQuery {
  const tags: string[] = []
  const wikilinks: string[] = []
  const terms: string[] = []
  const trimmed = raw.trim()
  if (!trimmed) return { tags, wikilinks, terms }
  const pieces: string[] = []
  let buffer = ''
  let inQuote = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === '"') {
      inQuote = !inQuote
      buffer += ch
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (buffer.length > 0) { pieces.push(buffer); buffer = '' }
      continue
    }
    buffer += ch
  }
  if (buffer.length > 0) pieces.push(buffer)

  for (const piece of pieces) {
    const normalized = normalizeSearchText(piece)
    if (!normalized) continue
    if (!/[\p{L}\p{N}]/u.test(normalized)) continue
    if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
      const inner = normalized.slice(1, -1).trim()
      if (inner) terms.push(inner.toLowerCase())
      continue
    }
    if (normalized.startsWith('#') && normalized.length > 1) {
      tags.push(normalized.slice(1).toLowerCase())
      continue
    }
    if (normalized.startsWith('[[') && normalized.endsWith(']]') && normalized.length > 4) {
      wikilinks.push(normalized.slice(2, -2).trim().toLowerCase())
      continue
    }
    terms.push(normalized.toLowerCase())
  }
  return { tags, wikilinks, terms }
}

function buildDraftSnippet(body: string, terms: string[]): string {
  if (!body) return ''
  if (terms.length === 0) return body.slice(0, 120).replace(/\s+/g, ' ')
  const normalizedBody = body.toLowerCase()
  const first = terms[0]
  const idx = normalizedBody.indexOf(first)
  if (idx < 0) return body.slice(0, 120).replace(/\s+/g, ' ')
  const start = Math.max(0, idx - 40)
  const end = Math.min(body.length, idx + first.length + 80)
  const prefix = body.slice(start, idx).replace(/\s+/g, ' ')
  const match = body.slice(idx, idx + first.length)
  const suffix = body.slice(idx + first.length, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${prefix}${MARK_START}${match}${MARK_END}${suffix}${end < body.length ? '…' : ''}`
}

function matchDraftTab(tab: DocTab, parsed: ParsedLocalQuery): SearchResultItem | null {
  const content = tab.content ?? ''
  const graph = parseDocumentGraph(content)
  const normalizedBody = graph.body.toLowerCase()
  const normalizedName = normalizeSearchText(tab.title).toLowerCase()

  for (const tag of parsed.tags) {
    if (!graph.tags.some((t) => t.toLowerCase() === tag)) return null
  }
  for (const link of parsed.wikilinks) {
    if (!graph.wikilinks.some((w) => w.target.toLowerCase() === link)) return null
  }
  let nameHits = 0
  for (const term of parsed.terms) {
    if (normalizedBody.includes(term)) continue
    if (normalizedName.includes(term)) { nameHits += 1; continue }
    return null
  }
  if (parsed.tags.length === 0 && parsed.wikilinks.length === 0 && parsed.terms.length === 0) {
    return null
  }

  const nameMatch = parsed.terms.length > 0 && parsed.terms.every((t) => normalizedName.includes(t)) ? true : nameHits > 0
  const snippet = buildDraftSnippet(graph.body, parsed.terms)
  const tagsHit = parsed.tags.filter((tag) => graph.tags.some((t) => t.toLowerCase() === tag))
  const linksHit = parsed.wikilinks.filter((link) => graph.wikilinks.some((w) => w.target.toLowerCase() === link))

  return {
    ...searchPresentation({ path: tab.path ?? '', name: tab.title || '新文档', sourceType: 'document' }, graph.frontmatter),
    path: tab.path ?? `draft://${tab.id}`,
    name: tab.title || '新文档',
    nameMatch,
    snippet,
    tagsHit,
    linksHit,
    sourceType: 'document',
    draft: { tabId: tab.id },
  }
}

export function draftSearchResults(query: string, tabs: DocTab[]): SearchResultItem[] {
  if (!query.trim()) return []
  const parsed = parseLocalQuery(query)
  return tabs.filter(tab => tab.kind !== 'library' && (!tab.path || tab.isDirty))
    .flatMap(tab => { const hit = matchDraftTab(tab, parsed); return hit ? [hit] : [] })
}

export function mergeDraftResults(items: SearchResultItem[], drafts: SearchResultItem[], tabs: DocTab[]): SearchResultItem[] {
  const dirtyPaths = new Set(tabs.filter(tab => tab.isDirty).map(tab => tab.path))
  return [...drafts, ...items.filter(item => !dirtyPaths.has(item.path))]
}

export async function queryObjectIndex(query: string, roots: string[]) {
  if (!query.trim() || !roots.length) return { items: [], stats: { returned: 0, elapsedMs: 0 }, degraded: false }
  const result = await window.electronAPI.document.searchIndex({ query: query.trim(), workspaceRoots: roots })
  if (!result.success || !result.data) throw new Error(result.error || '搜索失败')
  return result.data
}
