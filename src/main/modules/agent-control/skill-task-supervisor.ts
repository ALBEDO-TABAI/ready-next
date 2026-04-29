import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  getDetachedSkillTaskTracker,
  type DetachedSkillTaskRecord,
} from './detached-skill-task-tracker'
import { readSkillTaskProjection } from './skill-task-tracker'
import { getRepositoryDatabase } from '../repositories/database-accessor'
import {
  SkillTaskRunRepository,
  type SkillTaskRunRecord,
} from '../repositories/skill-task-run-repository'
import { selectRunStateCandidate, type RunStateCandidate, type RunStateSelection } from './run-state-selection'
import { inspectSkillProgressArtifacts } from './skill-progress-artifacts'

const RUN_STATE_FILENAME = 'run_state.json'
const RUN_STATE_SEARCH_DEPTH = 1
const HEARTBEAT_FRESH_MS = 120_000
const OUTPUT_ACTIVITY_FRESH_MS = 180_000
const STALE_MS = 600_000

export type SkillTaskSupervisorStatus =
  | 'running'
  | 'background_running'
  | 'budget_paused'
  | 'recoverable_paused'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'cancelled'
  | 'unknown'

export interface SkillTaskSupervisorProgress {
  currentStage?: string | null
  totalScenes?: number | null
  completedScenes?: number | null
  coverageRatio?: number | null
  updatedAt?: string | null
}

export interface SkillTaskSupervisorSourceObservation {
  source:
    | 'detached'
    | 'task_run'
    | 'run_state'
    | 'pid'
    | 'output_activity'
    | 'artifact_progress'
    | 'projection'
    | 'supervisor'
  status?: string | null
  message?: string | null
  path?: string | null
  live?: boolean
  stale?: boolean
}

export interface SkillTaskSupervisorSnapshot {
  taskRunId: string | null
  detachedTaskId: string | null
  skillId: string | null
  scopeId: string | null
  sessionId: string | null
  action: string | null
  status: SkillTaskSupervisorStatus
  hasLiveWork: boolean
  hasRecentProgress: boolean
  closeAllowed: boolean
  ambiguous: boolean
  stale: boolean
  outputDir: string | null
  runStatePath: string | null
  sceneScoresPath: string | null
  deliveryReportPath: string | null
  progress: SkillTaskSupervisorProgress
  blockers: string[]
  pauseReason: string | null
  resumePayload: Record<string, unknown> | null
  sourceObservations: SkillTaskSupervisorSourceObservation[]
  progressFingerprint: string | null
  observedAt: string
  lastProgressAt: string | null
}

export interface InspectSkillTaskParams {
  taskRunId?: string | null
  detachedTaskId?: string | null
  taskRun?: SkillTaskRunRecord | null
  detachedTask?: DetachedSkillTaskRecord | null
  sessionId?: string | null
  scopeId?: string | null
  skillId?: string | null
  action?: string | null
  outputDir?: string | null
  runStatePath?: string | null
  expectedTaskId?: string | null
}

export interface SkillTaskSupervisorDependencies {
  now?: () => number
  getDetachedTask?: (taskId: string) => DetachedSkillTaskRecord | null
  listDetachedTasks?: (params?: { scopeId?: string | null }) => DetachedSkillTaskRecord[]
  getTaskRun?: (taskRunId: string) => SkillTaskRunRecord | null
  findTaskRunByDetachedTaskId?: (detachedTaskId: string) => SkillTaskRunRecord | null
  listActiveTaskRuns?: (sessionId: string, limit?: number) => SkillTaskRunRecord[]
  findLatestRecoverableTaskRun?: (params: {
    sessionId?: string | null
    scopeId?: string | null
    skillId?: string | null
    includeDone?: boolean
  }) => SkillTaskRunRecord | null
  readProjection?: (params: { sessionId?: string; skillId?: string }) => unknown | null
  pidExists?: (pid: number) => boolean
}

