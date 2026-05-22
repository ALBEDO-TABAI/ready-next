import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'

export type NormalizedRunStateStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'

export interface ParsedRunStateRecord {
  raw: Record<string, unknown>
  taskId: string | null
  childRunId: string | null
  status: NormalizedRunStateStatus | null
  statusText: string | null
  currentStage: string | null
  currentStep: string | null
  activeOutputDir: string | null
  outputDir: string | null
  sceneScoresPath: string | null
  deliveryReportPath: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
  updatedAt: string | null
  lastError: string | null
  pid: number | null
}

export type RunStateSchemaResult =
  | { ok: true; value: ParsedRunStateRecord }
  | { ok: false; reason: 'parse_failed' | 'not_object' | 'invalid_field' | 'invalid_status'; message: string }

function pathTagFor(path: string): string {
  const match = path.match(/[^/\\]+$/)
  return match ? match[0] : 'run_state.json'
}

function emitInvalid(path: string | undefined, result: Exclude<RunStateSchemaResult, { ok: true }>): void {
  logAgentMetric(TOOL_ERROR_METRICS.runStateSchemaInvalid, {
    pathTag: path ? pathTagFor(path) : 'run_state.json',
    reason: result.reason,
    message: result.message.slice(0, 160),
  })
}

export function normalizeRunStateStatus(value: unknown): NormalizedRunStateStatus | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!raw) return null
  if (raw === 'done' || raw === 'completed' || raw === 'complete' || raw === 'success' || raw === 'succeeded') return 'done'
  if (raw === 'failed' || raw === 'failure' || raw === 'error') return 'failed'
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'killed') return 'cancelled'
  if (raw === 'blocked' || raw === 'paused' || raw === 'recoverable_paused' || raw === 'budget_paused' || raw === 'awaiting_input' || raw === 'pending_review') return 'blocked'
  if (raw === 'queued' || raw === 'running' || raw === 'in_progress' || raw === 'processing' || raw === 'pending' || raw === 'waiting_for_batches' || raw === 'ready_to_finalize') return 'running'
  return null
}

function nonEmptyString(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = rec[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') {
      throw new Error(`${key} must be a string`)
    }
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function optionalNumber(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = rec[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number`)
    }
    return value
  }
  return null
}

function optionalStringOrJson(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = rec[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
      continue
    }
    try {
      return JSON.stringify(value)
    } catch {
      // silent-catch: non-JSON-serializable payloads still get a readable fallback.
      return String(value)
    }
  }
  return null
}

function optionalStatus(rec: Record<string, unknown>): { status: NormalizedRunStateStatus | null; statusText: string | null } {
  const raw = nonEmptyString(rec, ['status', 'state', 'phase'])
  if (!raw) return { status: null, statusText: null }
  const status = normalizeRunStateStatus(raw)
  if (!status) throw new Error(`status is not recognized: ${raw}`)
  return { status, statusText: raw.toLowerCase() }
}

export function validateRunStateRecord(
  parsed: unknown,
  options: { path?: string; emitMetric?: boolean } = {},
): RunStateSchemaResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const result = { ok: false, reason: 'not_object', message: 'run_state JSON must be an object' } as const
    if (options.emitMetric) emitInvalid(options.path, result)
    return result
  }
  const rec = parsed as Record<string, unknown>
  let status: NormalizedRunStateStatus | null
  let statusText: string | null
  try {
    const resolved = optionalStatus(rec)
    status = resolved.status
    statusText = resolved.statusText
    const value: ParsedRunStateRecord = {
      raw: rec,
      taskId: nonEmptyString(rec, ['task_id', 'taskId']),
      childRunId: nonEmptyString(rec, ['child_run_id', 'childRunId']),
      status,
      statusText,
      currentStage: nonEmptyString(rec, ['current_stage', 'currentStage', 'stage']),
      currentStep: nonEmptyString(rec, ['current_step', 'currentStep', 'step']),
      activeOutputDir: nonEmptyString(rec, ['active_output_dir', 'activeOutputDir']),
      outputDir: nonEmptyString(rec, ['output_dir', 'outputDir']),
      sceneScoresPath: nonEmptyString(rec, ['scene_scores_path', 'sceneScoresPath', 'scores_path']),
      deliveryReportPath: nonEmptyString(rec, ['delivery_report_path', 'deliveryReportPath']),
      totalScenes: optionalNumber(rec, ['total_scenes', 'totalScenes', 'total']),
      completedScenes: optionalNumber(rec, ['completed_scenes', 'completedScenes', 'completed']),
      coverageRatio: optionalNumber(rec, ['coverage_ratio', 'coverageRatio', 'coverage']),
      updatedAt: nonEmptyString(rec, ['updated_at', 'updatedAt', 'lastUpdated']),
      lastError: optionalStringOrJson(rec, ['last_error', 'lastError', 'error']),
      pid: optionalNumber(rec, ['pid']),
    }
    return { ok: true, value }
  } catch (error) {
    // silent-catch: validation errors are returned as structured schema failures.
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.startsWith('status is not recognized') ? 'invalid_status' : 'invalid_field'
    const result = { ok: false, reason, message } as const
    if (options.emitMetric) emitInvalid(options.path, result)
    return result
  }
}

export function parseRunStateJson(
  raw: string,
  options: { path?: string; emitMetric?: boolean } = {},
): RunStateSchemaResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    // silent-catch: parse errors are returned as structured schema failures.
    const message = error instanceof Error ? error.message : String(error)
    const result = { ok: false, reason: 'parse_failed', message } as const
    if (options.emitMetric) emitInvalid(options.path, result)
    return result
  }
  return validateRunStateRecord(parsed, options)
}
