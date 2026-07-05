import type { AgentInputItem } from '@openai/agents'
import type { TaskEventBridgePayload } from '../../browser-engine/task-event-bridge'
import type { ReminderTopic, SystemReminderRegistry } from './system-reminder-registry'

export const BACKGROUND_TASK_TERMINAL_REMINDER_TOPIC = 'background-task-terminal'

export interface PendingTaskEventStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

export interface PendingTaskEventDatabase {
  prepare(sql: string): PendingTaskEventStatement
}

export interface PendingTaskEventRow {
  id: number
  eventPayload: string
  taskRunId: string | null
  createdAt: number
  consumed: number
}

export interface AutoNarrationContinuationResult {
  success: boolean
  error?: string | null
}

export type AutoNarrationContinuationDrainResult = 'none' | 'active' | 'started' | 'failed'

export interface AutoNarrationContinuationRunnerDeps {
  getOldestPendingTaskEvent: () => PendingTaskEventRow | null
  markPendingTaskEventConsumed: (id: number) => void
  hasActiveNarrationContinuationRun: () => boolean
  isAutoNarrationContinuationEnabled?: () => boolean
  startNarrationContinuationRun: (
    row: PendingTaskEventRow,
  ) => Promise<AutoNarrationContinuationResult>
  onNarrationContinuationFailure?: (row: PendingTaskEventRow, error: string | null) => void
}

const activeRunCountsByScope = new Map<string, number>()
const activeScopeByTaskId = new Map<string, string>()
const pendingReminderTextsByScope = new Map<string, string[]>()
const pendingTaskEventListeners = new Set<() => void>()
let pendingTaskEventDatabaseOverride: PendingTaskEventDatabase | null = null

const NARRATION_FAILURE_MAX_ATTEMPTS = 3
const NARRATION_FAILURE_BACKOFF_MS = 30_000

export class AutoNarrationContinuationRunner {
  private inFlight = false
  private scheduled = false
  // Review-team B4: a failing pending row must not block the queue head
  // forever nor retry hot. Attempts are in-memory (restart resets — the
  // cap re-arms, which is fine: it is a storm brake, not a ledger).
  private readonly failureByRowId = new Map<number, { attempts: number; lastFailedAtMs: number }>()

  constructor(private readonly deps: AutoNarrationContinuationRunnerDeps) {}

  trigger(): void {
    if (this.deps.isAutoNarrationContinuationEnabled?.() === false) return
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.drainOnce()
    })
  }

  async drainOnce(): Promise<AutoNarrationContinuationDrainResult> {
    if (this.inFlight || this.deps.hasActiveNarrationContinuationRun()) return 'active'
    const row = this.deps.getOldestPendingTaskEvent()
    if (!row) return 'none'

    const failure = this.failureByRowId.get(row.id)
    if (failure && Date.now() - failure.lastFailedAtMs < NARRATION_FAILURE_BACKOFF_MS) {
      return 'failed'
    }

    this.inFlight = true
    try {
      const result = await this.deps.startNarrationContinuationRun(row)
      if (!result.success) {
        const attempts = (failure?.attempts ?? 0) + 1
        this.failureByRowId.set(row.id, { attempts, lastFailedAtMs: Date.now() })
        this.deps.onNarrationContinuationFailure?.(row, result.error || null)
        if (attempts >= NARRATION_FAILURE_MAX_ATTEMPTS) {
          // give up loudly: consume so newer events stop starving behind it
          this.deps.markPendingTaskEventConsumed(row.id)
          this.failureByRowId.delete(row.id)
        }
        return 'failed'
      }
      this.failureByRowId.delete(row.id)
      this.deps.markPendingTaskEventConsumed(row.id)
      return 'started'
    } finally {
      this.inFlight = false
    }
  }
}

export function beginBackgroundTaskTerminalReminderRun(
  scopeId: string | null | undefined,
  taskId: string | null | undefined,
): () => void {
  const normalizedScopeId = normalizeId(scopeId)
  if (!normalizedScopeId) return () => {}

  activeRunCountsByScope.set(
    normalizedScopeId,
    (activeRunCountsByScope.get(normalizedScopeId) ?? 0) + 1,
  )

  const normalizedTaskId = normalizeId(taskId)
  if (normalizedTaskId) activeScopeByTaskId.set(normalizedTaskId, normalizedScopeId)

  return () => {
    const nextCount = (activeRunCountsByScope.get(normalizedScopeId) ?? 1) - 1
    if (nextCount > 0) activeRunCountsByScope.set(normalizedScopeId, nextCount)
    else activeRunCountsByScope.delete(normalizedScopeId)

    if (normalizedTaskId && activeScopeByTaskId.get(normalizedTaskId) === normalizedScopeId) {
      activeScopeByTaskId.delete(normalizedTaskId)
    }
  }
}

