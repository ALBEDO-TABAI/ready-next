import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { TaskProjectionRecord, TaskProjectionStore } from '../contracts/run-contracts'
import type { ScopeRunResumableAction, ScopeRunSkillProgress } from '../contracts/types'
import type { SkillTaskRunRecord } from '../../repositories/skill-task-run-repository'
import { inspectSkillProgressArtifacts } from '../skills/skill-progress-artifacts'
import { logAgentMetric } from '../metrics'
import { PROJECTION_OBSERVABILITY_METRICS } from '../projection-observability-metrics'
import { canResumeShape } from '../contracts/resume-handle'
import { validateRunStateRecord } from './run-state-schema'

const RECONCILABLE_STATUSES = new Set<TaskProjectionRecord['status']>(['running', 'queued', 'blocked', 'completed'])
const STALE_WITHOUT_HANDLE_MS = 30 * 60 * 1000
const REQUIRED_VEA_OUTPUT_KEYS = ['storyboard_md', 'storyboard_pdf', 'audiovisual_md', 'audiovisual_pdf']

interface ReconcileTaskProjectionsParams {
  store: Pick<TaskProjectionStore, 'update'>
  records: TaskProjectionRecord[]
  taskRuns?: SkillTaskRunRecord[]
  now: string | Date | number
}

interface ProjectionHandles {
  childRunId: string | null
  skillId: string | null
  action: string | null
  taskRunId: string | null
  outputDir: string | null
  runStatePath: string | null
  deliveryReportPath: string | null
  eventLogPath: string | null
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function runStateString(runState: JsonRecord | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(runState?.[key])
    if (value) return value
  }
  return null
}

/**
 * Stage 3 W2 — JSON read failure is no longer "all reasons collapse to
 * null". The classifier helpers below are exported so unit tests can feed
 * synthetic errors (no chmod required), and the reconciler emits a
 * throttled metric for non-`missing` failures so operators can see when
 * a child-run's state file is corrupt vs. simply not yet written.
 *
 * Behavior of the legacy `readJson` wrapper is preserved: callers still
 * see `null` on any failure mode and react identically. The metric is a
 * pure side-channel observation.
 */
export type ProjectionJsonRead =
  | { ok: true; value: JsonRecord }
  | { ok: false; reason: 'missing' | 'corrupt' | 'denied' | 'not_object'; message?: string }

export function classifyJsonReadError(error: unknown): 'missing' | 'denied' | 'corrupt' {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code
  if (errno === 'ENOENT' || errno === 'ENOTDIR') return 'missing'
  if (errno === 'EACCES' || errno === 'EPERM') return 'denied'
  return 'corrupt'
}

export function classifyJsonReadValue(parsed: unknown):
  | { ok: true; value: JsonRecord }
  | { ok: false; reason: 'not_object' } {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, value: parsed as JsonRecord }
  }
  return { ok: false, reason: 'not_object' }
}

const TASK_PROJECTION_JSON_READ_THROTTLE_MS = 60_000
const taskProjectionJsonReadEmitMs = new Map<string, number>()

function pathTagFor(path: string): string {
  const match = path.match(/[^/\\]+$/)
  return match ? match[0] : 'unknown.json'
}

/**
 * Strip absolute path-like substrings from an error message so the metric
 * payload doesn't leak the full child-run outputDir into operator logs.
 *
 * Node fs error messages typically embed the path inside quotes, e.g.
 *   `EACCES: permission denied, open '/tmp/ready/.../run_state.json'`
 *   `ENOENT: no such file or directory, open "C:\Users\...\run_state.json"`
 * We replace any quoted path that looks absolute (starts with `/` or
 * `<letter>:[\\/]`) with `<file>` and also collapse bare absolute paths.
 */
