/**
 * CollectionPlan schema + deterministic per-note loop state (plan §3.2/§3.3/§3.10).
 *
 * The main agent produces a CollectionPlan (validated by Zod); the
 * browser-collector driver compiles it into a CollectionLoopState and steps
 * through it one note at a time. Keeping the plan schema + the loop decisions
 * here makes both pure and unit-testable, independent of the child-run runner.
 *
 * Pure module — Zod + plain logic, no Electron, no IO.
 */

import { z } from 'zod'

export const CollectionNoteSchema = z.object({
  url: z.string().describe('笔记详情页 URL'),
  canonicalUrl: z.string().optional().describe('稳定来源 URL，用于去重和清单追踪'),
  openUrl: z.string().optional().describe('实际打开 URL，优先用于详情页访问'),
  title: z.string().optional().describe('笔记标题（用于建文件夹/进度展示）'),
  sourceId: z.string().optional().describe('来源稳定标识（用于文件夹防重名/恢复）'),
  titleConfidence: z.enum(['none', 'low', 'medium', 'high']).optional(),
  order: z.number().int().positive().optional(),
  folderName: z.string().optional(),
  duplicateTitle: z.boolean().optional(),
  kind: z.enum(['content', 'video']).optional(),
})

export const CollectionStopConditionsSchema = z.object({
  maxNotes: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxConsecutiveFailures: z.number().int().positive().optional(),
})

export const CollectionPlanSchema = z.object({
  targetProfileUrl: z.string().describe('博主主页 URL'),
  notes: z.array(CollectionNoteSchema).min(1).describe('要逐篇采集的笔记列表'),
  strategy: z.enum(['url_batch', 'card_loop']).optional(),
  stopConditions: CollectionStopConditionsSchema.optional(),
  outputRootDir: z.string().describe('采集输出根目录（每篇一个子文件夹）'),
  expectedCount: z.number().int().positive().optional().describe('上游冻结清单的预期数量'),
  sourceTaskId: z.string().optional().describe('生成本清单的可见采集任务 ID'),
  // P1 (2026-07-03, 7/01 reliability contract C boundary) — the freeze-time
  // target quality from the upstream visible_collect. Threaded here so the
  // note_collect verdict can reject a polluted/nav-heavy list even when
  // note_collect is invoked directly (resume / hand-built plan), not only at
  // the visible_collect gate.
  targetQuality: z.enum(['trustworthy', 'suspect_navigation_pollution', 'structure_context_missing'])
    .optional()
    .describe('上游冻结清单的目标质量判定'),
})

export type CollectionNote = z.infer<typeof CollectionNoteSchema>
export type CollectionPlan = z.infer<typeof CollectionPlanSchema>

export const DEFAULT_STOP = {
  maxNotes: 200,
  maxDurationMs: 30 * 60_000,
  maxConsecutiveFailures: 5,
}

/** Validate a raw plan object; returns the parsed plan or a list of issues. */
export function parseCollectionPlan(
  raw: unknown,
): { ok: true; plan: CollectionPlan } | { ok: false; issues: string[] } {
  const result = CollectionPlanSchema.safeParse(raw)
  if (result.success) return { ok: true, plan: result.data }
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
}

export interface CollectionLoopState {
  cursor: number
  collected: string[]
  failed: CollectionItemFailure[]
  failures: CollectionItemFailure[]
  retryCursor: string[]
  outputs: CollectionNoteOutput[]
  consecutiveFailures: number
  startedAt: number
}

export interface CollectionItemFailure {
  url: string
  reason: string
  attempts: number
  retryable: boolean
}

export interface CollectionNoteOutput {
  url: string
  canonicalUrl?: string
  openUrl?: string
  title?: string
  sourceId?: string
  order?: number
  success: boolean
  savedDir: string
  imageCount: number
  videoCount?: number
  mediaKind?: 'image' | 'video'
  notePath?: string
  manifestPath?: string
  files?: string[]
  reason?: string
  kind?: 'content' | 'video'
}

const NON_FATAL_FAILURE_REASONS = new Set(['skipped_video', 'unavailable'])

/** Per-note failure escalation axis (E2): 'human' halts the whole collection
 *  (a real access wall recurs on every note); 'none' is a per-note partial that
 *  must NOT stop the rest of the task. */
