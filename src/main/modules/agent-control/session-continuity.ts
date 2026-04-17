import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ContinuationState } from './continuation-state'
import { normalizeContinuationState } from './continuation-state'

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

interface ContinuationStateRecord {
  updatedAt: number
  state: ContinuationState
}

const recentBrowserActions = new Map<string, BrowserActionRecord[]>()
const browserWorkflowStates = new Map<string, BrowserWorkflowState>()
const recentSkillRuns = new Map<string, SkillRunRecord[]>()
const recentContinuationStates = new Map<string, ContinuationStateRecord[]>()
let continuityHydrated = false
let continuityStoragePathOverride: string | null = null

function pruneToRecent<T extends { updatedAt: number }>(items: T[], limit: number): T[] {
  return items
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

interface PersistedSessionContinuity {
  version: 1 | 2 | 3
  recentBrowserActions: Array<{ sessionId: string; records: BrowserActionRecord[] }>
  browserWorkflowStates: BrowserWorkflowState[]
  recentSkillRuns: Array<{ sessionId: string; records: SkillRunRecord[] }>
  recentContinuationStates?: Array<{
    sessionId: string
    state?: ContinuationState
    states?: Array<{ updatedAt: number; state: ContinuationState }>
  }>
}

function resolveContinuityStoragePath(): string {
  return continuityStoragePathOverride
    || process.env.READY_SESSION_CONTINUITY_PATH
    || join(homedir(), '.ready-session-continuity.json')
}

function toPersistedPayload(): PersistedSessionContinuity {
  return {
    version: 3,
    recentBrowserActions: Array.from(recentBrowserActions.entries()).map(([sessionId, records]) => ({ sessionId, records })),
    browserWorkflowStates: Array.from(browserWorkflowStates.values()),
    recentSkillRuns: Array.from(recentSkillRuns.entries()).map(([sessionId, records]) => ({ sessionId, records })),
    recentContinuationStates: Array.from(recentContinuationStates.entries()).map(([sessionId, states]) => ({
      sessionId,
      states: states.map((item) => ({
        updatedAt: item.updatedAt,
        state: item.state,
      })),
    })),
  }
}

function clearInMemoryState(): void {
  recentBrowserActions.clear()
  browserWorkflowStates.clear()
  recentSkillRuns.clear()
  recentContinuationStates.clear()
}

function hydrateFromDisk(): void {
  if (continuityHydrated) return
  continuityHydrated = true
  const path = resolveContinuityStoragePath()
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedSessionContinuity>
    clearInMemoryState()
    if (Array.isArray(parsed.recentBrowserActions)) {
      for (const item of parsed.recentBrowserActions) {
        if (!item || typeof item !== 'object') continue
        const sessionId = normalizeWhitespace((item as { sessionId?: string }).sessionId || '')
        const records = Array.isArray((item as { records?: BrowserActionRecord[] }).records)
          ? pruneToRecent(
            (item as { records: BrowserActionRecord[] }).records.map((record) => ({
              ...record,
              kind: record.kind,
              value: normalizeWhitespace(record.value),
              normalizedValue: normalizeWhitespace(record.normalizedValue),
              updatedAt: Number(record.updatedAt || 0),
            })).filter((record) => record.kind === 'navigate' || record.kind === 'search'),
            8,
          )
          : []
        if (sessionId && records.length > 0) {
          recentBrowserActions.set(sessionId, records)
        }
      }
    }
    if (Array.isArray(parsed.browserWorkflowStates)) {
      for (const record of parsed.browserWorkflowStates) {
        if (!record?.sessionId) continue
        browserWorkflowStates.set(record.sessionId, {
          ...record,
          sessionId: normalizeWhitespace(record.sessionId),
          url: normalizeWhitespace(record.url),
          title: normalizeWhitespace(record.title),
          domain: normalizeWhitespace(record.domain),
          heading: normalizeWhitespace(record.heading || ''),
          workflowKind: normalizeWhitespace(record.workflowKind),
          stage: normalizeWhitespace(record.stage),
          attachmentName: normalizeWhitespace(record.attachmentName || ''),
          promptPreview: normalizeWhitespace(record.promptPreview || ''),
          evidence: pruneToRecent(
            (record.evidence || []).map((item, index) => ({ text: normalizeWhitespace(item), updatedAt: index + 1 })),
            8,
          ).map((item) => item.text).filter(Boolean),
          running: Boolean(record.running),
          uploadMounted: Boolean(record.uploadMounted),
          promptFilled: Boolean(record.promptFilled),
          status: record.status,
          canResume: Boolean(record.canResume),
          lastFailureReason: normalizeWhitespace(record.lastFailureReason || ''),
          lastEvidence: pruneToRecent(
            (record.lastEvidence || []).map((item, index) => ({ text: normalizeWhitespace(item), updatedAt: index + 1 })),
            8,
          ).map((item) => item.text).filter(Boolean),
          updatedAt: Number(record.updatedAt || 0),
        })
      }
    }
    if (Array.isArray(parsed.recentSkillRuns)) {
      for (const item of parsed.recentSkillRuns) {
        if (!item || typeof item !== 'object') continue
        const sessionId = normalizeWhitespace((item as { sessionId?: string }).sessionId || '')
        const records = Array.isArray((item as { records?: SkillRunRecord[] }).records)
          ? pruneToRecent(
            (item as { records: SkillRunRecord[] }).records.map((record) => ({
              ...record,
              toolName: normalizeWhitespace(record.toolName),
              skillId: normalizeWhitespace(record.skillId),
              action: normalizeWhitespace(record.action),
              summary: normalizeWhitespace(record.summary),
              success: Boolean(record.success),
              updatedAt: Number(record.updatedAt || 0),
            })),
            4,
          )
          : []
        if (sessionId && records.length > 0) {
          recentSkillRuns.set(sessionId, records)
        }
      }
    }
    if (Array.isArray(parsed.recentContinuationStates)) {
      for (const item of parsed.recentContinuationStates) {
        if (!item || typeof item !== 'object') continue
        const sessionId = normalizeWhitespace((item as { sessionId?: string }).sessionId || '')
        const states = Array.isArray((item as { states?: Array<{ updatedAt: number; state: ContinuationState }> }).states)
          ? pruneContinuationStateRecords(
            ((item as { states: Array<{ updatedAt: number; state: ContinuationState }> }).states || [])
              .map((record) => ({
                updatedAt: Number(record.updatedAt || 0),
                state: record.state,
              })),
          )
          : (() => {
            const state = normalizeContinuationState((item as { state?: ContinuationState }).state || null)
            return state ? [{
              updatedAt: 0,
              state,
            }] : []
          })()
        if (sessionId && states.length > 0) {
          recentContinuationStates.set(sessionId, states)
        }
      }
    }
  } catch {
    clearInMemoryState()
  }
}