export function scrubAbsolutePathFromMessage(message: string): string {
  return message
    .replace(/(['"`])(?:\/|[A-Za-z]:[\\/])[^'"`\n]+\1/g, "'<file>'")
    // Bare absolute paths only: not preceded by `.`, `/`, or word char,
    // so `./foo`, `//foo`, and `xyz/foo` are left alone (relative or
    // already part of a longer token).
    .replace(/(?<![./\w])(?:\/|[A-Za-z]:[\\/])[^\s'"`,;:)]+/g, '<file>')
}

function maybeEmitTaskProjectionJsonReadFailed(
  path: string,
  reason: 'corrupt' | 'denied' | 'not_object',
  message?: string,
): void {
  // Throttle key uses the full path so a single bad file in one child-run
  // does not silence reports of the same reason from another child-run's
  // file. The path is purely an in-memory map key — never logged.
  const key = `${path}|${reason}`
  const now = Date.now()
  const last = taskProjectionJsonReadEmitMs.get(key) ?? 0
  if (now - last < TASK_PROJECTION_JSON_READ_THROTTLE_MS) return
  taskProjectionJsonReadEmitMs.set(key, now)
  const scrubbed = message ? scrubAbsolutePathFromMessage(message).slice(0, 200) : undefined
  logAgentMetric(PROJECTION_OBSERVABILITY_METRICS.taskProjectionJsonReadFailed, {
    pathTag: pathTagFor(path),
    reason,
    ...(scrubbed ? { message: scrubbed } : {}),
  })
}

/**
 * Test-only: clears the 60s metric throttle so successive cases emit
 * independently. Touches only the in-memory throttle Map; does NOT mutate
 * any production invariant (the metric is pure observability).
 */
export const __noProductionInvariantBreach = true
export function __resetTaskProjectionJsonReadThrottleForTests(): void {
  taskProjectionJsonReadEmitMs.clear()
}

/**
 * Stage 3 W3 — emit `projection_handle_legacy_origin_used` only for late
 * fallback origins (`artifact_path`, `run_state_enrichment`). Healthy
 * origins are silent. Throttled by `taskId × field × origin` at 5min.
 */
const PROJECTION_HANDLE_LEGACY_THROTTLE_MS = 5 * 60 * 1000
const projectionHandleLegacyEmitMs = new Map<string, number>()

const PROJECTION_HANDLE_LEGACY_ORIGINS = new Set<ProjectionHandleOrigin>([
  'artifact_path',
  'run_state_enrichment',
  'projection_task_id',
])

function emitProjectionHandleLegacyOriginMetrics(
  taskId: string,
  origins: HandleOriginMap,
): void {
  const now = Date.now()
  for (const field of PROJECTION_HANDLE_FIELDS) {
    const origin = origins[field]
    if (!PROJECTION_HANDLE_LEGACY_ORIGINS.has(origin)) continue
    const key = `${taskId}|${field}|${origin}`
    const last = projectionHandleLegacyEmitMs.get(key) ?? 0
    if (now - last < PROJECTION_HANDLE_LEGACY_THROTTLE_MS) continue
    projectionHandleLegacyEmitMs.set(key, now)
    logAgentMetric(PROJECTION_OBSERVABILITY_METRICS.projectionHandleLegacyOriginUsed, {
      taskId,
      field,
      origin,
    })
  }
}

/** Test-only: clears the 5min legacy origin throttle. */
export function __resetProjectionHandleLegacyOriginThrottleForTests(): void {
  projectionHandleLegacyEmitMs.clear()
}

export function readProjectionJsonClassified(path: string | null): ProjectionJsonRead {
  if (!path) return { ok: false, reason: 'missing' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = classifyJsonReadError(error)
    if (reason !== 'missing') {
      const message = error instanceof Error ? error.message : String(error)
      maybeEmitTaskProjectionJsonReadFailed(path, reason, message)
      return { ok: false, reason, message }
    }
    return { ok: false, reason }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    maybeEmitTaskProjectionJsonReadFailed(path, 'corrupt', message)
    return { ok: false, reason: 'corrupt', message }
  }
  const shape = classifyJsonReadValue(parsed)
  if (!shape.ok) {
    maybeEmitTaskProjectionJsonReadFailed(path, 'not_object')
    return { ok: false, reason: 'not_object' }
  }
  return shape
}

function readJson(path: string | null): JsonRecord | null {
  const result = readProjectionJsonClassified(path)
  return result.ok ? result.value : null
}

function readRunStateJson(path: string | null): JsonRecord | null {
  const result = readProjectionJsonClassified(path)
  if (!result.ok) return null
  const parsed = validateRunStateRecord(result.value, { path: path ?? undefined, emitMetric: true })
  return parsed.ok ? parsed.value.raw : null
}

function nonEmptyFile(path: string | null): boolean {
  if (!path) return false
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function pathExists(path: string | null): boolean {
  if (!path) return false
  try {
    const stat = statSync(path)
    return stat.isFile() || stat.isDirectory()
  } catch {
    return false
  }
}

function normalizePath(path: string | null): string | null {
  return path ? path.replace(/[\\/]+$/, '') : null
}

function pathFromArtifactMeta(meta: JsonRecord | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(meta?.[key])
    if (value) return value
  }
  return null
}

function childRunIdForRecord(record: TaskProjectionRecord): string | null {
  const continuation = asRecord(record.continuationRef)
  return stringValue(continuation?.childRunId)
    || (record.taskId.startsWith('skill-child:') ? record.taskId.slice('skill-child:'.length) : null)
}

function childRunPayload(record: SkillTaskRunRecord | null | undefined): JsonRecord | null {
  const payload = asRecord(record?.resumePayload)
  return asRecord(payload?.childRun)
}

function findTaskRunForProjection(
  record: TaskProjectionRecord,
  taskRuns: SkillTaskRunRecord[],
): SkillTaskRunRecord | null {
  const childRunId = childRunIdForRecord(record)
  if (childRunId) {
    const exact = taskRuns.find((run) => run.id === childRunId)
      || taskRuns.find((run) => stringValue(childRunPayload(run)?.childRunId) === childRunId)
    if (exact) return exact
  }
  const continuation = asRecord(record.continuationRef)
  const taskRunId = stringValue(continuation?.taskRunId)
  if (taskRunId) {
    const exact = taskRuns.find((run) => run.id === taskRunId)
    if (exact) return exact
  }
  return null
}

function readChildRunLogHandles(eventLogPath: string | null): Partial<ProjectionHandles> {
  if (!eventLogPath) return {}
  let outputDir: string | null = null
  let runStatePath: string | null = null
  let deliveryReportPath: string | null = null
  try {
    const raw = readFileSync(eventLogPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let event: JsonRecord | null
      try {
        event = asRecord(JSON.parse(line) as unknown)
      } catch {
        continue
      }
      if (!event) continue
      if (event.type === 'state_observed') {
        runStatePath = stringValue(event.runStatePath) ?? runStatePath
        const state = asRecord(event.state)
        outputDir = stringValue(state?.outputDir)
          ?? stringValue(state?.output_dir)
          ?? stringValue(state?.active_output_dir)
          ?? outputDir
      }
      if (event.type === 'close') {
        const close = asRecord(event.close)
        outputDir = stringValue(close?.outputDir) ?? outputDir
        runStatePath = stringValue(close?.runStatePath) ?? runStatePath
        deliveryReportPath = stringValue(close?.deliveryReportPath) ?? deliveryReportPath
      }
    }
  } catch {
    return {}
  }
  return { outputDir, runStatePath, deliveryReportPath }
}

function enrichHandlesFromRunState(handles: ProjectionHandles): ProjectionHandles {
  const runStatePath = handles.runStatePath || (handles.outputDir ? join(handles.outputDir, 'run_state.json') : null)
  const runState = readRunStateJson(runStatePath)
  const outputDir = handles.outputDir
    || stringValue(runState?.active_output_dir)
    || stringValue(runState?.output_dir)
    || stringValue(runState?.outputDir)
    || (runStatePath ? dirname(runStatePath) : null)
  const deliveryReportPath = handles.deliveryReportPath
    || stringValue(runState?.delivery_report_path)
    || stringValue(runState?.deliveryReportPath)
    || (outputDir ? join(outputDir, 'delivery_report.json') : null)
  return {
    ...handles,
    outputDir: normalizePath(outputDir),
    runStatePath,
    deliveryReportPath,
  }
}

/**
 * Stage 3 W3 — origin tracking for the 8-field × 6-source handle resolution.
 *
 * `deriveHandles` retains its existing public signature; `deriveHandlesWithOrigins`
 * exposes a per-field origin map alongside the same handles, used by the
 * reconciler to emit `projection_handle_legacy_origin_used` when a late
 * fallback fired. The `||` chains below are byte-identical to the previous
 * implementation: each successful step is mirrored with a `Partial<HandleOriginMap>`
 * stamp, and `finalizeOriginMap` fills any unset field with `'missing'` —
 * critical because pre-filled `'missing'` would defeat `??=` short-circuit
 * semantics elsewhere.
 */
export type ProjectionHandleOrigin =
  | 'continuation_ref'
  | 'skill_task_run'
  | 'child_payload'
  | 'artifact_meta'
  | 'artifact_path'
  | 'run_state_enrichment'
  | 'event_log'
  /**
   * Stage 3 W3 follow-up — only the `childRunId` field uses this origin.
   * It fires when `record.taskId` carried the `skill-child:` prefix and we
   * extracted the id from there (i.e. neither `continuationRef.childRunId`
   * nor `payload.childRunId` was present). Healthy upstream paths persist
   * `childRunId` in `continuationRef`, so this origin is observability for
   * "DB row exists but its continuation lost the handle."
   */
  | 'projection_task_id'
  | 'missing'

export type HandleOriginMap = Record<keyof ProjectionHandles, ProjectionHandleOrigin>

const PROJECTION_HANDLE_FIELDS: Array<keyof ProjectionHandles> = [
  'childRunId',
  'skillId',
  'action',
  'taskRunId',
  'outputDir',
  'runStatePath',
  'deliveryReportPath',
  'eventLogPath',
]

function finalizeOriginMap(partial: Partial<HandleOriginMap>): HandleOriginMap {
  const result = {} as HandleOriginMap
  for (const field of PROJECTION_HANDLE_FIELDS) {
    result[field] = partial[field] ?? 'missing'
  }
  return result
}

export function deriveHandlesWithOrigins(
  record: TaskProjectionRecord,
  taskRun?: SkillTaskRunRecord | null,
): { handles: ProjectionHandles; origins: HandleOriginMap } {
  const continuation = asRecord(record.continuationRef)
  const payload = childRunPayload(taskRun)
  const origins: Partial<HandleOriginMap> = {}

  let childRunId = stringValue(continuation?.childRunId)
    || childRunIdForRecord(record)
    || stringValue(payload?.childRunId)
    || taskRun?.id
    || null
  if (stringValue(continuation?.childRunId)) origins.childRunId = 'continuation_ref'
  // childRunIdForRecord falls through to taskId prefix extraction when
  // continuation.childRunId is absent — the first branch above already
  // captured the continuation case, so reaching here is unambiguously
  // the taskId-prefix fallback.
  else if (childRunIdForRecord(record)) origins.childRunId = 'projection_task_id'
  else if (stringValue(payload?.childRunId)) origins.childRunId = 'child_payload'
  else if (taskRun?.id) origins.childRunId = 'skill_task_run'

  let skillId = stringValue(continuation?.skillId)
    || stringValue(payload?.skillId)
    || taskRun?.skillId
    || null
  if (stringValue(continuation?.skillId)) origins.skillId = 'continuation_ref'
  else if (stringValue(payload?.skillId)) origins.skillId = 'child_payload'
  else if (taskRun?.skillId) origins.skillId = 'skill_task_run'

  let action = stringValue(continuation?.action)
    || stringValue(payload?.requestedAction)
    || taskRun?.action
    || null
  if (stringValue(continuation?.action)) origins.action = 'continuation_ref'
  else if (stringValue(payload?.requestedAction)) origins.action = 'child_payload'
  else if (taskRun?.action) origins.action = 'skill_task_run'

  let taskRunId = stringValue(continuation?.taskRunId)
    || taskRun?.id
    || null
  if (stringValue(continuation?.taskRunId)) origins.taskRunId = 'continuation_ref'
  else if (taskRun?.id) origins.taskRunId = 'skill_task_run'

  let outputDir = stringValue(continuation?.outputDir)
    || taskRun?.outputDir
    || stringValue(payload?.outputDir)
  if (stringValue(continuation?.outputDir)) origins.outputDir = 'continuation_ref'
  else if (taskRun?.outputDir) origins.outputDir = 'skill_task_run'
  else if (stringValue(payload?.outputDir)) origins.outputDir = 'child_payload'

  let runStatePath = stringValue(continuation?.runStatePath)
    || taskRun?.runStatePath
    || stringValue(payload?.runStatePath)
  if (stringValue(continuation?.runStatePath)) origins.runStatePath = 'continuation_ref'
  else if (taskRun?.runStatePath) origins.runStatePath = 'skill_task_run'
  else if (stringValue(payload?.runStatePath)) origins.runStatePath = 'child_payload'

  let deliveryReportPath = pathFromArtifactMeta(continuation, ['deliveryReportPath', 'delivery_report_path'])
    || taskRun?.deliveryReportPath
  if (pathFromArtifactMeta(continuation, ['deliveryReportPath', 'delivery_report_path'])) {
    origins.deliveryReportPath = 'continuation_ref'
  } else if (taskRun?.deliveryReportPath) {
    origins.deliveryReportPath = 'skill_task_run'
  }

  let eventLogPath = stringValue(payload?.eventLogPath)
  if (stringValue(payload?.eventLogPath)) origins.eventLogPath = 'child_payload'

  for (const artifact of record.recentArtifacts || []) {
    const artifactRecord = asRecord(artifact)
    if (!artifactRecord) continue
    const artifactPath = stringValue(artifactRecord.path)
    const meta = asRecord(artifactRecord.meta)

    if (!childRunId) {
      const v = pathFromArtifactMeta(meta, ['childRunId', 'child_run_id'])
      if (v) { childRunId = v; origins.childRunId = 'artifact_meta' }
    }
    if (!skillId) {
      const v = pathFromArtifactMeta(meta, ['skillId', 'skill_id'])
      if (v) { skillId = v; origins.skillId = 'artifact_meta' }
    }
    if (!action) {
      const v = pathFromArtifactMeta(meta, ['action'])
      if (v) { action = v; origins.action = 'artifact_meta' }
    }
    if (!outputDir) {
      const v = pathFromArtifactMeta(meta, ['outputDir', 'output_dir'])
      if (v) { outputDir = v; origins.outputDir = 'artifact_meta' }
    }
    if (!runStatePath) {
      const v = pathFromArtifactMeta(meta, ['runStatePath', 'run_state_path'])
      if (v) { runStatePath = v; origins.runStatePath = 'artifact_meta' }
    }
    if (!deliveryReportPath) {
      const v = pathFromArtifactMeta(meta, ['deliveryReportPath', 'delivery_report_path'])
      if (v) { deliveryReportPath = v; origins.deliveryReportPath = 'artifact_meta' }
    }
    if (!eventLogPath) {
      const v = pathFromArtifactMeta(meta, ['eventLogPath', 'event_log_path'])
      if (v) { eventLogPath = v; origins.eventLogPath = 'artifact_meta' }
    }

    if (artifactPath?.endsWith('/run_state.json') || artifactPath?.endsWith('\\run_state.json')) {
      if (!runStatePath) { runStatePath = artifactPath; origins.runStatePath = 'artifact_path' }
      if (!outputDir) { outputDir = dirname(artifactPath); origins.outputDir = 'artifact_path' }
    }
    if (artifactPath?.endsWith('/delivery_report.json') || artifactPath?.endsWith('\\delivery_report.json')) {
      if (!deliveryReportPath) { deliveryReportPath = artifactPath; origins.deliveryReportPath = 'artifact_path' }
      if (!outputDir) { outputDir = dirname(artifactPath); origins.outputDir = 'artifact_path' }
    }
  }

  if (!runStatePath && outputDir) {
    runStatePath = join(outputDir, 'run_state.json')
    origins.runStatePath = 'artifact_path'
  }
  if (!deliveryReportPath && outputDir) {
    deliveryReportPath = join(outputDir, 'delivery_report.json')
    origins.deliveryReportPath = 'artifact_path'
  }
  if (!outputDir && runStatePath) {
    outputDir = dirname(runStatePath)
    origins.outputDir = 'artifact_path'
  }
  if (!outputDir && deliveryReportPath) {
    outputDir = dirname(deliveryReportPath)
    origins.outputDir = 'artifact_path'
  }

  const logHandles = readChildRunLogHandles(eventLogPath)
  if (!outputDir && logHandles.outputDir) {
    outputDir = logHandles.outputDir
    origins.outputDir = 'event_log'
  }
  if (!runStatePath && logHandles.runStatePath) {
    runStatePath = logHandles.runStatePath
    origins.runStatePath = 'event_log'
  }
  if (!deliveryReportPath && logHandles.deliveryReportPath) {
    deliveryReportPath = logHandles.deliveryReportPath
    origins.deliveryReportPath = 'event_log'
  }

  const before: ProjectionHandles = {
    childRunId,
    skillId,
    action,
    taskRunId,
    outputDir: normalizePath(outputDir ?? null),
    runStatePath: runStatePath ?? null,
    deliveryReportPath: deliveryReportPath ?? null,
    eventLogPath: eventLogPath ?? null,
  }
  const enriched = enrichHandlesFromRunState(before)

  // run_state enrichment can promote outputDir / runStatePath / deliveryReportPath;
  // stamp the new origin only when enrichment actually filled a previously-empty field.
  if (!before.outputDir && enriched.outputDir) origins.outputDir = 'run_state_enrichment'
  if (!before.runStatePath && enriched.runStatePath) origins.runStatePath = 'run_state_enrichment'
  if (!before.deliveryReportPath && enriched.deliveryReportPath) origins.deliveryReportPath = 'run_state_enrichment'

  return { handles: enriched, origins: finalizeOriginMap(origins) }
}

function deriveHandles(record: TaskProjectionRecord, taskRun?: SkillTaskRunRecord | null): ProjectionHandles {
  return deriveHandlesWithOrigins(record, taskRun).handles
}

function hasDurableHandle(handles: ProjectionHandles): boolean {
  // Stage Q (Stage 11) — single-source via `canResumeShape`. The prior
  // local predicate (`outputDir || runStatePath`) was the strict version
  // and remains semantically equivalent here, but routing through the
  // helper unifies the contract across all 5 layers (Stage Q audit §3.1
  // / plan §3.4 / contract C6).
  return canResumeShape({
    childRunId: handles.childRunId,
    detachedTaskId: null, // ProjectionHandles doesn't carry detachedTaskId
    outputDir: handles.outputDir,
    runStatePath: handles.runStatePath,
  })
}

function isCompleteStatus(value: unknown): boolean {
  const status = String(value || '').trim().toLowerCase()
  return status === 'completed' || status === 'complete' || status === 'success' || status === 'done'
}

function runStateIsCompleted(runState: JsonRecord | null): boolean {
  if (!runState) return false
  return isCompleteStatus(runState.status)
    || isCompleteStatus(runState.current_stage)
    || isCompleteStatus(runState.currentStage)
    || isCompleteStatus(runState.stage)
}

function listIsEmptyOrMissing(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0
}

function hasCleanDeliveryBlockers(delivery: JsonRecord): boolean {
  for (const key of [
    'missing_outputs',
    'blocked_batches',
    'incomplete_scene_numbers',
    'missing_screenshot_scenes',
    'missing_sample_scenes',
    'blockers',
  ]) {
    if (!listIsEmptyOrMissing(delivery[key])) return false
  }
  if (stringValue(delivery.last_error)) return false
  const verification = asRecord(delivery.verification)
  if (verification && verification.passed === false) return false
  return true
}

function requiredOutputPath(outputDir: string | null, entry: unknown): string | null {
  if (typeof entry === 'string' && entry.trim()) {
    const value = entry.trim()
    return isAbsolute(value) ? value : outputDir ? resolve(outputDir, value) : value
  }
  const record = asRecord(entry)
  const value = stringValue(record?.path)
  if (!value) return null
  return isAbsolute(value) ? value : outputDir ? resolve(outputDir, value) : value
}

function requiredOutputsAreComplete(delivery: JsonRecord, outputDir: string | null): boolean {
  const requiredOutputs = asRecord(delivery.required_outputs)
  if (!requiredOutputs) return false
  for (const key of REQUIRED_VEA_OUTPUT_KEYS) {
    if (!(key in requiredOutputs)) return false
    const entry = requiredOutputs[key]
    const record = asRecord(entry)
    if (record && record.ok === false) return false
    if (!nonEmptyFile(requiredOutputPath(outputDir, entry))) return false
  }
  return true
}

function veaProjectionIsDone(
  handles: ProjectionHandles,
  runState: JsonRecord | null,
  delivery: JsonRecord | null,
): boolean {
  if (!runStateIsCompleted(runState)) return false
  if (!delivery || !isCompleteStatus(delivery.status)) return false
  if (!hasCleanDeliveryBlockers(delivery)) return false
  if (!requiredOutputsAreComplete(delivery, handles.outputDir)) return false
  const progress = inspectSkillProgressArtifacts({
    outputDir: handles.outputDir,
    sceneScoresPath: handles.outputDir ? join(handles.outputDir, 'scene_scores.json') : null,
  })
  if (
    progress.totalScenes !== null
    && progress.completedScenes !== null
    && progress.completedScenes < progress.totalScenes
  ) {
    return false
  }
  return true
}

function projectionIsDone(handles: ProjectionHandles): boolean {
  const outputDir = handles.outputDir
  const runStatePath = handles.runStatePath || (outputDir ? join(outputDir, 'run_state.json') : null)
  const deliveryReportPath = handles.deliveryReportPath || (outputDir ? join(outputDir, 'delivery_report.json') : null)
  const runState = readRunStateJson(runStatePath)
  const delivery = readJson(deliveryReportPath)

  if (handles.skillId === 'video-expert-analyzer') {
    return veaProjectionIsDone(handles, runState, delivery)
  }
  if (!runStateIsCompleted(runState)) return false
  if (!delivery) return true
  return isCompleteStatus(delivery.status) && hasCleanDeliveryBlockers(delivery)
}

function timestampMs(value: string | Date | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : Date.now()
}

function arraysEqual(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  const a = left || []
  const b = right || []
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

function appendMissingActions(
  actions: ScopeRunResumableAction[] | undefined,
  required: ScopeRunResumableAction[],
): ScopeRunResumableAction[] {
  const result: ScopeRunResumableAction[] = [...(actions || []).filter((action) => action !== 'none')]
  for (const action of required) {
    if (!result.includes(action)) result.push(action)
  }
  return result
}

function mergeContinuationRef(
  record: TaskProjectionRecord,
  handles: ProjectionHandles,
): TaskProjectionRecord['continuationRef'] {
  if (
    !handles.childRunId
    && !handles.skillId
    && !handles.action
    && !handles.taskRunId
    && !handles.outputDir
    && !handles.runStatePath
  ) {
    return record.continuationRef ?? null
  }
  return {
    ...(record.continuationRef || {}),
    taskId: record.taskId,
    childRunId: handles.childRunId,
    taskRunId: handles.taskRunId,
    skillId: handles.skillId,
    action: handles.action,
    outputDir: handles.outputDir,
    runStatePath: handles.runStatePath,
  }
}

function progressFromHandles(handles: ProjectionHandles): ScopeRunSkillProgress | null {
  const outputDir = handles.outputDir
  const runStatePath = handles.runStatePath || (outputDir ? join(outputDir, 'run_state.json') : null)
  const runState = readRunStateJson(runStatePath)
  const artifactProgress = inspectSkillProgressArtifacts({
    outputDir,
    sceneScoresPath: outputDir ? join(outputDir, 'scene_scores.json') : null,
  })
  if (!runState && !artifactProgress.hasEvidence) return null
  return {
    stage: runStateString(runState, 'current_stage', 'currentStage', 'stage', 'current_step', 'currentStep'),
    completed: artifactProgress.completedScenes ?? numberValue(runState?.completed_scenes ?? runState?.completedScenes ?? runState?.completed),
    total: artifactProgress.totalScenes ?? numberValue(runState?.total_scenes ?? runState?.totalScenes ?? runState?.total),
    coverage: artifactProgress.coverageRatio ?? numberValue(runState?.coverage_ratio ?? runState?.coverageRatio ?? runState?.coverage),
    overallCoverage: null,
    fingerprint: artifactProgress.activity?.fingerprint ?? runStateString(runState, 'fingerprint', 'progress_fingerprint', 'progressFingerprint', 'updated_at', 'updatedAt'),
    updatedAt: artifactProgress.activity?.updatedAt ?? runStateString(runState, 'updated_at', 'updatedAt', 'lastUpdated'),
    lastError: null,
    detail: artifactProgress.activity?.summary ?? null,
    activityUpdatedAt: artifactProgress.activity?.updatedAt ?? null,
    handoff: artifactProgress.handoff,
  }
}

function completedContinuationRef(
  record: TaskProjectionRecord,
  handles: ProjectionHandles,
  progress: ScopeRunSkillProgress | null,
): TaskProjectionRecord['continuationRef'] {
  const continuation = mergeContinuationRef(record, handles)
  if (!continuation) return null
  return {
    ...continuation,
    blockerType: 'completed',
    pauseReason: 'completed',
    progressFingerprint: progress?.fingerprint ?? continuation.progressFingerprint ?? null,
    progress,
  } as TaskProjectionRecord['continuationRef']
}

function mergeProjectionArtifacts(
  record: TaskProjectionRecord,
  handles: ProjectionHandles,
  now: string,
): TaskProjectionRecord['recentArtifacts'] {
  const existing = record.recentArtifacts || []
  const outputDir = handles.outputDir
  const runStatePath = handles.runStatePath || (outputDir ? join(outputDir, 'run_state.json') : null)
  const sceneScoresPath = outputDir ? join(outputDir, 'scene_scores.json') : null
  const deliveryReportPath = handles.deliveryReportPath || (outputDir ? join(outputDir, 'delivery_report.json') : null)
  const candidates = [
    outputDir ? { key: 'outputDir', path: outputDir, label: '输出目录', kind: 'output_dir' } : null,
    runStatePath && nonEmptyFile(runStatePath) ? { key: 'runStatePath', path: runStatePath, label: 'run_state.json', kind: 'run_state' } : null,
    sceneScoresPath && nonEmptyFile(sceneScoresPath) ? { key: 'sceneScoresPath', path: sceneScoresPath, label: 'scene_scores.json', kind: 'scene_scores' } : null,
    deliveryReportPath && nonEmptyFile(deliveryReportPath) ? { key: 'deliveryReportPath', path: deliveryReportPath, label: 'delivery_report.json', kind: 'delivery_report' } : null,
  ].filter((item): item is { key: string; path: string; label: string; kind: string } => Boolean(item))
  const seen = new Set(existing.map((item) => item.path).filter((path): path is string => Boolean(path)))
  const additions = candidates
    .filter((item) => pathExists(item.path) && !seen.has(item.path))
    .map((item) => ({
      id: `${record.taskId}:${item.key}`,
      module: 'skill',
      kind: item.kind,
      label: item.label,
      path: item.path,
      createdAt: now,
      meta: {
        outputKey: item.key,
        outputDir,
        runStatePath,
        ...(deliveryReportPath ? { deliveryReportPath } : {}),
        ...(handles.childRunId ? { childRunId: handles.childRunId } : {}),
        ...(handles.skillId ? { skillId: handles.skillId } : {}),
        ...(handles.action ? { action: handles.action } : {}),
      },
    }))
  return [...existing, ...additions]
}

function patchSteps(
  record: TaskProjectionRecord,
  status: 'blocked' | 'completed' | 'killed',
  now: string,
): TaskProjectionRecord['steps'] {
  const stepStatus = status === 'completed' ? 'done' : status === 'killed' ? 'error' : 'blocked'
  const fallbackTitle = status === 'completed' ? '任务已完成' : status === 'killed' ? '任务状态已过期' : '等待继续'
  const sourceSteps = record.steps && record.steps.length > 0
    ? record.steps
    : [{ id: record.currentStepId || 'projection-reconcile', title: fallbackTitle, status: 'pending' as const, updatedAt: record.updatedAt }]
  return sourceSteps.map((step, index) => {
    if (record.currentStepId && step.id !== record.currentStepId) return step
    if (!record.currentStepId && index < sourceSteps.length - 1) return step
    if (step.status === stepStatus) return step
    return {
      ...step,
      status: stepStatus,
      updatedAt: now,
    }
  })
}

function completedTaskSummary(record: TaskProjectionRecord): string {
  const summary = String(record.taskSummary || '').trim()
  if (!summary || summary.includes('进行中')) return '技能任务已完成'
  return summary
}

function buildPatch(
  record: TaskProjectionRecord,
  now: string,
  target: Partial<TaskProjectionRecord>,
): Partial<TaskProjectionRecord> | null {
  const patch: Partial<TaskProjectionRecord> = {}
  const assign = <K extends keyof TaskProjectionRecord>(key: K, value: TaskProjectionRecord[K]): void => {
    const current = record[key]
    const changed = Array.isArray(current) || Array.isArray(value)
      ? !arraysEqual(current as unknown[] | undefined, value as unknown[] | undefined)
      : current && value && typeof current === 'object' && typeof value === 'object'
        ? JSON.stringify(current) !== JSON.stringify(value)
      : current !== value
    if (changed) patch[key] = value
  }

  for (const [key, value] of Object.entries(target) as Array<[keyof TaskProjectionRecord, TaskProjectionRecord[keyof TaskProjectionRecord]]>) {
    assign(key, value)
  }
  if (Object.keys(patch).length === 0) return null
  patch.updatedAt = now
  return patch
}

export function reconcileTaskProjections(params: ReconcileTaskProjectionsParams): number {
  const now = typeof params.now === 'string' ? params.now : new Date(timestampMs(params.now)).toISOString()
  const nowMs = timestampMs(now)
  let changed = 0

  for (const record of params.records) {
    if (!RECONCILABLE_STATUSES.has(record.status)) continue
    const taskRun = findTaskRunForProjection(record, params.taskRuns || [])
    const { handles, origins } = deriveHandlesWithOrigins(record, taskRun)
    emitProjectionHandleLegacyOriginMetrics(record.taskId, origins)

    let target: Partial<TaskProjectionRecord> | null = null
    if (record.status === 'completed') {
      if (!projectionIsDone(handles)) continue
      const progress = progressFromHandles(handles)
      target = {
        status: 'completed',
        interactionState: 'suspended',
        waitingFor: 'none',
        taskSummary: completedTaskSummary(record),
        blockedReason: null,
        degradationReason: null,
        resumableActions: ['open_artifact'],
        continuationRef: completedContinuationRef(record, handles, progress),
        progress,
        recentArtifacts: mergeProjectionArtifacts(record, handles, now),
        steps: patchSteps(record, 'completed', now),
      }
    } else if (projectionIsDone(handles)) {
      const progress = progressFromHandles(handles)
      target = {
        status: 'completed',
        interactionState: 'suspended',
        waitingFor: 'none',
        taskSummary: completedTaskSummary(record),
        blockedReason: null,
        degradationReason: null,
        resumableActions: ['open_artifact'],
        continuationRef: completedContinuationRef(record, handles, progress),
        progress,
        recentArtifacts: mergeProjectionArtifacts(record, handles, now),
        steps: patchSteps(record, 'completed', now),
      }
    } else if (hasDurableHandle(handles)) {
      target = {
        status: 'blocked',
        interactionState: 'suspended',
        waitingFor: 'background',
        blockedReason: '任务产物尚未完成，可从已保存的进度继续',
        resumableActions: appendMissingActions(record.resumableActions, ['continue', 'cancel']),
        continuationRef: mergeContinuationRef(record, handles),
        steps: patchSteps(record, 'blocked', now),
      }
    } else if (!hasDurableHandle(handles) && nowMs - timestampMs(record.updatedAt) > STALE_WITHOUT_HANDLE_MS) {
      target = {
        status: 'blocked',
        interactionState: 'suspended',
        waitingFor: 'none',
        degradationReason: 'stale_paused',
        blockedReason: '任务状态已过期，缺少可续跑句柄',
        resumableActions: ['none'],
        steps: patchSteps(record, 'blocked', now),
      }
    }

    if (!target) continue
    const patch = buildPatch(record, now, target)
    if (!patch) continue
    // Stage O §0.2 / O2.1 — reconciler writes are themselves driven by a
    // renderer fetch (`runtime.listTaskProjections` calls reconcileTaskProjections
    // in-line). Emitting `change` here would loop fetch → reconcile → push
    // → fetch. `silent: true` breaks the cycle while keeping the SQL
    // commit; the renderer will see the reconciled value on the next
    // genuine event-driven fetch.
    void params.store.update(record.taskId, patch, { silent: true })
    changed += 1
  }

  return changed
}
