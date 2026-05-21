import { existsSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteJson } from './atomic-write'
import type { ContinuationState } from './contracts/continuation-state'
import { normalizeContinuationState } from './contracts/continuation-state'
import {
  domainsLikelyMatch,
  findRecentBrowserActionInRecords,
  normalizeDomain,
  rememberRecentBrowserAction,
  type BrowserActionKind,
  type BrowserActionRecord,
} from './domain-adapters/browser-action-heuristics'

export { domainsLikelyMatch, normalizeDomain }
export type { BrowserActionKind, BrowserActionRecord }

function normalizeWhitespace(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ')
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
  status?: string
  runKind?: string
  taskRunId?: string
  detachedTaskId?: string
  jobId?: string
  outputDir?: string
  runStatePath?: string
  pauseReason?: string
  resumePayload?: Record<string, unknown>
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
const MAX_CONTINUITY_SESSIONS = 200
let continuityHydrated = false
let continuityStoragePathOverride: string | null = null

function pruneToRecent<T extends { updatedAt: number }>(items: T[], limit: number): T[] {
  return items
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

interface PersistedSessionContinuity {
  version: 1 | 2 | 3 | 4
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
    version: 4,
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

function forgetSessionInMemory(sessionId: string): boolean {
  const normalizedSessionId = normalizeWhitespace(sessionId)
  if (!normalizedSessionId) return false
  const hadBrowserActions = recentBrowserActions.delete(normalizedSessionId)
  const hadWorkflowState = browserWorkflowStates.delete(normalizedSessionId)
  const hadSkillRuns = recentSkillRuns.delete(normalizedSessionId)
  const hadContinuationStates = recentContinuationStates.delete(normalizedSessionId)
  const hadAny =
    hadBrowserActions
    || hadWorkflowState
    || hadSkillRuns
    || hadContinuationStates
  return hadAny
}

function getTrackedSessionIds(): string[] {
  return Array.from(new Set([
    ...recentBrowserActions.keys(),
    ...browserWorkflowStates.keys(),
    ...recentSkillRuns.keys(),
    ...recentContinuationStates.keys(),
  ]))
}

function getSessionLastTouchedAt(sessionId: string): number {
  const browserActionUpdatedAt = (recentBrowserActions.get(sessionId) || []).reduce(
    (latest, record) => Math.max(latest, Number(record.updatedAt || 0)),
    0,
  )
  const workflowUpdatedAt = Number(browserWorkflowStates.get(sessionId)?.updatedAt || 0)
  const skillUpdatedAt = (recentSkillRuns.get(sessionId) || []).reduce(
    (latest, record) => Math.max(latest, Number(record.updatedAt || 0)),
    0,
  )
  const continuationUpdatedAt = (recentContinuationStates.get(sessionId) || []).reduce(
    (latest, record) => Math.max(latest, Number(record.updatedAt || 0)),
    0,
  )
  return Math.max(browserActionUpdatedAt, workflowUpdatedAt, skillUpdatedAt, continuationUpdatedAt)
}

function pruneStaleSessions(): boolean {
  const sessionIds = getTrackedSessionIds()
  if (sessionIds.length <= MAX_CONTINUITY_SESSIONS) return false
  const staleSessionIds = sessionIds
    .slice()
    .sort((left, right) => getSessionLastTouchedAt(right) - getSessionLastTouchedAt(left))
    .slice(MAX_CONTINUITY_SESSIONS)
  let changed = false
  for (const sessionId of staleSessionIds) {
    changed = forgetSessionInMemory(sessionId) || changed
  }
  return changed
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
            (item as { records: SkillRunRecord[] }).records.map((record) => normalizeSkillRunRecord(record)),
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
    if (pruneStaleSessions()) {
      persistToDisk()
    }
  } catch {
    clearInMemoryState()
  }
}

function persistToDisk(): void {
  hydrateFromDisk()
  const path = resolveContinuityStoragePath()
  try {
    atomicWriteJson(path, toPersistedPayload())
  } catch {
    // Persistence must stay best-effort.
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

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeWhitespace(typeof value === 'string' ? value : '')
  return normalized || undefined
}

function normalizeResumePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function normalizeSkillRunRecord(record: Omit<SkillRunRecord, 'updatedAt'> & { updatedAt?: number }): SkillRunRecord {
  const normalized: SkillRunRecord = {
    toolName: normalizeWhitespace(record.toolName),
    skillId: normalizeWhitespace(record.skillId),
    action: normalizeWhitespace(record.action),
    success: Boolean(record.success),
    summary: normalizeWhitespace(record.summary),
    updatedAt: Number(record.updatedAt || 0),
  }
  const status = normalizeOptionalString(record.status)
  if (status) normalized.status = status
  const runKind = normalizeOptionalString(record.runKind)
  if (runKind) normalized.runKind = runKind
  const taskRunId = normalizeOptionalString(record.taskRunId)
  if (taskRunId) normalized.taskRunId = taskRunId
  const detachedTaskId = normalizeOptionalString(record.detachedTaskId)
  if (detachedTaskId) normalized.detachedTaskId = detachedTaskId
  const jobId = normalizeOptionalString(record.jobId)
  if (jobId) normalized.jobId = jobId
  const outputDir = normalizeOptionalString(record.outputDir)
  if (outputDir) normalized.outputDir = outputDir
  const runStatePath = normalizeOptionalString(record.runStatePath)
  if (runStatePath) normalized.runStatePath = runStatePath
  const pauseReason = normalizeOptionalString(record.pauseReason)
  if (pauseReason) normalized.pauseReason = pauseReason
  const resumePayload = normalizeResumePayload(record.resumePayload)
  if (resumePayload) normalized.resumePayload = resumePayload
  return normalized
}

function skillRunIdentityTokens(record: SkillRunRecord): Set<string> {
  const tokens = new Set<string>()
  ;[
    record.taskRunId,
    record.detachedTaskId,
    record.jobId,
  ].forEach((value) => {
    const normalized = normalizeOptionalString(value)
    if (normalized) tokens.add(normalized)
  })
  const resumePayload = normalizeResumePayload(record.resumePayload)
  if (resumePayload) {
    ;[
      resumePayload.taskRunId,
      resumePayload.task_run_id,
      resumePayload.taskId,
      resumePayload.task_id,
      resumePayload.expectedTaskId,
      resumePayload.detachedTaskId,
      resumePayload.detached_task_id,
      resumePayload.jobId,
      resumePayload.job_id,
    ].forEach((value) => {
      const normalized = normalizeOptionalString(value)
      if (normalized) tokens.add(normalized)
    })
  }
  return tokens
}

function isActiveSkillRunStatus(status: string | undefined): boolean {
  return status === 'queued'
    || status === 'running'
    || status === 'blocked'
    || status === 'background_running'
    || status === 'budget_paused'
}

function skillRunResumePriority(record: SkillRunRecord, expectedTaskId: string): number {
  if (expectedTaskId && skillRunIdentityTokens(record).has(expectedTaskId)) return 0
  if (isActiveSkillRunStatus(record.status)) return 1
  if (!record.success) return 2
  return 3
}

export function rememberBrowserAction(
  sessionId: string | undefined,
  kind: BrowserActionKind,
  value: string,
): void {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return
  const next = rememberRecentBrowserAction(recentBrowserActions.get(normalizedSessionId) || [], kind, value)
  if (next.length === 0) return
  recentBrowserActions.set(normalizedSessionId, next)
  pruneStaleSessions()
  persistToDisk()
}

export function findRecentBrowserAction(
  sessionId: string | undefined,
  kind: BrowserActionKind,
  value: string,
  withinMs = 45_000,
): BrowserActionRecord | null {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return null
  return findRecentBrowserActionInRecords(recentBrowserActions.get(normalizedSessionId) || [], kind, value, withinMs)
}

export function getRecentBrowserActions(sessionId: string | undefined): BrowserActionRecord[] {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return []
  return (recentBrowserActions.get(normalizedSessionId) || []).slice()
}

export function rememberBrowserWorkflowState(
  sessionId: string | undefined,
  payload: Omit<BrowserWorkflowState, 'sessionId' | 'domain' | 'updatedAt'> & {
    updatedAt?: number
    domain?: string
  },
): BrowserWorkflowState | null {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return null
  const updatedAt = payload.updatedAt || Date.now()
  const state: BrowserWorkflowState = {
    sessionId: normalizedSessionId,
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
  browserWorkflowStates.set(normalizedSessionId, state)
  pruneStaleSessions()
  persistToDisk()
  return state
}

export function getBrowserWorkflowState(sessionId: string | undefined): BrowserWorkflowState | null {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return null
  return browserWorkflowStates.get(normalizedSessionId) || null
}

export function rememberSkillRun(
  sessionId: string | undefined,
  payload: Omit<SkillRunRecord, 'updatedAt'> & { updatedAt?: number },
): void {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return
  const nextRecord: SkillRunRecord = {
    ...normalizeSkillRunRecord(payload),
    updatedAt: payload.updatedAt || Date.now(),
  }
  const existing = recentSkillRuns.get(normalizedSessionId) || []
  const next = pruneToRecent(
    [
      nextRecord,
      ...existing.filter((item) => !(item.toolName === nextRecord.toolName && item.updatedAt === nextRecord.updatedAt)),
    ],
    4,
  )
  recentSkillRuns.set(normalizedSessionId, next)
  pruneStaleSessions()
  persistToDisk()
}

export function getLatestSkillRun(sessionId: string | undefined): SkillRunRecord | null {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return null
  return (recentSkillRuns.get(normalizedSessionId) || [])[0] || null
}

export function resolveSkillRunForResume(params: {
  sessionId?: string | undefined
  expectedTaskId?: string | null
  candidates?: Array<SkillRunRecord | null | undefined>
}): SkillRunRecord | null {
  hydrateFromDisk()
  const expectedTaskId = normalizeWhitespace(params.expectedTaskId || '')
  const candidates = [
    ...(params.candidates || []),
    getLatestSkillRun(params.sessionId),
  ]
    .filter((item): item is SkillRunRecord => Boolean(item?.skillId))
    .map((item) => normalizeSkillRunRecord(item))

  if (candidates.length === 0) return null
  const seen = new Set<string>()
  return candidates
    .filter((candidate) => {
      const identity = [
        candidate.taskRunId,
        candidate.detachedTaskId,
        candidate.jobId,
        candidate.toolName,
        candidate.updatedAt,
      ].filter(Boolean).join('|')
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .sort((left, right) => {
      const priorityDelta = skillRunResumePriority(left, expectedTaskId) - skillRunResumePriority(right, expectedTaskId)
      if (priorityDelta !== 0) return priorityDelta
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
    })[0] || null
}

export function rememberContinuationState(
  sessionId: string | undefined,
  payload: ContinuationState,
  options?: { updatedAt?: number },
): ContinuationState | null {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return null
  const normalized = normalizeContinuationState(payload)
  if (!normalized) return null
  const existing = recentContinuationStates.get(normalizedSessionId) || []
  recentContinuationStates.set(normalizedSessionId, pruneContinuationStateRecords([
    {
      updatedAt: Number(options?.updatedAt || Date.now()),
      state: normalized,
    },
    ...existing.filter((record) => record.state.taskId !== normalized.taskId),
  ]))
  pruneStaleSessions()
  persistToDisk()
  return normalizeContinuationState(normalized)
}

export function getContinuationState(
  sessionId: string | undefined,
  options?: { taskId?: string | null },
): ContinuationState | null {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return null
  const records = recentContinuationStates.get(normalizedSessionId) || []
  if (options?.taskId) {
    return normalizeContinuationState(records.find((record) => record.state.taskId === options.taskId)?.state || null)
  }
  return normalizeContinuationState(records[0]?.state || null)
}

export function listContinuationStates(sessionId: string | undefined): ContinuationState[] {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return []
  return cloneContinuationStateRecords(recentContinuationStates.get(normalizedSessionId)).map((record) => record.state)
}

export function clearContinuationState(sessionId: string | undefined, taskId?: string | null): void {
  hydrateFromDisk()
  const normalizedSessionId = normalizeWhitespace(sessionId || '')
  if (!normalizedSessionId) return
  if (!recentContinuationStates.has(normalizedSessionId)) return
  if (!taskId) {
    recentContinuationStates.delete(normalizedSessionId)
    persistToDisk()
    return
  }
  const next = (recentContinuationStates.get(normalizedSessionId) || []).filter((record) => record.state.taskId !== taskId)
  if (next.length === 0) {
    recentContinuationStates.delete(normalizedSessionId)
  } else {
    recentContinuationStates.set(normalizedSessionId, pruneContinuationStateRecords(next))
  }
  persistToDisk()
}

export function forgetSession(sessionId: string): void {
  hydrateFromDisk()
  if (!forgetSessionInMemory(sessionId)) return
  persistToDisk()
}

export function __setSessionContinuityStoragePathForTests(path: string | null): void {
  continuityStoragePathOverride = path
  continuityHydrated = false
  clearInMemoryState()
}

export const __breaksInvariants = [
  'singleton.session-continuity.never-reset-mid-session',
] as const

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
