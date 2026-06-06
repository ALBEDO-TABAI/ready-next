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
  failed: Array<{ url: string; reason: string }>
  outputs: CollectionNoteOutput[]
  consecutiveFailures: number
  startedAt: number
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

export function createCollectionLoopState(now: number): CollectionLoopState {
  return { cursor: 0, collected: [], failed: [], outputs: [], consecutiveFailures: 0, startedAt: now }
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
  if (now - state.startedAt >= stops.maxDurationMs) {
    return { stop: 'max_duration', note: null, index: state.cursor }
  }
  if (state.cursor >= plan.notes.length) {
    return { stop: 'completed', note: null, index: state.cursor }
  }
  return { stop: null, note: plan.notes[state.cursor], index: state.cursor }
}

/** Record a note result and advance the cursor. Returns the updated state. */
export function recordNoteResult(
  state: CollectionLoopState,
  note: CollectionNote,
  outcome: { success: boolean; reason?: string; output?: CollectionNoteOutput },
): CollectionLoopState {
  const next: CollectionLoopState = {
    cursor: state.cursor + 1,
    collected: state.collected.slice(),
    failed: state.failed.slice(),
    outputs: Array.isArray(state.outputs) ? state.outputs.slice() : [],
    consecutiveFailures: outcome.success || NON_FATAL_FAILURE_REASONS.has(String(outcome.reason || '')) ? 0 : state.consecutiveFailures + 1,
    startedAt: state.startedAt,
  }
  if (outcome.success) {
    next.collected.push(note.url)
  } else {
    next.failed.push({ url: note.url, reason: outcome.reason ?? 'unknown' })
  }
  next.outputs.push(outcome.output ?? {
    url: note.url,
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