export function enqueueBackgroundTaskTerminalReminderFromBridge(
  payload: TaskEventBridgePayload,
): void {
  const extra = asRecord(payload.extra)
  if (extra?.autoContinue === true) return
  const scopeId = resolveScopeId(payload)
  if (!scopeId || !activeRunCountsByScope.has(scopeId)) {
    insertPendingTaskEvent(payload)
    return
  }

  const existing = pendingReminderTextsByScope.get(scopeId) ?? []
  existing.push(buildBackgroundTaskTerminalReminderText(payload))
  pendingReminderTextsByScope.set(scopeId, existing)
}

export function insertPendingTaskEvent(payload: TaskEventBridgePayload): PendingTaskEventRow | null {
  const db = getPendingTaskEventDatabase()
  if (!db) return null
  const createdAt = Date.now()
  const taskRunId = normalizeId(payload.taskId)
  const eventPayload = JSON.stringify(payload)
  // Review-team B1: the in-memory publish dedupe dies with the process, so
  // the durable layer must dedupe too. Terminal states (completed/failed)
  // are once-per-task — any existing row for the pair suppresses re-insert;
  // re-enterable states (paused/needs_attention/waiting_human) only suppress
  // while an unconsumed twin is still queued.
  const status = String(payload.status || '')
  const terminalOnce = status === 'completed' || status === 'failed'
  const dupe = db.prepare(`
    SELECT id FROM pending_task_events
    WHERE task_run_id = ?
      AND event_payload LIKE ?
      ${terminalOnce ? '' : 'AND consumed = 0'}
    LIMIT 1
  `).get(taskRunId, `%"status":"${status}"%`)
  if (dupe) return null
  const result = db.prepare(`
    INSERT INTO pending_task_events (event_payload, task_run_id, created_at, consumed)
    VALUES (?, ?, ?, 0)
  `).run(eventPayload, taskRunId, createdAt) as { lastInsertRowid?: unknown } | undefined
  const row: PendingTaskEventRow = {
    id: Number(result?.lastInsertRowid || 0),
    eventPayload,
    taskRunId,
    createdAt,
    consumed: 0,
  }
  notifyPendingTaskEventListeners()
  return row
}