interface RunStateInfo {
  path: string
  mtimeMs: number
  taskId: string | null
  pid: number | null
  status: string | null
  currentStage: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
  updatedAt: string | null
  activeOutputDir: string | null
  lastError: string | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function getDefaultTaskRunRepository(): SkillTaskRunRepository | null {
  try {
    const database = getRepositoryDatabase()
    if (!database.getRawDb()) return null
    return new SkillTaskRunRepository(database)
  } catch {
    return null
  }
}

function defaultPidExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function statFile(path: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number } | null {
  try {
    const stat = statSync(path)
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function selectRunStateFile(params: {
  outputDir?: string | null
  explicitPath?: string | null
  expectedTaskId?: string | null
}): RunStateSelection {
  return selectRunStateCandidate({
    rootDir: params.outputDir,
    explicitRunStatePath: params.explicitPath,
    expectedTaskId: params.expectedTaskId,
    fileName: RUN_STATE_FILENAME,
    searchDepth: RUN_STATE_SEARCH_DEPTH,
  })
}

function readRunStateInfo(path: string): RunStateInfo | null {
  const stat = statFile(path)
  if (!stat?.isFile) return null
  const rec = readJson(path)
  if (!rec) return null
  return {
    path,
    mtimeMs: stat.mtimeMs,
    taskId: nonEmpty(rec.task_id) || nonEmpty(rec.taskId),
    pid: numberValue(rec.pid),
    status: nonEmpty(rec.status)?.toLowerCase() || null,
    currentStage: nonEmpty(rec.current_stage) || nonEmpty(rec.currentStage) || nonEmpty(rec.current_step) || nonEmpty(rec.currentStep),
    totalScenes: numberValue(rec.total_scenes ?? rec.totalScenes),
    completedScenes: numberValue(rec.completed_scenes ?? rec.completedScenes),
    coverageRatio: numberValue(rec.coverage_ratio ?? rec.coverageRatio),
    updatedAt: nonEmpty(rec.updated_at) || nonEmpty(rec.updatedAt) || nonEmpty(rec.lastUpdated),
    activeOutputDir: nonEmpty(rec.active_output_dir) || nonEmpty(rec.activeOutputDir),
    lastError: nonEmpty(rec.last_error) || nonEmpty(rec.lastError) || nonEmpty(rec.error),
  }
}

function latestOutputMtime(root: string | null): number | null {
  if (!root) return null
  const rootStat = statFile(root)
  if (!rootStat?.isDirectory) return null
  let latest = rootStat.mtimeMs
  const visit = (dir: string, depth: number): void => {
    if (depth > 1) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, String(entry.name))
      const stat = statFile(path)
      if (stat) latest = Math.max(latest, stat.mtimeMs)
      if (entry.isDirectory() && depth < 1) visit(path, depth + 1)
    }
  }
  visit(root, 0)
  return latest
}

function statusFromDetached(status?: string | null): SkillTaskSupervisorStatus | null {
  if (status === 'running') return 'background_running'
  if (status === 'blocked') return 'blocked'
  if (status === 'failed') return 'failed'
  if (status === 'done') return 'done'
  if (status === 'cancelled') return 'cancelled'
  return null
}

function statusFromTaskRun(status?: string | null): SkillTaskSupervisorStatus | null {
  if (status === 'queued' || status === 'running') return 'running'
  if (status === 'blocked') return 'blocked'
  if (status === 'failed') return 'failed'
  if (status === 'done') return 'done'
  if (status === 'cancelled') return 'cancelled'
  return null
}

function statusFromRunState(status?: string | null): SkillTaskSupervisorStatus | null {
  if (!status) return null
  if (['running', 'waiting_for_batches', 'ready_to_finalize'].includes(status)) return 'background_running'
  if (status === 'paused') return 'recoverable_paused'
  if (['blocked', 'pending_review', 'awaiting_input'].includes(status)) return 'blocked'
  if (['failed', 'failure', 'error'].includes(status)) return 'failed'
  if (['completed', 'success', 'done'].includes(status)) return 'done'
  if (status === 'cancelled') return 'cancelled'
  return null
}

function isTerminal(status: SkillTaskSupervisorStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function snapshotHasDurableHandle(snapshot: SkillTaskSupervisorSnapshot): boolean {
  return Boolean(
    snapshot.resumePayload
      || snapshot.runStatePath
      || snapshot.outputDir
      || snapshot.detachedTaskId
      || snapshot.taskRunId,
  )
}

function scoreLatestSnapshot(snapshot: SkillTaskSupervisorSnapshot): number {
  let score = 0
  if (snapshot.hasLiveWork) score += 100
  if (snapshot.status === 'background_running' || snapshot.status === 'running') score += 60
  if (snapshot.status === 'blocked' || snapshot.status === 'budget_paused' || snapshot.status === 'recoverable_paused') score += 50
  if (snapshotHasDurableHandle(snapshot)) score += 30
  if (snapshot.hasRecentProgress) score += 20
  if (!snapshot.stale) score += 5
  if (snapshot.detachedTaskId) score += 4
  if (snapshot.progressFingerprint) score += 3
  const updatedAt = Date.parse(snapshot.lastProgressAt || snapshot.observedAt || '')
  if (Number.isFinite(updatedAt)) score += Math.min(2, updatedAt / 10 ** 16)
  return score
}

function buildProgressFingerprint(progress: SkillTaskSupervisorProgress, runStatePath: string | null): string | null {
  const parts = [
    runStatePath,
    progress.currentStage,
    progress.totalScenes,
    progress.completedScenes,
    progress.coverageRatio,
    progress.updatedAt,
  ].filter((part) => part !== null && part !== undefined)
  return parts.length > 0 ? JSON.stringify(parts) : null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

export class SkillTaskSupervisor {
  constructor(private readonly deps: SkillTaskSupervisorDependencies = {}) {}

  inspectSkillTask(params: InspectSkillTaskParams): SkillTaskSupervisorSnapshot {
    const observedAtMs = this.deps.now?.() ?? Date.now()
    const observedAt = new Date(observedAtMs).toISOString()
    const observations: SkillTaskSupervisorSourceObservation[] = []
    let detached: DetachedSkillTaskRecord | null = params.detachedTask || null
    let taskRun: SkillTaskRunRecord | null = params.taskRun || null

    const detachedTaskId = nonEmpty(params.detachedTaskId)
    if (detachedTaskId && !detached) {
      try {
        detached = this.getDetachedTask(detachedTaskId)
        observations.push({
          source: 'detached',
          status: detached?.status || null,
          message: detached ? null : 'detached task not found',
          live: detached?.status === 'running',
        })
      } catch (error) {
        observations.push({ source: 'detached', message: error instanceof Error ? error.message : String(error) })
      }
    }

    try {
      if (params.taskRunId && !taskRun) taskRun = this.getTaskRun(params.taskRunId)
      if (!taskRun && detachedTaskId) taskRun = this.findTaskRunByDetachedTaskId(detachedTaskId)
      observations.push({
        source: 'task_run',
        status: taskRun?.status || null,
        message: taskRun ? null : 'task run not found',
        live: taskRun?.status === 'running' || taskRun?.status === 'blocked',
      })
    } catch (error) {
      observations.push({ source: 'task_run', message: error instanceof Error ? error.message : String(error) })
    }

    const skillId = params.skillId || detached?.skillId || taskRun?.skillId || null
    const expectedTaskId = nonEmpty(params.expectedTaskId)
      || detached?.id
      || nonEmpty(taskRun?.detachedTaskId)
      || nonEmpty(taskRun?.jobId)
      || nonEmpty(taskRun?.runId)
      || nonEmpty((taskRun?.params as Record<string, unknown> | null | undefined)?.taskId)
      || nonEmpty((taskRun?.params as Record<string, unknown> | null | undefined)?.task_id)
    const explicitRunStatePath = params.runStatePath || detached?.runStatePath || taskRun?.runStatePath || null
    const outputDir = params.outputDir
      || detached?.outputDir
      || taskRun?.outputDir
      || (explicitRunStatePath ? dirname(explicitRunStatePath) : null)
    const selection = selectRunStateFile({
      outputDir,
      explicitPath: explicitRunStatePath,
      expectedTaskId,
    })
    if (selection.ambiguous) {
      observations.push({
        source: 'run_state',
        status: 'ambiguous',
        message: `multiple run_state.json files: ${selection.candidates.length}`,
      })
    }
    const runState = selection.path ? readRunStateInfo(selection.path) : null
    if (selection.path) {
      observations.push({
        source: 'run_state',
        status: runState?.status || null,
        path: selection.path,
      })
    }

    const pidLive = runState?.pid ? this.pidExists(runState.pid) : false
    if (runState?.pid) observations.push({ source: 'pid', status: String(runState.pid), live: pidLive })

    const lastProgressMs = runState?.updatedAt && Number.isFinite(Date.parse(runState.updatedAt))
      ? Date.parse(runState.updatedAt)
      : runState?.mtimeMs ?? null
    const heartbeatAge = lastProgressMs === null ? null : observedAtMs - lastProgressMs
    const heartbeatFresh = heartbeatAge !== null && heartbeatAge <= HEARTBEAT_FRESH_MS
    const stale = heartbeatAge !== null && heartbeatAge > STALE_MS
    const outputActivityMs = latestOutputMtime(runState?.activeOutputDir || outputDir || null)
    const outputFresh = outputActivityMs !== null && observedAtMs - outputActivityMs <= OUTPUT_ACTIVITY_FRESH_MS
    if (outputActivityMs !== null) {
      observations.push({ source: 'output_activity', live: outputFresh, stale: observedAtMs - outputActivityMs > STALE_MS })
    }
    const resolvedRunStatePath = runState?.path || selection.path || explicitRunStatePath || null
    const resolvedOutputDir = runState?.activeOutputDir || outputDir || (resolvedRunStatePath ? dirname(resolvedRunStatePath) : null)
    const artifactProgress = inspectSkillProgressArtifacts({
      outputDir: resolvedOutputDir,
      sceneScoresPath: detached?.sceneScoresPath || taskRun?.sceneScoresPath || (resolvedOutputDir ? join(resolvedOutputDir, 'scene_scores.json') : null),
    })
    if (artifactProgress.hasEvidence) {
      observations.push({
        source: 'artifact_progress',
        status: `${artifactProgress.completedScenes ?? 'unknown'}/${artifactProgress.totalScenes ?? 'unknown'}`,
        path: artifactProgress.sceneScoresPath || artifactProgress.hostBatchesIndexPath,
        live: false,
        stale: artifactProgress.hostBatches
          ? (artifactProgress.hostBatches.statusCounts.pending || 0) > 0
            || (artifactProgress.hostBatches.statusCounts.in_progress || 0) > 0
          : undefined,
      })
    }

    const detachedStatus = statusFromDetached(detached?.status)
    const taskRunStatus = statusFromTaskRun(taskRun?.status)
    const runStateStatus = statusFromRunState(runState?.status)
    const normalizedStatuses = [detachedStatus, taskRunStatus, runStateStatus].filter(Boolean) as SkillTaskSupervisorStatus[]
    const terminalStatuses = normalizedStatuses.filter((status) => isTerminal(status))
    const terminalSeen = terminalStatuses.length > 0
    const terminalConflict = new Set(terminalStatuses).size > 1
    const terminalLifecycleConflict = terminalSeen && normalizedStatuses.some((candidateStatus) => !isTerminal(candidateStatus))
    const liveByDetached = detached?.status === 'running'
    const liveByTaskRun = taskRun?.status === 'running'
    const blockedByTaskRun = taskRun?.status === 'blocked'
    const liveByRunState = runStateStatus === 'background_running' && heartbeatFresh
    const recoverableByRunState = Boolean(
      runStateStatus === 'background_running'
        && !heartbeatFresh
        && !pidLive
        && !liveByTaskRun
        && !liveByDetached
        && (resolvedRunStatePath || resolvedOutputDir),
    )
    const hasLiveWork = Boolean(liveByDetached || liveByTaskRun || liveByRunState || pidLive)
    const hasRecentProgress = Boolean(heartbeatFresh || outputFresh)
    let status: SkillTaskSupervisorStatus =
      liveByDetached ? 'background_running'
        : liveByTaskRun ? 'running'
          : liveByRunState ? 'background_running'
            : pidLive && runStateStatus === 'background_running' ? 'background_running'
              : blockedByTaskRun || runStateStatus === 'blocked' || detachedStatus === 'blocked' ? 'blocked'
                : taskRunStatus || detachedStatus || (recoverableByRunState ? 'recoverable_paused' : runStateStatus) || 'unknown'

    if (status === 'blocked' && (pidLive || outputFresh)) status = 'background_running'
    const progress: SkillTaskSupervisorProgress = {
      currentStage: runState?.currentStage || null,
      totalScenes: artifactProgress.totalScenes ?? runState?.totalScenes ?? null,
      completedScenes: artifactProgress.completedScenes ?? runState?.completedScenes ?? null,
      coverageRatio: artifactProgress.coverageRatio ?? runState?.coverageRatio ?? null,
      updatedAt: runState?.updatedAt || null,
    }
    const resumePayload = taskRun?.resumePayload
      || (detached
        ? {
          detachedTaskId: detached.id,
          runStatePath: resolvedRunStatePath,
          outputDir: resolvedOutputDir,
          skillId: detached.skillId,
          action: detached.action,
        }
        : null)
    const runStateNonTerminal = Boolean(runStateStatus && !isTerminal(runStateStatus))
    const hasDurableResumeHandle = Boolean(
      resolvedRunStatePath
        || resolvedOutputDir
        || resumePayload
        || taskRun?.resumePayload
        || detached?.id
        || taskRun?.detachedTaskId,
    )
    const terminalOnlyByStore = Boolean(
      isTerminal(status)
        && (taskRunStatus || detachedStatus)
        && runStateNonTerminal
        && hasDurableResumeHandle,
    )
    if (terminalConflict) {
      observations.push({
        source: 'supervisor',
        status: 'ambiguous_terminal_conflict',
        message: `conflicting terminal states: ${Array.from(new Set(terminalStatuses)).join(', ')}`,
      })
    }
    const ambiguous = selection.ambiguous
      || terminalConflict
      || Boolean(terminalLifecycleConflict && hasDurableResumeHandle)
      || Boolean(terminalSeen && hasLiveWork)
      || terminalOnlyByStore
    const closeAllowed = isTerminal(status) && !hasLiveWork && !ambiguous

    const projection = this.readProjection({ sessionId: params.sessionId || detached?.sessionId || taskRun?.sessionId || undefined, skillId: skillId || undefined })
    if (projection) observations.push({ source: 'projection', message: 'projection used as fallback context only' })

    return {
      taskRunId: taskRun?.id || null,
      detachedTaskId: detached?.id || taskRun?.detachedTaskId || detachedTaskId || null,
      skillId,
      scopeId: params.scopeId || detached?.scopeId || taskRun?.scopeId || null,
      sessionId: params.sessionId || detached?.sessionId || taskRun?.sessionId || null,
      action: params.action || detached?.action || taskRun?.action || null,
      status,
      hasLiveWork,
      hasRecentProgress,
      closeAllowed,
      ambiguous,
      stale,
      outputDir: resolvedOutputDir,
      runStatePath: resolvedRunStatePath,
      sceneScoresPath: detached?.sceneScoresPath || taskRun?.sceneScoresPath || (resolvedOutputDir ? join(resolvedOutputDir, 'scene_scores.json') : null),
      deliveryReportPath: detached?.deliveryReportPath || taskRun?.deliveryReportPath || (resolvedOutputDir ? join(resolvedOutputDir, 'delivery_report.json') : null),
      progress,
      blockers: uniqueStrings([runState?.lastError, detached?.error, taskRun?.failureDetail]),
      pauseReason: status === 'budget_paused' ? 'budget_exhausted' : null,
      resumePayload: resumePayload as Record<string, unknown> | null,
      sourceObservations: observations,
      progressFingerprint: buildProgressFingerprint(progress, resolvedRunStatePath),
      observedAt,
      lastProgressAt: lastProgressMs === null ? null : new Date(lastProgressMs).toISOString(),
    }
  }

  inspectLatestSkillTask(params: { sessionId?: string | null; scopeId?: string | null; skillId?: string | null }): SkillTaskSupervisorSnapshot {
    const sessionId = nonEmpty(params.sessionId) || nonEmpty(params.scopeId)
    const candidates: SkillTaskSupervisorSnapshot[] = []
    const matchingSkill = (skillId?: string | null): boolean => !params.skillId || skillId === params.skillId
    if (sessionId) {
      for (const run of this.listActiveTaskRuns(sessionId, 20).filter((item) => matchingSkill(item.skillId))) {
        candidates.push(this.inspectSkillTask({ taskRunId: run.id, taskRun: run, sessionId, skillId: params.skillId || run.skillId }))
      }
      for (const task of this.listDetachedTasks({ scopeId: sessionId }).filter((item) =>
        matchingSkill(item.skillId) && (item.status === 'running' || item.status === 'blocked'),
      )) {
        candidates.push(this.inspectSkillTask({ detachedTaskId: task.id, detachedTask: task, sessionId, skillId: params.skillId || task.skillId }))
      }
    }
    const latest = this.findLatestRecoverableTaskRun({
      sessionId,
      scopeId: params.scopeId,
      skillId: params.skillId,
      includeDone: true,
    })
    if (latest) candidates.push(this.inspectSkillTask({ taskRunId: latest.id, taskRun: latest, sessionId, skillId: params.skillId || latest.skillId }))
    if (candidates.length > 0) {
      return candidates
        .slice()
        .sort((left, right) => scoreLatestSnapshot(right) - scoreLatestSnapshot(left))[0]
    }
    return this.emptySnapshot()
  }

  private emptySnapshot(): SkillTaskSupervisorSnapshot {
    const observedAtMs = this.deps.now?.() ?? Date.now()
    return {
      taskRunId: null,
      detachedTaskId: null,
      skillId: null,
      scopeId: null,
      sessionId: null,
      action: null,
      status: 'unknown',
      hasLiveWork: false,
      hasRecentProgress: false,
      closeAllowed: false,
      ambiguous: false,
      stale: false,
      outputDir: null,
      runStatePath: null,
      sceneScoresPath: null,
      deliveryReportPath: null,
      progress: {},
      blockers: [],
      pauseReason: null,
      resumePayload: null,
      sourceObservations: [{ source: 'supervisor', message: 'no skill task found' }],
      progressFingerprint: null,
      observedAt: new Date(observedAtMs).toISOString(),
      lastProgressAt: null,
    }
  }

  private getDetachedTask(taskId: string): DetachedSkillTaskRecord | null {
    if (this.deps.getDetachedTask) return this.deps.getDetachedTask(taskId)
    return getDetachedSkillTaskTracker()?.inspect(taskId) || null
  }

  private listDetachedTasks(params?: { scopeId?: string | null }): DetachedSkillTaskRecord[] {
    if (this.deps.listDetachedTasks) return this.deps.listDetachedTasks(params)
    return getDetachedSkillTaskTracker()?.list(params) || []
  }

  private getTaskRun(taskRunId: string): SkillTaskRunRecord | null {
    if (this.deps.getTaskRun) return this.deps.getTaskRun(taskRunId)
    return getDefaultTaskRunRepository()?.get(taskRunId) || null
  }

  private findTaskRunByDetachedTaskId(detachedTaskId: string): SkillTaskRunRecord | null {
    if (this.deps.findTaskRunByDetachedTaskId) return this.deps.findTaskRunByDetachedTaskId(detachedTaskId)
    return getDefaultTaskRunRepository()?.findByDetachedTaskId(detachedTaskId) || null
  }

  private listActiveTaskRuns(sessionId: string, limit: number): SkillTaskRunRecord[] {
    if (this.deps.listActiveTaskRuns) return this.deps.listActiveTaskRuns(sessionId, limit)
    return getDefaultTaskRunRepository()?.listActiveBySession(sessionId, limit) || []
  }

  private findLatestRecoverableTaskRun(params: {
    sessionId?: string | null
    scopeId?: string | null
    skillId?: string | null
    includeDone?: boolean
  }): SkillTaskRunRecord | null {
    if (this.deps.findLatestRecoverableTaskRun) return this.deps.findLatestRecoverableTaskRun(params)
    return getDefaultTaskRunRepository()?.findLatestRecoverable(params) || null
  }

  private readProjection(params: { sessionId?: string; skillId?: string }): unknown | null {
    if (this.deps.readProjection) return this.deps.readProjection(params)
    return readSkillTaskProjection(params)
  }

  private pidExists(pid: number): boolean {
    return this.deps.pidExists ? this.deps.pidExists(pid) : defaultPidExists(pid)
  }
}

const defaultSupervisor = new SkillTaskSupervisor()

export function inspectSkillTask(params: InspectSkillTaskParams): SkillTaskSupervisorSnapshot {
  return defaultSupervisor.inspectSkillTask(params)
}

export function inspectLatestSkillTask(params: { sessionId?: string | null; scopeId?: string | null; skillId?: string | null }): SkillTaskSupervisorSnapshot {
  return defaultSupervisor.inspectLatestSkillTask(params)
}