function persistToDisk(): void {
  hydrateFromDisk()
  const path = resolveContinuityStoragePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(toPersistedPayload()), 'utf8')
  } catch {
    // Persistence must stay best-effort.
  }
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

function pruneContinuationStateRecords(records: ContinuationStateRecord[]): ContinuationStateRecord[] {
  const deduped = new Map<string, ContinuationStateRecord>()
  for (const record of records) {
    const state = normalizeContinuationState(record.state)
    if (!state) continue
    const existing = deduped.get(state.taskId)
    if (!existing || Number(record.updatedAt || 0) >= existing.updatedAt) {
      deduped.set(state.taskId, {
        updatedAt: Number(record.updatedAt || 0),
        state,
      })
    }
  }
  return Array.from(deduped.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8)
}

function cloneContinuationStateRecords(records: ContinuationStateRecord[] | null | undefined): ContinuationStateRecord[] {
  return (records || [])
    .map((record) => {
      const state = normalizeContinuationState(record.state)
      if (!state) return null
      return {
        updatedAt: Number(record.updatedAt || 0),
        state,
      }
    })
    .filter((record): record is ContinuationStateRecord => Boolean(record))
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
  hydrateFromDisk()
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
  persistToDisk()
}

export function findRecentBrowserAction(
  sessionId: string | undefined,
  kind: BrowserActionKind,
  value: string,
  withinMs = 45_000,
): BrowserActionRecord | null {
  hydrateFromDisk()
  const normalizedValue = normalizeBrowserActionValue(kind, value)
  if (!sessionId || !normalizedValue) return null
  const items = recentBrowserActions.get(sessionId) || []
  const now = Date.now()
  return items.find((item) => item.kind === kind && item.normalizedValue === normalizedValue && now - item.updatedAt <= withinMs) || null
}