export function getOldestPendingTaskEvent(): PendingTaskEventRow | null {
  const db = getPendingTaskEventDatabase()
  if (!db) return null
  const row = db.prepare(`
    SELECT id, event_payload, task_run_id, created_at, consumed
    FROM pending_task_events
    WHERE consumed = 0
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get<PendingTaskEventSqlRow>()
  return row ? mapPendingTaskEventRow(row) : null
}

export function markPendingTaskEventConsumed(id: number): void {
  const db = getPendingTaskEventDatabase()
  if (!db) return
  db.prepare('UPDATE pending_task_events SET consumed = 1 WHERE id = ?').run(id)
}

export function registerPendingTaskEventListener(listener: () => void): () => void {
  pendingTaskEventListeners.add(listener)
  return () => {
    pendingTaskEventListeners.delete(listener)
  }
}

export function listPendingTaskEventsForTests(): PendingTaskEventRow[] {
  const db = getPendingTaskEventDatabase()
  if (!db) return []
  return db.prepare(`
    SELECT id, event_payload, task_run_id, created_at, consumed
    FROM pending_task_events
    ORDER BY id ASC
  `).all<PendingTaskEventSqlRow>().map(mapPendingTaskEventRow)
}

export function __setPendingTaskEventDatabaseForTests(db: PendingTaskEventDatabase | null): void {
  pendingTaskEventDatabaseOverride = db
}

export function __resetBackgroundTaskTerminalReminderForTests(): void {
  activeRunCountsByScope.clear()
  activeScopeByTaskId.clear()
  pendingReminderTextsByScope.clear()
  pendingTaskEventListeners.clear()
  pendingTaskEventDatabaseOverride = null
}

export function drainBackgroundTaskTerminalReminders(
  scopeId: string | null | undefined,
): string[] {
  const normalizedScopeId = normalizeId(scopeId)
  if (!normalizedScopeId) return []
  const pending = pendingReminderTextsByScope.get(normalizedScopeId)
  if (!pending || pending.length === 0) return []
  pendingReminderTextsByScope.delete(normalizedScopeId)
  return pending
}

export function registerBackgroundTaskTerminalReminder(
  registry: SystemReminderRegistry,
  reminderTexts: readonly string[],
): void {
  const text = reminderTexts.map((item) => item.trim()).filter(Boolean).join('\n')
  if (!text) return
  registry.register({
    topic: BACKGROUND_TASK_TERMINAL_REMINDER_TOPIC,
    priority: 90,
    conflictsWith: [],
    text,
  })
}

export function prependSystemReminderInput(
  input: string | AgentInputItem[],
  reminderText: string,
): AgentInputItem[] {
  const reminderItem = {
    role: 'system',
    content: reminderText,
  } as AgentInputItem
  if (typeof input !== 'string') return [reminderItem, ...input]
  return [
    reminderItem,
    {
      role: 'user',
      content: input,
    } as AgentInputItem,
  ]
}

function buildBackgroundTaskTerminalReminderText(payload: TaskEventBridgePayload): string {
  const extra = asRecord(payload.extra)
  const summary = firstString(extra, ['summary', 'title', 'message', 'statusText'])
  const failureDetail = buildFailureDetail(payload, extra)
  return [
    `系统补充：后台任务 ${payload.taskId} 已进入终态：${statusLabel(payload.status)}。`,
    summary ? `摘要：${summary}` : null,
    failureDetail ? `失败明细：${failureDetail}` : null,
    '请在下一步回复或行动中纳入这个结果，不要把该后台任务继续当作运行中。',
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function buildFailureDetail(
  payload: TaskEventBridgePayload,
  extra: Record<string, unknown> | null,
): string | null {
  const explicit = firstString(extra, [
    'error',
    'failure',
    'failureDetail',
    'failureDetails',
    'failedReason',
    'reason',
  ])
  if (explicit) return explicit

  const progress = asRecord(extra?.progress)
  const failed = progress ? Number(progress.failed) : 0
  if (Number.isFinite(failed) && failed > 0) return `失败 ${failed} 项`

  if (payload.status === 'failed') return '未提供失败明细'
  return null
}

function resolveScopeId(payload: TaskEventBridgePayload): string | null {
  const extra = asRecord(payload.extra)
  const explicit = readScopeId(extra)
  if (explicit) return explicit

  const mapped = activeScopeByTaskId.get(payload.taskId)
  return mapped || null
}

function readScopeId(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  const direct = firstString(record, ['scopeId', 'sessionId', 'publicSessionId'])
  if (direct) return direct
  return readScopeId(asRecord(record.payload))
}

function statusLabel(status: TaskEventBridgePayload['status']): string {
  switch (status) {
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'paused':
      return '已暂停'
    case 'needs_attention':
      return '需要处理'
    case 'waiting_human':
      return '等待用户'
  }
}

function firstString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

interface PendingTaskEventSqlRow {
  id: number
  event_payload: string
  task_run_id: string | null
  created_at: number
  consumed: number
}

function mapPendingTaskEventRow(row: PendingTaskEventSqlRow): PendingTaskEventRow {
  return {
    id: Number(row.id),
    eventPayload: row.event_payload,
    taskRunId: row.task_run_id,
    createdAt: Number(row.created_at),
    consumed: Number(row.consumed),
  }
}

function getPendingTaskEventDatabase(): PendingTaskEventDatabase | null {
  if (pendingTaskEventDatabaseOverride) return pendingTaskEventDatabaseOverride
  try {
    const { getDatabase } = require('../../database') as {
      getDatabase: () => { getRawDb: () => PendingTaskEventDatabase | null }
    }
    return getDatabase().getRawDb() || null
  } catch {
    return null
  }
}

function notifyPendingTaskEventListeners(): void {
  for (const listener of pendingTaskEventListeners) {
    try {
      listener()
    } catch {
      // silent-catch: Listener failures must not break task-event publication.
    }
  }
}
