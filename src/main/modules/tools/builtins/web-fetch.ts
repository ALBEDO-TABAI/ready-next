/**
 * Stage R W1.2 — `web_fetch` tool implementation.
 *
 * Jina reader (`https://r.jina.ai/<url>`) is the primary backend; on failure
 * the tool falls back to the Tavily Extract API. Content is hard-truncated
 * to 4096 characters per the deep-research methodology spec — long pages
 * are summarized by downstream agents, not by raw content overflow.
 *
 * Failure semantics mirror `web_search`: both backends failing throws
 * `ToolDomainError(WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code, ...)`
 * so the dispatch layer maps to the shared explicit `errorKind`.
 *
 * Pure module — no electron, no skills-runtime imports.
 */

import { z } from 'zod'

import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
import { logAgentMetric } from '../../agent-control/metrics'
import { ToolDomainError } from '../tool-errors'
import { WEB_TOOL_FALLBACK_METRICS } from './web-tool-metrics'
import { fetchWithRetryPolicy } from '../retry-policy'
import { callAnySearch, readAnySearchMarkdownTitle } from './anysearch-client'

export const webFetchSchema = z.object({
  url: z.string().url().describe('要抓取的页面 URL；只接受 http/https 协议'),
  reason: z.string().optional().describe('抓取动机（可选），便于在调度中观察意图'),
})

export type WebFetchArgs = z.infer<typeof webFetchSchema>

export interface WebFetchResult {
  url: string
  title?: string
  content: string
}

export interface WebFetchContext {
  abortSignal?: AbortSignal
  anysearchEnabled?: boolean
  anysearchKey?: string
  anysearchBaseUrl?: string
  tavilyKey?: string
  jinaKey?: string
  tavilyBaseUrl?: string
  jinaBaseUrl?: string
  preferredFetchService?: 'anysearch' | 'jina' | 'tavily'
  preferTavilyExtract?: boolean
}

export const WEB_FETCH_CONTENT_HARD_CAP = 4096

function truncateContent(content: string): string {
  if (content.length <= WEB_FETCH_CONTENT_HARD_CAP) return content
  return `${content.slice(0, WEB_FETCH_CONTENT_HARD_CAP)}...[truncated]`
}

interface TavilyExtractResponse {
  results?: Array<{
    url?: unknown
    raw_content?: unknown
    content?: unknown
    title?: unknown
  }>
}

async function fetchViaJina(
  args: WebFetchArgs,
  ctx: WebFetchContext,
): Promise<WebFetchResult> {
  const headers: Record<string, string> = {
    'Accept': 'text/plain',
  }
  if (ctx.jinaKey) {
    headers['Authorization'] = `Bearer ${ctx.jinaKey}`
  }
  const baseUrl = (ctx.jinaBaseUrl || 'https://r.jina.ai').replace(/\/+$/, '')
  const response = await fetchWithRetryPolicy(`${baseUrl}/${args.url}`, {
    method: 'GET',
    headers,
    signal: ctx.abortSignal,
  })
  if (!response.ok) {
    throw new Error(`jina_http_${response.status}`)
  }
  const text = await response.text()
  if (!text || text.trim().length === 0) {
    throw new Error('jina_empty_body')
  }
  // Jina returns markdown; the first non-empty line typically reads
  // `Title: <doc title>`. Pull that out for downstream consumers and keep
  // the rest as `content`.
  const lines = text.split('\n')
  let title: string | undefined
  for (const line of lines) {
    const match = /^Title:\s*(.+)$/i.exec(line.trim())
    if (match) {
      title = match[1]
      break
    }
  }
  return {
    url: args.url,
    title,
    content: truncateContent(text),
  }
}

async function fetchViaTavilyExtract(
  args: WebFetchArgs,
  ctx: WebFetchContext,
): Promise<WebFetchResult> {
  if (!ctx.tavilyKey) {
    throw new Error('tavily_key_missing')
  }
  const baseUrl = (ctx.tavilyBaseUrl || 'https://api.tavily.com').replace(/\/+$/, '')
  const response = await fetchWithRetryPolicy(`${baseUrl}/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: ctx.tavilyKey,
      urls: [args.url],
    }),
    signal: ctx.abortSignal,
  })
  if (!response.ok) {
    throw new Error(`tavily_extract_http_${response.status}`)
  }
  const data = (await response.json()) as TavilyExtractResponse
  const first = Array.isArray(data.results) ? data.results[0] : null
  if (!first) {
    throw new Error('tavily_extract_empty_results')
  }
  const raw = typeof first.raw_content === 'string'
    ? first.raw_content
    : typeof first.content === 'string'
      ? first.content
      : ''
  if (!raw) {
    throw new Error('tavily_extract_empty_content')
  }
  return {
    url: args.url,
    title: typeof first.title === 'string' ? first.title : undefined,
    content: truncateContent(raw),
  }
}

async function fetchViaAnySearch(
  args: WebFetchArgs,
  ctx: WebFetchContext,
): Promise<WebFetchResult> {
  const content = await callAnySearch('extract', { url: args.url }, ctx)
  return {
    url: args.url,
    title: readAnySearchMarkdownTitle(content),
    content: truncateContent(content),
  }
}

export async function executeWebFetch(
  args: WebFetchArgs,
  ctx: WebFetchContext,
): Promise<WebFetchResult> {
  type Backend = 'anysearch' | 'jina' | 'tavily'
  const preferred = ctx.preferredFetchService || (ctx.preferTavilyExtract ? 'tavily' : undefined)
  const defaultOrder: Backend[] = ['jina', 'anysearch', 'tavily']
  const order = preferred
    ? [preferred, ...defaultOrder.filter((backend) => backend !== preferred)]
    : defaultOrder
  const errors: Partial<Record<Backend, string>> = {}

  for (let index = 0; index < order.length; index += 1) {
    const backend = order[index]!
    if (backend === 'anysearch' && !ctx.anysearchEnabled) continue
    if (backend === 'tavily' && !ctx.tavilyKey) continue
    try {
      return backend === 'anysearch'
        ? await fetchViaAnySearch(args, ctx)
        : backend === 'jina'
          ? await fetchViaJina(args, ctx)
          : await fetchViaTavilyExtract(args, ctx)
    } catch (error) {
      // silent-catch: preserve this backend's error for fallback metrics and the final structured failure, then try the next configured backend.
      errors[backend] = error instanceof Error ? error.message : String(error)
    }

    const next = order.slice(index + 1).find((candidate) => (
      candidate === 'anysearch' ? ctx.anysearchEnabled
        : candidate === 'tavily' ? Boolean(ctx.tavilyKey)
          : true
    ))
    if (backend === 'anysearch' && next) {
      logAgentMetric(WEB_TOOL_FALLBACK_METRICS.WEB_FETCH_ANYSEARCH_FALLBACK, {
        next,
        reason: errors.anysearch,
      })
    }
    if (backend === 'jina' && next === 'tavily') {
      logAgentMetric(WEB_TOOL_FALLBACK_METRICS.WEB_FETCH_JINA_TO_TAVILY, {
        reason: errors.jina,
      })
    }
  }

  throw new ToolDomainError(
    WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code,
    `All configured web fetch backends failed: jina=${errors.jina || 'not_attempted'}, anysearch=${errors.anysearch || 'not_attempted'}, tavily=${errors.tavily || 'not_attempted'}`,
    {
      url: args.url,
      backendErrors: errors,
    },
  )
}