export function getRecentBrowserActions(sessionId: string | undefined): BrowserActionRecord[] {
  hydrateFromDisk()
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
  hydrateFromDisk()
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
  persistToDisk()
  return state
}

export function getBrowserWorkflowState(sessionId: string | undefined): BrowserWorkflowState | null {
  hydrateFromDisk()
  if (!sessionId) return null
  return browserWorkflowStates.get(sessionId) || null
}

export function rememberSkillRun(
  sessionId: string | undefined,
  payload: Omit<SkillRunRecord, 'updatedAt'> & { updatedAt?: number },
): void {
  hydrateFromDisk()
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
  persistToDisk()
}

export function getLatestSkillRun(sessionId: string | undefined): SkillRunRecord | null {
  hydrateFromDisk()
  if (!sessionId) return null
  return (recentSkillRuns.get(sessionId) || [])[0] || null
}

export function rememberContinuationState(
  sessionId: string | undefined,
  payload: ContinuationState,
  options?: { updatedAt?: number },
): ContinuationState | null {
  hydrateFromDisk()
  if (!sessionId) return null
  const normalized = normalizeContinuationState(payload)
  if (!normalized) return null
  const existing = recentContinuationStates.get(sessionId) || []
  recentContinuationStates.set(sessionId, pruneContinuationStateRecords([
    {
      updatedAt: Number(options?.updatedAt || Date.now()),
      state: normalized,
    },
    ...existing.filter((record) => record.state.taskId !== normalized.taskId),
  ]))
  persistToDisk()
  return normalizeContinuationState(normalized)
}

export function getContinuationState(
  sessionId: string | undefined,
  options?: { taskId?: string | null },
): ContinuationState | null {
  hydrateFromDisk()
  if (!sessionId) return null
  const records = recentContinuationStates.get(sessionId) || []
  if (options?.taskId) {
    return normalizeContinuationState(records.find((record) => record.state.taskId === options.taskId)?.state || null)
  }
  return normalizeContinuationState(records[0]?.state || null)
}

export function listContinuationStates(sessionId: string | undefined): ContinuationState[] {
  hydrateFromDisk()
  if (!sessionId) return []
  return cloneContinuationStateRecords(recentContinuationStates.get(sessionId)).map((record) => record.state)
}

export function clearContinuationState(sessionId: string | undefined, taskId?: string | null): void {
  hydrateFromDisk()
  if (!sessionId) return
  if (!recentContinuationStates.has(sessionId)) return
  if (!taskId) {
    recentContinuationStates.delete(sessionId)
    persistToDisk()
    return
  }
  const next = (recentContinuationStates.get(sessionId) || []).filter((record) => record.state.taskId !== taskId)
  if (next.length === 0) {
    recentContinuationStates.delete(sessionId)
  } else {
    recentContinuationStates.set(sessionId, pruneContinuationStateRecords(next))
  }
  persistToDisk()
}

export function __setSessionContinuityStoragePathForTests(path: string | null): void {
  continuityStoragePathOverride = path
  continuityHydrated = false
  clearInMemoryState()
}

export function __resetSessionContinuityForTests(options?: { keepPersisted?: boolean }): void {
  clearInMemoryState()
  continuityHydrated = false
  if (options?.keepPersisted) return
  const path = resolveContinuityStoragePath()
  if (existsSync(path)) {
    try {
      rmSync(path, { force: true })
    } catch {
      // ignore cleanup failures in tests
    }
  }
}

export function __reloadSessionContinuityFromDiskForTests(): void {
  continuityHydrated = false
  clearInMemoryState()
  hydrateFromDisk()
}
