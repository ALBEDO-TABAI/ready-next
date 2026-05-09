/**
 * Stage R W1.1 — `web_search` tool implementation.
 *
 * Tavily API (when key present) is the primary search backend; on Tavily
 * failure (network / 4xx / 5xx / parse) the tool falls back to a DuckDuckGo
 * HTML scrape. Both backends populate the same result shape so downstream
 * consumers (deep-research methodology, present_file pipelines) do not have
 * to branch on `source`. When BOTH fail, the handler throws
 * `ToolDomainError('web_search_failed', ...)` so the dispatch layer
 * (`tool-executor.ts`) maps the failure to `errorKind: 'web_search_failed'`
 * via `tool-errors.ts:errorKindFor`. A bare `Error` would otherwise be
 * silently bucketed into `tool_handler_failure` — we want the explicit kind
 * to enable model self-recovery and retry policy gating.
 *
 * Pure module — no electron, no skills-runtime imports.
 */

import { z } from 'zod'

import { logAgentMetric } from '../../agent-control/metrics'
import { ToolDomainError } from '../tool-errors'
import { WEB_TOOL_FALLBACK_METRICS } from './web-tool-metrics'

export const webSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('搜索关键词；建议短句，不超过 500 字符'),
  topK: z.number().int().min(1).max(10).optional().default(5).describe('返回结果数量，1~10，默认 5'),
})

export type WebSearchArgs = z.infer<typeof webSearchSchema>

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
  source: 'tavily' | 'ddg'
}

export interface WebSearchResult {
  results: WebSearchResultItem[]
}

export interface WebSearchContext {
  abortSignal?: AbortSignal
  tavilyKey?: string
}

interface TavilyApiResponse {
  results?: Array<{
    title?: unknown
    url?: unknown
    content?: unknown
  }>
}

async function searchViaTavily(
  args: WebSearchArgs,
  ctx: WebSearchContext,
): Promise<WebSearchResultItem[]> {
  if (!ctx.tavilyKey) {
    throw new Error('tavily_key_missing')
  }
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: ctx.tavilyKey,
      query: args.query,
      max_results: args.topK,
      search_depth: 'basic',
    }),
    signal: ctx.abortSignal,
  })
  if (!response.ok) {
    throw new Error(`tavily_http_${response.status}`)
  }
  const data = (await response.json()) as TavilyApiResponse
  const results = Array.isArray(data.results) ? data.results : []
  return results.slice(0, args.topK).map((row) => ({
    title: typeof row?.title === 'string' ? row.title : '',
    url: typeof row?.url === 'string' ? row.url : '',
    snippet: typeof row?.content === 'string' ? row.content : '',
    source: 'tavily' as const,
  }))
}

const DDG_RESULT_REGEX = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
const DDG_SNIPPET_REGEX = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

function decodeDdgRedirect(rawHref: string): string {
  // DDG HTML wraps results in `/l/?uddg=<encoded>&...`. Recover the inner URL
  // when present so downstream tools can fetch the canonical site directly.
  try {
    const url = rawHref.startsWith('http')
      ? new URL(rawHref)
      : new URL(rawHref, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return url.href
  } catch {
    // silent-catch: malformed redirect href → return raw URL unchanged for downstream
    return rawHref
  }
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

async function searchViaDdg(
  args: WebSearchArgs,
  ctx: WebSearchContext,
): Promise<WebSearchResultItem[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      // DDG HTML page returns 403 for missing UA.
      'User-Agent': 'Mozilla/5.0 (compatible; ReadyAgent/1.0; +https://example.invalid)',
      'Accept': 'text/html',
    },
    signal: ctx.abortSignal,
  })
  if (!response.ok) {
    throw new Error(`ddg_http_${response.status}`)
  }
  const html = await response.text()
  const items: WebSearchResultItem[] = []
  // Pull snippets in a parallel pass; DDG groups them by result block but
  // they're deterministic by index against `result__a` matches.
  const snippetMatches: string[] = []
  for (const m of html.matchAll(DDG_SNIPPET_REGEX)) {
    snippetMatches.push(stripHtmlTags(m[1] || ''))
  }
  let index = 0
  for (const m of html.matchAll(DDG_RESULT_REGEX)) {
    if (items.length >= args.topK) break
    const href = decodeDdgRedirect(m[1] || '')
    const title = stripHtmlTags(m[2] || '')
    if (!href || !title) {
      index += 1
      continue
    }
    items.push({
      title,
      url: href,
      snippet: snippetMatches[index] || '',
      source: 'ddg',
    })
    index += 1
  }
  return items
}

export async function executeWebSearch(
  args: WebSearchArgs,
  ctx: WebSearchContext,
): Promise<WebSearchResult> {
  let tavilyError: unknown = null
  if (ctx.tavilyKey) {
    try {
      const results = await searchViaTavily(args, ctx)
      // Stage R W1.1 follow-up: do NOT throw on empty Tavily results either —
      // returning an empty array as the model-facing answer keeps the loop
      // forward-progressing. We only fall through to DDG for empty results
      // because DDG sometimes finds long-tail hits Tavily misses; we do NOT
      // synthesize an error to drive that fallback.
      if (results.length > 0) return { results }
      tavilyError = null  // empty, not an error
    } catch (error) {
      // silent-catch: capture for fallback handoff; metric is logged below before DDG try
      tavilyError = error
    }
    logAgentMetric(WEB_TOOL_FALLBACK_METRICS.WEB_SEARCH_TAVILY_TO_DDG, {
      reason: tavilyError instanceof Error ? tavilyError.message : String(tavilyError),
    })
  }

  let ddgError: unknown = null
  try {
    const results = await searchViaDdg(args, ctx)
    // Stage R W1.1 follow-up: empty results are NOT a failure — query may
    // simply have no match. Return [] and let the model decide whether to
    // refine the query. Throwing for empty was forcing the parent loop into
    // wasteful retries on rare topics. Real network/HTTP errors still throw
    // from inside searchViaDdg and land in the catch below.
    return { results }
  } catch (error) {
    // silent-catch: capture for ToolDomainError aggregation thrown immediately below
    ddgError = error
  }

  throw new ToolDomainError(
    'web_search_failed',
    `Both Tavily and DDG failed: tavily=${tavilyError instanceof Error ? tavilyError.message : String(tavilyError ?? 'not_attempted')}, ddg=${ddgError instanceof Error ? ddgError.message : String(ddgError)}`,
    {
      query: args.query,
      tavilyError: tavilyError ? String(tavilyError) : null,
      ddgError: String(ddgError),
    },
  )
}
