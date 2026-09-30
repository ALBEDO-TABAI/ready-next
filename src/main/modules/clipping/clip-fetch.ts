/**
 * Shared HTTP fetch helpers for the obsidian-web-clip pipeline.
 *
 * Pure module — no electron, no skills-runtime. Used by:
 *   - `web-clip-url.ts` (model-facing tool, foreground)
 *   - `ipc-clip-dragged-tab.ts` (host-IPC background, fire-and-forget)
 *
 * Two channels:
 *   - `fetchClipHtml`: raw HTML + inline `<title>`, follows redirects.
 *   - `fetchJinaMarkdown`: optional Jina reader best-effort fallback.
 */

const ABSENT_TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i
const DEFAULT_TIMEOUT_MS = 45_000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface ClipFetchResult {
  html: string
  finalUrl: string
  titleFromHead?: string
}

export class ClipFetchError extends Error {
  constructor(
    public readonly kind: 'fetch_failed' | 'login_required',
    message: string,
  ) {
    super(message)
    this.name = 'ClipFetchError'
  }
}

export async function fetchClipHtml(
  url: string,
  signal: AbortSignal | undefined,
  fetchHtml: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<ClipFetchResult> {
  let response: Response
  try {
    response = await fetchHtml(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    const detail = (err as Error).message || 'unknown'
    throw new ClipFetchError('fetch_failed', `Failed to fetch ${url}: ${detail}`)
  }
  if (!response.ok) {
    const status = response.status
    if (status === 401 || status === 403) {
      throw new ClipFetchError(
        'login_required',
        `HTTP ${status} ${response.statusText} on ${url}`,
      )
    }
    throw new ClipFetchError('fetch_failed', `HTTP ${status} ${response.statusText}`)
  }
  const html = await response.text()
  if (isWeiboVisitorWallHtml(response.url || url, html)) {
    throw new ClipFetchError(
      'login_required',
      `Weibo returned the visitor wall for ${url}`,
    )
  }
  const headMatch = html.match(ABSENT_TITLE_RE)
  return {
    html,
    finalUrl: response.url || url,
    titleFromHead: headMatch ? headMatch[1]?.trim() : undefined,
  }
}

export function isWeiboVisitorWallHtml(finalUrl: string, html: string): boolean {
  let hostname = ''
  try {
    hostname = new URL(finalUrl).hostname
  } catch {
    hostname = ''
  }
  if (!/(^|\.)passport\.weibo\.(?:com|cn)$/i.test(hostname)) return false
  return /<title>\s*Sina Visitor System\s*<\/title>/i.test(html) ||
    /\/visitor\/mini_original\.js/i.test(html)
}

export async function fetchJinaMarkdown(
  url: string,
  jinaKey: string | undefined,
  signal: AbortSignal | undefined,
  jinaBaseUrl?: string,
): Promise<string | undefined> {
  const headers: Record<string, string> = { Accept: 'text/plain' }
  if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`
  const baseUrl = (jinaBaseUrl || 'https://r.jina.ai').replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${baseUrl}/${url}`, {
      method: 'GET',
      headers,
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const text = await response.text()
  return text && text.trim().length > 0 ? text : undefined
}
