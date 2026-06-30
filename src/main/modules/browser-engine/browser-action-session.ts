import { createHash } from 'node:crypto'

import type { ScopeRunSkillProgress } from '../agent-control/contracts/types'

export interface BrowserTransactionConfirmation {
  confirmed: true
  source: 'page_text' | 'public_url' | 'network' | 'site_strategy'
  signal: string
  urlHash?: string | null
  resourceIdHash?: string | null
  statusCode?: number | null
  textHash?: string | null
  observedAt: string
}

export interface BrowserActionSessionProgress {
  targetTabId: string | null
  targetFrameId: string | null
  frameUrl: string | null
  frameOrigin: string | null
  currentUrl: string | null
  origin: string | null
  lastAction: string | null
  lastFollowedTab: {
    tabId: string
    url: string | null
    title: string | null
    reason: string | null
  } | null
  transactionStatus: 'active' | 'confirmed'
  confirmation: BrowserTransactionConfirmation | null
  nextSuggestedAction: string | null
  updatedAt: string
}

const sessions = new Map<string, BrowserActionSessionProgress>()

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function hashBrowserTransactionValue(value: unknown): string | null {
  const text = String(value || '').trim()
  return text ? sha256(text) : null
}

export function createBrowserTransactionConfirmation(input: {
  source: BrowserTransactionConfirmation['source']
  signal: string
  url?: string | null
  resourceId?: string | null
  statusCode?: number | null
  text?: string | null
  observedAt?: string
}): BrowserTransactionConfirmation {
  return {
    confirmed: true,
    source: input.source,
    signal: input.signal,
    urlHash: hashBrowserTransactionValue(input.url),
    resourceIdHash: hashBrowserTransactionValue(input.resourceId),
    statusCode: Number.isFinite(input.statusCode) ? Number(input.statusCode) : null,
    textHash: hashBrowserTransactionValue(input.text),
    observedAt: input.observedAt || new Date().toISOString(),
  }
}

export function noteBrowserActionSession(
  scopeId: string | null | undefined,
  patch: Partial<BrowserActionSessionProgress>,
): BrowserActionSessionProgress | null {
  const key = cleanString(scopeId)
  if (!key) return null
  const current = sessions.get(key) || {
    targetTabId: null,
    targetFrameId: null,
    frameUrl: null,
    frameOrigin: null,
    currentUrl: null,
    origin: null,
    lastAction: null,
    lastFollowedTab: null,
    transactionStatus: 'active' as const,
    confirmation: null,
    nextSuggestedAction: null,
    updatedAt: new Date().toISOString(),
  }
  const currentUrl = patch.currentUrl ?? current.currentUrl
  const frameUrl = patch.frameUrl ?? current.frameUrl
  const confirmation = patch.confirmation ?? current.confirmation
  const next: BrowserActionSessionProgress = {
    ...current,
    ...patch,
    currentUrl,
    origin: patch.origin ?? originOf(currentUrl) ?? current.origin,
    frameUrl,
    frameOrigin: patch.frameOrigin ?? originOf(frameUrl) ?? current.frameOrigin,
    transactionStatus: confirmation ? 'confirmed' : (patch.transactionStatus ?? current.transactionStatus),
    confirmation,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  }
  sessions.set(key, next)
  return next
}

export function getBrowserActionSession(scopeId: string | null | undefined): BrowserActionSessionProgress | null {
  const key = cleanString(scopeId)
  return key ? sessions.get(key) || null : null
}

export function buildBrowserActionSessionProgress(
  session: BrowserActionSessionProgress,
): ScopeRunSkillProgress {
  return {
    stage: session.transactionStatus === 'confirmed' ? 'browser_transaction_confirmed' : 'browser_transaction_active',
    completed: session.transactionStatus === 'confirmed' ? 1 : 0,
    total: 1,
    coverage: session.transactionStatus === 'confirmed' ? 1 : 0,
    fingerprint: hashBrowserTransactionValue(JSON.stringify({
      targetTabId: session.targetTabId,
      targetFrameId: session.targetFrameId,
      currentUrl: session.currentUrl,
      confirmation: session.confirmation,
    })),
    updatedAt: session.updatedAt,
    lastError: null,
    detail: session.nextSuggestedAction,
    browserActionSession: session,
  }
}

export function buildBrowserActionSessionReminderText(scopeId: string | null | undefined): string | null {
  const session = getBrowserActionSession(scopeId)
  if (!session) return null
  const parts = [
    'Browser action session:',
    `targetTabId=${session.targetTabId || 'unknown'}`,
    `targetFrameId=${session.targetFrameId || 'none'}`,
    `url=${session.currentUrl || 'unknown'}`,
    `lastAction=${session.lastAction || 'none'}`,
    `transactionStatus=${session.transactionStatus}`,
  ]
  if (session.lastFollowedTab) {
    parts.push(`followedTab=${session.lastFollowedTab.tabId}`)
  }
  if (session.nextSuggestedAction) {
    parts.push(`next=${session.nextSuggestedAction}`)
  }
  if (session.confirmation) {
    parts.push(`confirmation=${session.confirmation.source}:${session.confirmation.signal}`)
  }
  return parts.join(' | ')
}
