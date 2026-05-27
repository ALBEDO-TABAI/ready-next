import { normalizeSearchText } from '../../../shared/document-graph-parse'

export type QueryTokenKind = 'tag' | 'wikilink' | 'phrase' | 'term' | 'source'

export interface QueryToken {
  kind: QueryTokenKind
  value: string
  raw: string
}

export interface ParsedQuery {
  raw: string
  tokens: QueryToken[]
  tags: string[]
  wikilinks: string[]
  sources: string[]
  ftsMatch: string | null
}

const WHITESPACE = /\s+/

function splitRawTokens(input: string): string[] {
  const pieces: string[] = []
  let buffer = ''
  let inQuote = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '"') {
      inQuote = !inQuote
      buffer += ch
      continue
    }
    if (!inQuote && WHITESPACE.test(ch)) {
      if (buffer.length > 0) {
        pieces.push(buffer)
        buffer = ''
      }
      continue
    }
    buffer += ch
  }
  if (buffer.length > 0) pieces.push(buffer)
  return pieces
}

function classifyToken(raw: string): QueryToken | null {
  const normalized = normalizeSearchText(raw)
  if (!normalized) return null
  // Discard punctuation-only noise (`#`, `[[`, `""`, etc.)
  if (!/[\p{L}\p{N}]/u.test(normalized)) return null
  if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
    const inner = normalized.slice(1, -1).trim()
    if (!inner) return null
    return { kind: 'phrase', value: inner, raw }
  }
  if (normalized.startsWith('#') && normalized.length > 1) {
    return { kind: 'tag', value: normalized.slice(1), raw }
  }
  if (normalized.startsWith('[[') && normalized.endsWith(']]') && normalized.length > 4) {
    return { kind: 'wikilink', value: normalized.slice(2, -2).trim(), raw }
  }
  const srcMatch = /^src:([a-z]+)$/i.exec(normalized)
  if (srcMatch) {
    return { kind: 'source', value: srcMatch[1].toLowerCase(), raw }
  }
  return { kind: 'term', value: normalized, raw }
}

const CJK_REGEX = /[㐀-鿿぀-ヿ가-힯]/
const CJK_SEQUENCE_REGEX = /[㐀-鿿぀-ヿ가-힯]+/g

export const SEARCH_INDEX_CONTENT_VERSION = 'fts-cjk-bigram-v1'

function containsCjk(value: string): boolean {
  return CJK_REGEX.test(value)
}

function escapeFtsPhrase(value: string): string {
  return value.replace(/"/g, '""')
}

function toBigrams(value: string): string[] {
  if (value.length <= 1) return [value]
  const grams: string[] = []
  for (let i = 0; i < value.length - 1; i += 1) {
    grams.push(value.slice(i, i + 2))
  }
  return grams
}

export function buildFtsSearchText(value: string): string {
  const normalized = normalizeSearchText(value)
  if (!containsCjk(normalized)) return value
  const extra = new Set<string>()
  for (const match of normalized.matchAll(CJK_SEQUENCE_REGEX)) {
    for (const gram of toBigrams(match[0])) {
      if (containsCjk(gram)) extra.add(gram)
    }
  }
  if (extra.size === 0) return value
  return `${value}\n${Array.from(extra).join(' ')}`
}

function termToFtsClauses(term: string): string {
  if (!containsCjk(term)) {
    return `"${escapeFtsPhrase(term)}"`
  }
  const grams = toBigrams(term).map((g) => `"${escapeFtsPhrase(g)}"`)
  return grams.length > 1 ? grams.join(' ') : grams.join('')
}

function phraseToFts(value: string): string {
  if (!containsCjk(value)) {
    return `"${escapeFtsPhrase(value)}"`
  }
  const compact = value.replace(/\s+/g, '')
  return termToFtsClauses(compact)
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const tokens: QueryToken[] = []
  const rawPieces = splitRawTokens(raw.trim())
  for (const piece of rawPieces) {
    const token = classifyToken(piece)
    if (token) tokens.push(token)
  }

  const tags = tokens.filter((t) => t.kind === 'tag').map((t) => t.value)
  const wikilinks = tokens.filter((t) => t.kind === 'wikilink').map((t) => t.value)
  const sources = tokens.filter((t) => t.kind === 'source').map((t) => t.value)
  const ftsPieces: string[] = []
  for (const token of tokens) {
    if (token.kind === 'phrase') ftsPieces.push(phraseToFts(token.value))
    else if (token.kind === 'term') ftsPieces.push(termToFtsClauses(token.value))
  }
  const ftsMatch = ftsPieces.length > 0 ? ftsPieces.join(' ') : null

  return {
    raw,
    tokens,
    tags,
    wikilinks,
    sources,
    ftsMatch,
  }
}

export interface SearchHit {
  path: string
  name: string
  snippet: string
  rank: number
  nameMatch: boolean
  tagsHit: string[]
  linksHit: string[]
}
