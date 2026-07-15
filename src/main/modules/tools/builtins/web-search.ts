/**
 * Stage R W1.1 — `web_search` tool implementation.
 *
 * Tavily API (when key present) is the primary search backend; on Tavily
 * failure (network / 4xx / 5xx / parse) the tool falls back to a DuckDuckGo
 * HTML scrape. Both backends populate the same result shape so downstream
 * consumers (deep-research methodology, present_file pipelines) do not have
 * to branch on `source`. When BOTH fail, the handler throws
 * `ToolDomainError(WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code, ...)`
 * so the dispatch layer (`tool-executor.ts`) maps the failure to the
 * shared `web_search_failed` errorKind
 * via `tool-errors.ts:errorKindFor`. A bare `Error` would otherwise be
 * silently bucketed into `tool_handler_failure` — we want the explicit kind
 * to enable model self-recovery and retry policy gating.
 *
 * Pure module — no electron, no skills-runtime imports.
 */

import { z } from 'zod'

import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import { logAgentMetric } from '../../agent-control/metrics'
import { ToolDomainError } from '../tool-errors'
import { WEB_TOOL_FALLBACK_METRICS } from './web-tool-metrics'
import { fetchWithRetryPolicy } from '../retry-policy'
import {
  ANYSEARCH_DOMAINS,
  callAnySearch,
  parseAnySearchResults,
} from './anysearch-client'

export const webSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('搜索关键词；建议短句，不超过 500 字符'),
  topK: z.number().int().min(1).max(10).optional().default(5).describe('返回结果数量，1~10，默认 5'),
  domain: z.enum(ANYSEARCH_DOMAINS).optional()
    .describe('AnySearch 垂直领域；使用前先调用 web_search_domains 查询能力'),
  subDomain: z.string().min(1).max(120).optional()
    .describe('web_search_domains 返回的 AnySearch 子领域，例如 finance.quote'),
  subDomainParams: z.record(z.string(), z.string().max(500))
    .meta({ additionalProperties: true })
    .optional()
    .describe('AnySearch 子领域参数对象；必填参数即使无值也要传空字符串'),
})

export type WebSearchArgs = z.infer<typeof webSearchSchema>

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
  source: 'anysearch' | 'tavily' | 'ddg'
}

export interface WebSearchResult {
  results: WebSearchResultItem[]
  acquisitionKind: 'discovery' | 'answer'
}

export interface WebSearchContext {
  abortSignal?: AbortSignal
  anysearchEnabled?: boolean
  anysearchKey?: string
  anysearchBaseUrl?: string
  tavilyKey?: string
  tavilyBaseUrl?: string
  ddgEnabled?: boolean
  ddgBaseUrl?: string
  preferredSearchService?: 'anysearch' | 'tavily' | 'duckduckgo'
}

interface TavilyApiResponse {
  results?: Array<{
    title?: unknown
    url?: unknown
    content?: unknown
  }>
}

async function searchViaAnySearch(
  args: WebSearchArgs,
  ctx: WebSearchContext,
): Promise<WebSearchResultItem[]> {
  const rpcArgs: Record<string, unknown> = {
    query: args.query,
    max_results: args.topK,
  }
  if (args.domain) rpcArgs.domain = args.domain
  if (args.subDomain) rpcArgs.sub_domain = args.subDomain
  if (args.subDomainParams) rpcArgs.sub_domain_params = args.subDomainParams
  const markdown = await callAnySearch('search', rpcArgs, ctx)
  return parseAnySearchResults(markdown, args.topK).map((result) => ({
    ...result,
    source: 'anysearch' as const,
  }))
}

async function searchViaTavily(
  args: WebSearchArgs,
  ctx: WebSearchContext,
): Promise<WebSearchResultItem[]> {
  if (!ctx.tavilyKey) {
    throw new Error('tavily_key_missing')
  }
  const baseUrl = (ctx.tavilyBaseUrl || 'https://api.tavily.com').replace(/\/+$/, '')
  const response = await fetchWithRetryPolicy(`${baseUrl}/search`, {
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
  const baseUrl = (ctx.ddgBaseUrl || 'https://html.duckduckgo.com').replace(/\/+$/, '')
  const url = `${baseUrl}/html/?q=${encodeURIComponent(args.query)}`
  const response = await fetchWithRetryPolicy(url, {
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
  const isVertical = Boolean(args.domain || args.subDomain || args.subDomainParams)
  if (isVertical) {
    if (!ctx.anysearchEnabled) {
      throw new ToolDomainError(
        WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code,
        'AnySearch is required for vertical search but is not enabled',
        { query: args.query, domain: args.domain || null, subDomain: args.subDomain || null },
      )
    }
    try {
      return {
        results: await searchViaAnySearch(args, ctx),
        acquisitionKind: 'answer',
      }
    } catch (error) {
      throw new ToolDomainError(
        WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code,
        `AnySearch vertical search failed without semantic downgrade: ${error instanceof Error ? error.message : String(error)}`,
        { query: args.query, domain: args.domain || null, subDomain: args.subDomain || null },
      )
    }
  }

  type Backend = 'anysearch' | 'tavily' | 'duckduckgo'
  const preferred = ctx.preferredSearchService
  const defaultOrder: Backend[] = ['anysearch', 'tavily', 'duckduckgo']
  const order = preferred
    ? [preferred, ...defaultOrder.filter((backend) => backend !== preferred)]
    : defaultOrder
  const errors: Partial<Record<Backend, string>> = {}
  let sawEmpty = false

  for (let index = 0; index < order.length; index += 1) {
    const backend = order[index]!
    if (backend === 'anysearch' && !ctx.anysearchEnabled) continue
    if (backend === 'tavily' && !ctx.tavilyKey) continue
    if (backend === 'duckduckgo' && ctx.ddgEnabled === false) continue
    try {
      const results = backend === 'anysearch'
        ? await searchViaAnySearch(args, ctx)
        : backend === 'tavily'
          ? await searchViaTavily(args, ctx)
          : await searchViaDdg(args, ctx)
      if (results.length > 0) return { results, acquisitionKind: 'discovery' }
      sawEmpty = true
    } catch (error) {
      // silent-catch: preserve this backend's error for fallback metrics and the final structured failure, then try the next configured backend.
      errors[backend] = error instanceof Error ? error.message : String(error)
    }

    const next = order.slice(index + 1).find((candidate) => (
      candidate === 'anysearch' ? ctx.anysearchEnabled
        : candidate === 'tavily' ? Boolean(ctx.tavilyKey)
          : ctx.ddgEnabled !== false
    ))
    if (backend === 'anysearch' && next) {
      logAgentMetric(WEB_TOOL_FALLBACK_METRICS.WEB_SEARCH_ANYSEARCH_FALLBACK, {
        next,
        reason: errors.anysearch || 'empty_results',
      })
    }
    if (backend === 'tavily' && next === 'duckduckgo') {
      logAgentMetric(WEB_TOOL_FALLBACK_METRICS.WEB_SEARCH_TAVILY_TO_DDG, {
        reason: errors.tavily || 'empty_results',
      })
    }
  }

  if (sawEmpty) return { results: [], acquisitionKind: 'discovery' }
  throw new ToolDomainError(
    WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code,
    `All configured web search backends failed: anysearch=${errors.anysearch || 'not_attempted'}, tavily=${errors.tavily || 'not_attempted'}, ddg=${errors.duckduckgo || 'not_attempted'}`,
    { query: args.query, backendErrors: errors },
  )
}
