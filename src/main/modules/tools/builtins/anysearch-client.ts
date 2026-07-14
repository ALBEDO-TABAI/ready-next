import { fetchWithRetryPolicy } from '../retry-policy'

export const ANYSEARCH_DOMAINS = [
  'general',
  'resource',
  'social_media',
  'finance',
  'academic',
  'legal',
  'health',
  'business',
  'security',
  'ip',
  'code',
  'energy',
  'environment',
  'agriculture',
  'travel',
  'film',
  'gaming',
] as const

export type AnySearchDomain = (typeof ANYSEARCH_DOMAINS)[number]

export interface AnySearchClientContext {
  abortSignal?: AbortSignal
  anysearchEnabled?: boolean
  anysearchKey?: string
  anysearchBaseUrl?: string
}

interface AnySearchRpcResponse {
  error?: {
    code?: unknown
    message?: unknown
  }
  result?: {
    content?: Array<{
      type?: unknown
      text?: unknown
    }>
  }
}

export async function callAnySearch(
  toolName: 'search' | 'batch_search' | 'extract' | 'get_sub_domains',
  args: Record<string, unknown>,
  ctx: AnySearchClientContext,
): Promise<string> {
  if (!ctx.anysearchEnabled) throw new Error('anysearch_disabled')
  const endpoint = String(ctx.anysearchBaseUrl || 'https://api.anysearch.com/mcp').trim()
  const parsedEndpoint = new URL(endpoint)
  if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
    throw new Error('anysearch_endpoint_protocol_invalid')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Anysearch-Client': 'ready/1.0',
  }
  const apiKey = String(ctx.anysearchKey || '').trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetchWithRetryPolicy(parsedEndpoint.href, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: ctx.abortSignal,
  })
  if (!response.ok) throw new Error(`anysearch_http_${response.status}`)

  const payload = await response.json() as AnySearchRpcResponse
  if (payload.error) {
    const message = typeof payload.error.message === 'string' ? payload.error.message : 'rpc_error'
    throw new Error(`anysearch_rpc_${message}`)
  }
  const textItem = payload.result?.content
    ?.find((item) => item?.type === 'text' && typeof item.text === 'string')
  const content = typeof textItem?.text === 'string' ? textItem.text : ''
  if (!content || !content.trim()) throw new Error('anysearch_empty_content')
  return content
}

export interface ParsedAnySearchResult {
  title: string
  url: string
  snippet: string
}

export function parseAnySearchResults(markdown: string, limit: number): ParsedAnySearchResult[] {
  const results: ParsedAnySearchResult[] = []
  let current: { title: string; url: string; snippet: string[] } | null = null

  const flush = () => {
    if (!current?.title || !current.url || results.length >= limit) return
    results.push({
      title: current.title,
      url: current.url,
      snippet: current.snippet.join(' ').trim(),
    })
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const heading = /^###\s+\d+\.\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      current = { title: heading[1]!.trim(), url: '', snippet: [] }
      continue
    }
    if (!current || !line) continue
    const url = /^-\s+\*\*URL\*\*:\s*(\S+)/i.exec(line)
    if (url) {
      current.url = url[1]!.trim()
      continue
    }
    if (line.startsWith('## ') || line === '---') continue
    current.snippet.push(line.replace(/^-\s+/, ''))
  }
  flush()
  return results.slice(0, limit)
}

export function readAnySearchMarkdownTitle(markdown: string): string | undefined {
  for (const rawLine of markdown.split(/\r?\n/)) {
    const match = /^#{1,3}\s+(.+)$/.exec(rawLine.trim())
    if (!match) continue
    const title = match[1]!.trim()
    if (!/^Search Results\b/i.test(title)) return title
  }
  return undefined
}
