export interface BrowserResearchPublicRequest {
  scope: 'current_site' | 'url_set'
  queries: string[]
  siteTabId: string | null
  urls: string[]
  perQueryLimit: number
  detailLimitPerQuery: number
  fields: Array<'title' | 'url' | 'author' | 'engagement' | 'published_at' | 'body'>
  preserveSourceTab: boolean
}

export type BrowserActionContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

export type BrowserCollectMode = 'images' | 'structured' | 'scroll' | 'visible' | 'notes'
export type BrowserDownloadMode = 'urls' | 'collected' | 'page' | 'media' | 'resolve' | 'gallery'
export type BrowserTaskAction = 'get' | 'resume' | 'cancel' | 'result'

export interface BrowserModeContract<TMode extends string> {
  mode: TMode
  operation: string
  args: Record<string, unknown>
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function parseBrowserResearchPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserResearchPublicRequest> {
  const scope = args.scope === 'url_set' ? 'url_set' : args.scope === 'current_site' ? 'current_site' : null
  if (!scope) return { ok: false, message: 'scope must be current_site or url_set' }
  const queries = uniqueStrings(args.queries)
  const urls = uniqueStrings(args.urls)
  if (scope === 'current_site' && queries.length === 0) {
    return { ok: false, message: 'queries is required for current_site research' }
  }
  if (scope === 'url_set' && urls.length === 0) {
    return { ok: false, message: 'urls is required for url_set research' }
  }
  if (urls.some((url) => {
    try { return !/^https?:$/.test(new URL(url).protocol) } catch {
      // silent-catch: malformed public input is rejected by the contract result below.
      return true
    }
  })) {
    return { ok: false, message: 'urls must contain valid http(s) URLs' }
  }
  const allowedFields = new Set(['title', 'url', 'author', 'engagement', 'published_at', 'body'])
  const fields = uniqueStrings(args.fields).filter((field) => allowedFields.has(field)) as BrowserResearchPublicRequest['fields']
  const detailLimitPerQuery = Math.max(0, Math.min(20, Number(args.detail_limit_per_query ?? 3) || 0))
  if ((fields.length === 0 || fields.includes('body')) && detailLimitPerQuery === 0) {
    return { ok: false, message: 'detail_limit_per_query must be greater than 0 when body is requested' }
  }
  return {
    ok: true,
    value: {
      scope,
      queries,
      siteTabId: typeof args.site_tab_id === 'string' && args.site_tab_id.trim() ? args.site_tab_id.trim() : null,
      urls,
      perQueryLimit: Math.max(1, Math.min(50, Number(args.per_query_limit || 12) || 12)),
      detailLimitPerQuery,
      fields: fields.length > 0 ? fields : ['title', 'url', 'author', 'engagement', 'published_at', 'body'],
      preserveSourceTab: args.preserve_source_tab !== false,
    },
  }
}

export function parseBrowserCollectPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserModeContract<BrowserCollectMode>> {
  const requested = typeof args.mode === 'string' ? args.mode.trim() : ''
  const inferred = requested || (
    typeof args.source_task_id === 'string' || Array.isArray(args.notes) || Array.isArray(args.urls)
      ? 'notes'
      : args.template || args.fields
        ? 'structured'
        : 'visible'
  )
  if (!['images', 'structured', 'scroll', 'visible', 'notes'].includes(inferred)) {
    return { ok: false, message: `unsupported browser_collect mode: ${inferred}` }
  }
  if (
    inferred === 'notes' &&
    !(typeof args.source_task_id === 'string' && args.source_task_id.trim()) &&
    !Array.isArray(args.notes) &&
    !Array.isArray(args.urls)
  ) {
    return { ok: false, message: 'notes mode requires source_task_id, notes, or urls' }
  }
  const mode = inferred as BrowserCollectMode
  return { ok: true, value: { mode, operation: `collect_${mode}`, args: { ...args, mode } } }
}

export function parseBrowserDownloadPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserModeContract<BrowserDownloadMode>> {
  const requested = typeof args.mode === 'string' ? args.mode.trim() : ''
  const inferred = requested || (
    typeof args.source_task_id === 'string'
      ? 'collected'
      : Array.isArray(args.urls)
        ? 'urls'
        : 'page'
  )
  if (!['urls', 'collected', 'page', 'media', 'resolve', 'gallery'].includes(inferred)) {
    return { ok: false, message: `unsupported browser_download mode: ${inferred}` }
  }
  if (inferred === 'urls' && uniqueStrings(args.urls).length === 0) {
    return { ok: false, message: 'urls mode requires a non-empty urls array' }
  }
  if (inferred === 'collected' && !(typeof args.source_task_id === 'string' && args.source_task_id.trim())) {
    return { ok: false, message: 'collected mode requires source_task_id' }
  }
  if ((inferred === 'page' || inferred === 'media') && !(typeof args.url === 'string' && args.url.trim())) {
    return { ok: false, message: `${inferred} mode requires url` }
  }
  if (
    inferred === 'resolve' &&
    !(typeof args.page_url === 'string' && args.page_url.trim()) &&
    !(typeof args.url === 'string' && args.url.trim()) &&
    !(typeof args.video_url === 'string' && args.video_url.trim()) &&
    uniqueStrings(args.sources).length === 0
  ) {
    return { ok: false, message: 'resolve mode requires page_url, url, video_url, or sources' }
  }
  if (inferred === 'gallery' && !(typeof args.url === 'string' && args.url.trim())) {
    return { ok: false, message: 'gallery mode requires url' }
  }
  const mode = inferred as BrowserDownloadMode
  return { ok: true, value: { mode, operation: `download_${mode}`, args: { ...args, mode } } }
}

export function parseBrowserTaskPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserModeContract<BrowserTaskAction>> {
  const action = (typeof args.action === 'string' ? args.action : 'get') as BrowserTaskAction
  if (!['get', 'resume', 'cancel', 'result'].includes(action)) {
    return { ok: false, message: `unsupported browser_task action: ${action}` }
  }
  if (!(typeof args.task_id === 'string' && args.task_id.trim())) {
    return { ok: false, message: 'browser_task requires task_id' }
  }
  return { ok: true, value: { mode: action, operation: `task_${action}`, args: { ...args, action } } }
}
