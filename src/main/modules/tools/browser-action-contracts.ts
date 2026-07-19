export interface BrowserResearchPublicRequest {
  action: 'start' | 'evidence' | 'complete'
  workItems: Array<{
    workItemId?: string
    goalRefs: string[]
    requirement: string | null
    query: string | null
    url: string | null
    fieldGoals: string[]
    required: boolean
  }>
  evidenceBindings: Array<{
    workItemId: string
    observationReceiptId: string
    actionReceiptId?: string | null
  }>
}

export type BrowserActionContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

export type BrowserCollectMode = 'images' | 'structured' | 'scroll' | 'visible'
export type BrowserDownloadMode = 'urls' | 'page' | 'media' | 'resolve'
export type BrowserTaskAction = 'get' | 'result'

export interface BrowserModeContract<TMode extends string> {
  mode: TMode
  operation: string
  args: Record<string, unknown>
}

function uniqueStrings(value: unknown, maxItems = 128, maxLength = 2_000): string[] {
  if (!Array.isArray(value)) return []
  if (value.length > maxItems) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (!text || text.length > maxLength || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function parseBrowserResearchPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserResearchPublicRequest> {
  const action = args.action === 'evidence' || args.action === 'complete' ? args.action : 'start'
  if (action === 'complete') {
    return {
      ok: true,
      value: {
        action,
        workItems: [],
        evidenceBindings: [],
      },
    }
  }
  if (action === 'evidence') {
    const rawBindings = Array.isArray(args.evidence_bindings) ? args.evidence_bindings : []
    if (rawBindings.length === 0 || rawBindings.length > 256) {
      return { ok: false, message: 'evidence_bindings is required when action is evidence' }
    }
    const evidenceBindings = rawBindings.map((value) => {
      const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
      return {
        workItemId: typeof record.work_item_id === 'string' ? record.work_item_id.trim() : '',
        observationReceiptId: typeof record.observation_receipt_id === 'string' ? record.observation_receipt_id.trim() : '',
        actionReceiptId: typeof record.action_receipt_id === 'string' && record.action_receipt_id.trim()
          ? record.action_receipt_id.trim()
          : null,
      }
    })
    if (evidenceBindings.some((binding) => !binding.workItemId || !binding.observationReceiptId)) {
      return { ok: false, message: 'each evidence binding requires work_item_id and observation_receipt_id' }
    }
    return { ok: true, value: { action, workItems: [], evidenceBindings } }
  }

  const rawItems = Array.isArray(args.work_items) ? args.work_items : []
  if (rawItems.length === 0) return { ok: false, message: 'start requires work_items' }
  if (rawItems.length > 128) return { ok: false, message: 'work_items exceeds the per-call limit' }
  const explicitItems = rawItems.map((value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    return {
      ...(typeof record.work_item_id === 'string' && record.work_item_id.trim()
        ? { workItemId: record.work_item_id.trim() }
        : {}),
      goalRefs: uniqueStrings(record.goal_refs, 64, 256),
      requirement: typeof record.requirement === 'string' && record.requirement.trim() ? record.requirement.trim() : null,
      query: typeof record.query === 'string' && record.query.trim() ? record.query.trim() : null,
      url: typeof record.url === 'string' && record.url.trim() ? record.url.trim() : null,
      fieldGoals: uniqueStrings(record.field_goals, 64, 512),
      required: record.required !== false,
    }
  })
  return {
    ok: true,
    value: {
      action,
      workItems: explicitItems,
      evidenceBindings: [],
    },
  }
}

export function parseBrowserCollectPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserModeContract<BrowserCollectMode>> {
  const requested = typeof args.mode === 'string' ? args.mode.trim() : ''
  const inferred = requested || (
    args.template || args.fields
      ? 'structured'
      : 'visible'
  )
  if (!['images', 'structured', 'scroll', 'visible'].includes(inferred)) {
    return { ok: false, message: `unsupported browser_collect mode: ${inferred}` }
  }
  const mode = inferred as BrowserCollectMode
  return { ok: true, value: { mode, operation: `collect_${mode}`, args: { ...args, mode } } }
}

export function parseBrowserDownloadPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserModeContract<BrowserDownloadMode>> {
  const requested = typeof args.mode === 'string' ? args.mode.trim() : ''
  const inferred = requested || (
    Array.isArray(args.urls)
      ? 'urls'
      : 'page'
  )
  if (!['urls', 'page', 'media', 'resolve'].includes(inferred)) {
    return { ok: false, message: `unsupported browser_download mode: ${inferred}` }
  }
  if (inferred === 'urls' && uniqueStrings(args.urls).length === 0) {
    return { ok: false, message: 'urls mode requires a non-empty urls array' }
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
  const mode = inferred as BrowserDownloadMode
  return { ok: true, value: { mode, operation: `download_${mode}`, args: { ...args, mode } } }
}

export function parseBrowserTaskPublicRequest(
  args: Record<string, unknown>,
): BrowserActionContractResult<BrowserModeContract<BrowserTaskAction>> {
  const action = (typeof args.action === 'string' ? args.action : 'get') as BrowserTaskAction
  if (!['get', 'result'].includes(action)) {
    return { ok: false, message: `unsupported browser_task action: ${action}` }
  }
  if (!(typeof args.task_id === 'string' && args.task_id.trim())) {
    return { ok: false, message: 'browser_task requires task_id' }
  }
  return { ok: true, value: { mode: action, operation: `task_${action}`, args: { ...args, action } } }
}