export type CollectionFailureEscalation = 'human' | 'none'

export interface CollectionFailurePolicy {
  retryable: boolean
  escalate: CollectionFailureEscalation
}

/** The CODE of a reason string = the part before ':' (e.g. `download:<err>` →
 *  `download`, `partial_images:3/5` → `partial_images`). */
function collectionFailureReasonCode(reason: string): string {
  const text = String(reason || '').trim()
  const colon = text.indexOf(':')
  return (colon >= 0 ? text.slice(0, colon) : text).toLowerCase()
}

// Single source of truth for per-note failure policy (replaces the old
// retryable/non-retryable regex pair). Only TERMINAL (permanent) and HUMAN
// (access-wall) codes are enumerated; everything else — transient load/DOM/
// download/partial failures (detail_not_opened, no_images, detail_mismatch,
// card_not_found, download_failed, open_card, collect, verify_detail,
// return_list, partial_images, timeout, navigate, network, lease_lost, …) —
// defaults to retryable+no-escalation. E1: those transient codes used to fall
// through the regex as retryable=false and were permanently lost; they are now
// retried in the final pass. E2: partial_images is retryable+none (per-note
// partial, continue), no longer borrowing the access-wall halt.
const HUMAN_ESCALATION_FAILURE_CODES = new Set<string>([
  'needs_verification',
])
const TERMINAL_FAILURE_CODES = new Set<string>([
  'permission', 'forbidden', 'unauthorized', 'deleted', 'unavailable',
  'blocked_permanent', 'terminal_skip', 'skipped_video',
  'video_resolve', 'video_download',
])

export function classifyCollectionFailureReason(reason: string): CollectionFailurePolicy {
  const code = collectionFailureReasonCode(reason)
  if (HUMAN_ESCALATION_FAILURE_CODES.has(code)) return { retryable: false, escalate: 'human' }
  if (TERMINAL_FAILURE_CODES.has(code)) return { retryable: false, escalate: 'none' }
  return { retryable: true, escalate: 'none' }
}

export function inferCollectionFailureRetryable(reason: string): boolean {
  return classifyCollectionFailureReason(reason).retryable
}

export function collectionFailureEscalation(reason: string): CollectionFailureEscalation {
  return classifyCollectionFailureReason(reason).escalate
}

function failureUrlForNote(note: CollectionNote): string {
  return note.canonicalUrl || note.url
}

function outputMatchesUrl(output: CollectionNoteOutput, url: string, note: CollectionNote): boolean {
  return output.url === url
    || output.canonicalUrl === url
    || (typeof note.openUrl === 'string' && note.openUrl.length > 0 && output.openUrl === note.openUrl)
    || output.openUrl === note.url
}

function normalizeFailureRecord(value: unknown): CollectionItemFailure | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const url = String(record.url || record.canonicalUrl || record.openUrl || record.sourceUrl || '').trim()
  if (!url) return null
  const reason = String(record.reason || record.error || record.message || 'unknown').trim() || 'unknown'
  const attempts = Number(record.attempts)
  const retryable = typeof record.retryable === 'boolean'
    ? record.retryable
    : inferCollectionFailureRetryable(reason)
  return {
    url,
    reason,
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1,
    retryable,
  }
}

function normalizeFailureRecords(value: unknown): CollectionItemFailure[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeFailureRecord).filter((item): item is CollectionItemFailure => item !== null)
}

export function createCollectionLoopState(now: number): CollectionLoopState {
  return { cursor: 0, collected: [], failed: [], failures: [], retryCursor: [], outputs: [], consecutiveFailures: 0, startedAt: now }
}

export function normalizeCollectionLoopState(state: CollectionLoopState): CollectionLoopState {
  const failures = normalizeFailureRecords((state as { failures?: unknown }).failures)
  const failed = failures.length > 0 ? failures : normalizeFailureRecords(state.failed)
  return {
    cursor: Number.isFinite(Number(state.cursor)) ? Number(state.cursor) : 0,
    collected: Array.isArray(state.collected) ? state.collected.map((item) => String(item || '')).filter(Boolean) : [],
    failed,
    failures: failed,
    retryCursor: Array.isArray((state as { retryCursor?: unknown }).retryCursor)
      ? (state as { retryCursor: unknown[] }).retryCursor.map((item) => String(item || '')).filter(Boolean)
      : [],
    outputs: Array.isArray(state.outputs) ? state.outputs.slice() : [],
    consecutiveFailures: Number.isFinite(Number(state.consecutiveFailures)) ? Number(state.consecutiveFailures) : 0,
    startedAt: Number.isFinite(Number(state.startedAt)) ? Number(state.startedAt) : Date.now(),
  }
}

