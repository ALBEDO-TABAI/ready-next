function normalizeWhitespace(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

export type BrowserActionKind = 'navigate' | 'search'

export interface BrowserActionRecord {
  kind: BrowserActionKind
  value: string
  normalizedValue: string
  updatedAt: number
}

export interface BrowserWorkflowState {
  sessionId: string
  tabId?: string
  url: string
  title: string
  domain: string
  heading?: string
  workflowKind: string
  stage: string
  attachmentName?: string
  promptPreview?: string
  evidence: string[]
  running: boolean
  uploadMounted: boolean
  promptFilled: boolean
  status: 'running' | 'done' | 'partial' | 'failed'
  canResume: boolean
  lastFailureReason?: string
  lastEvidence: string[]
  updatedAt: number
}

export interface SkillRunRecord {
  toolName: string
  skillId: string
  action: string
  success: boolean
  summary: string
  updatedAt: number
}

const recentBrowserActions = new Map<string, BrowserActionRecord[]>()
const browserWorkflowStates = new Map<string, BrowserWorkflowState>()
const recentSkillRuns = new Map<string, SkillRunRecord[]>()

function pruneToRecent<T extends { updatedAt: number }>(items: T[], limit: number): T[] {
  return items
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

function normalizeBrowserActionValue(kind: BrowserActionKind, value: string): string {
  const normalized = normalizeWhitespace(value).toLowerCase()
  if (!normalized) return ''
  if (kind === 'search') return normalized
  try {
    const parsed = new URL(normalized)
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    const search = parsed.search || ''
    return `${parsed.origin}${pathname}${search}`
  } catch {
    return normalized
  }
}

export function normalizeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function domainsLikelyMatch(left?: string | null, right?: string | null): boolean {
  const a = normalizeDomain(String(left || ''))
  const b = normalizeDomain(String(right || ''))
  if (!a || !b) return false
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export function rememberBrowserAction(
  sessionId: string | undefined,
  kind: BrowserActionKind,
  value: string,
): void {
  const normalizedValue = normalizeBrowserActionValue(kind, value)
  if (!sessionId || !normalizedValue) return
  const existing = recentBrowserActions.get(sessionId) || []
  const next = pruneToRecent(
    [
      { kind, value: normalizeWhitespace(value), normalizedValue, updatedAt: Date.now() },
      ...existing.filter((item) => !(item.kind === kind && item.normalizedValue === normalizedValue)),
    ],
    8,
  )
  recentBrowserActions.set(sessionId, next)
}

export function findRecentBrowserAction(
  sessionId: string | undefined,
  kind: BrowserActionKind,
  value: string,
  withinMs = 45_000,
): BrowserActionRecord | null {
  const normalizedValue = normalizeBrowserActionValue(kind, value)
  if (!sessionId || !normalizedValue) return null
  const items = recentBrowserActions.get(sessionId) || []
  const now = Date.now()
  return items.find((item) => item.kind === kind && item.normalizedValue === normalizedValue && now - item.updatedAt <= withinMs) || null
}

export function getRecentBrowserActions(sessionId: string | undefined): BrowserActionRecord[] {
  if (!sessionId) return []
  return (recentBrowserActions.get(sessionId) || []).slice()
}

export function rememberBrowserWorkflowState(
  sessionId: string | undefined,
  payload: Omit<BrowserWorkflowState, 'sessionId' | 'domain' | 'updatedAt'> & {
    updatedAt?: number
    domain?: string
  },
): BrowserWorkflowState | null {
  if (!sessionId) return null
  const updatedAt = payload.updatedAt || Date.now()
  const state: BrowserWorkflowState = {
    sessionId,
    tabId: payload.tabId,
    url: normalizeWhitespace(payload.url),
    title: normalizeWhitespace(payload.title),
    domain: payload.domain || normalizeDomain(payload.url),
    heading: normalizeWhitespace(payload.heading || ''),
    workflowKind: normalizeWhitespace(payload.workflowKind),
    stage: normalizeWhitespace(payload.stage),
    attachmentName: normalizeWhitespace(payload.attachmentName || ''),
    promptPreview: normalizeWhitespace(payload.promptPreview || ''),
    evidence: Array.from(new Set((payload.evidence || []).map((item) => normalizeWhitespace(item)).filter(Boolean))).slice(0, 8),
    running: Boolean(payload.running),
    uploadMounted: Boolean(payload.uploadMounted),
    promptFilled: Boolean(payload.promptFilled),
    status: payload.status,
    canResume: Boolean(payload.canResume),
    lastFailureReason: normalizeWhitespace(payload.lastFailureReason || ''),
    lastEvidence: Array.from(new Set((payload.lastEvidence || payload.evidence || []).map((item) => normalizeWhitespace(item)).filter(Boolean))).slice(0, 8),
    updatedAt,
  }
  browserWorkflowStates.set(sessionId, state)
  return state
}

export function getBrowserWorkflowState(sessionId: string | undefined): BrowserWorkflowState | null {
  if (!sessionId) return null
  return browserWorkflowStates.get(sessionId) || null
}

export function rememberSkillRun(
  sessionId: string | undefined,
  payload: Omit<SkillRunRecord, 'updatedAt'> & { updatedAt?: number },
): void {
  if (!sessionId) return
  const nextRecord: SkillRunRecord = {
    ...payload,
    toolName: normalizeWhitespace(payload.toolName),
    skillId: normalizeWhitespace(payload.skillId),
    action: normalizeWhitespace(payload.action),
    summary: normalizeWhitespace(payload.summary),
    success: Boolean(payload.success),
    updatedAt: payload.updatedAt || Date.now(),
  }
  const existing = recentSkillRuns.get(sessionId) || []
  const next = pruneToRecent(
    [
      nextRecord,
      ...existing.filter((item) => !(item.toolName === nextRecord.toolName && item.updatedAt === nextRecord.updatedAt)),
    ],
    4,
  )
  recentSkillRuns.set(sessionId, next)
}

export function getLatestSkillRun(sessionId: string | undefined): SkillRunRecord | null {
  if (!sessionId) return null
  return (recentSkillRuns.get(sessionId) || [])[0] || null
}