export function retryableCollectionFailures(state: CollectionLoopState): CollectionItemFailure[] {
  const normalized = normalizeCollectionLoopState(state)
  const collected = new Set(normalized.collected)
  return normalized.failures.filter((item) => item.retryable && !collected.has(item.url))
}

export type CollectionStopReason =
  | 'completed'
  | 'max_notes'
  | 'max_duration'
  | 'too_many_failures'
  | 'needs_verification'
  // Download-volume budget (high-control safety ceiling).
  | 'max_images'
  // External stops surfaced by the runner via the engine's shouldStop probe.
  | 'cancelled'
  | 'lease_lost'
  | null

/**
 * Decide the next note to collect, or a stop reason. `null` next means stop.
 */
export function planNextNote(
  plan: CollectionPlan,
  state: CollectionLoopState,
  now: number,
): { stop: CollectionStopReason; note: CollectionNote | null; index: number } {
  const stops = { ...DEFAULT_STOP, ...(plan.stopConditions ?? {}) }
  if (state.consecutiveFailures >= stops.maxConsecutiveFailures) {
    return { stop: 'too_many_failures', note: null, index: state.cursor }
  }
  if (state.collected.length >= stops.maxNotes) {
    return { stop: 'max_notes', note: null, index: state.cursor }
  }
  if (state.cursor >= plan.notes.length) {
    return { stop: 'completed', note: null, index: state.cursor }
  }
  if (now - state.startedAt >= stops.maxDurationMs) {
    return { stop: 'max_duration', note: null, index: state.cursor }
  }
  return { stop: null, note: plan.notes[state.cursor], index: state.cursor }
}

/** Record a note result and advance the cursor. Returns the updated state. */
export function recordNoteResult(
  state: CollectionLoopState,
  note: CollectionNote,
  outcome: { success: boolean; reason?: string; output?: CollectionNoteOutput },
): CollectionLoopState {
  return recordCollectionNoteOutcome(state, note, outcome, true)
}

export function recordRetryNoteResult(
  state: CollectionLoopState,
  note: CollectionNote,
  outcome: { success: boolean; reason?: string; output?: CollectionNoteOutput },
): CollectionLoopState {
  return recordCollectionNoteOutcome(state, note, outcome, false)
}

function recordCollectionNoteOutcome(
  rawState: CollectionLoopState,
  note: CollectionNote,
  outcome: { success: boolean; reason?: string; output?: CollectionNoteOutput },
  advanceCursor: boolean,
): CollectionLoopState {
  const state = normalizeCollectionLoopState(rawState)
  const url = failureUrlForNote(note)
  const existingFailure = state.failures.find((item) => item.url === url)
  const failures = state.failures.filter((item) => item.url !== url)
  const outputs = state.outputs.filter((item) => !outputMatchesUrl(item, url, note))
  const next: CollectionLoopState = {
    cursor: advanceCursor ? state.cursor + 1 : state.cursor,
    collected: state.collected.filter((item) => item !== url),
    failed: failures,
    failures,
    retryCursor: state.retryCursor.slice(),
    outputs,
    consecutiveFailures: outcome.success || NON_FATAL_FAILURE_REASONS.has(String(outcome.reason || '')) ? 0 : state.consecutiveFailures + 1,
    startedAt: state.startedAt,
  }
  if (outcome.success) {
    next.collected.push(url)
  } else {
    const reason = outcome.reason ?? 'unknown'
    const failure = {
      url,
      reason,
      attempts: (existingFailure?.attempts || 0) + 1,
      retryable: inferCollectionFailureRetryable(reason),
    }
    next.failed.push(failure)
    next.failures = next.failed
  }
  next.outputs.push(outcome.output ?? {
    url,
    title: note.title,
    sourceId: note.sourceId,
    kind: note.kind,
    success: outcome.success,
    savedDir: '',
    imageCount: 0,
    reason: outcome.reason,
  })
  return next
}
