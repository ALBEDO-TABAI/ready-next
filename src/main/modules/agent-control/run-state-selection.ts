import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'

const DEFAULT_RUN_STATE_FILENAME = 'run_state.json'
const DEFAULT_SEARCH_DEPTH = 1

export interface RunStateCandidate {
  path: string
  mtimeMs: number
  taskId: string | null
  childRunId: string | null
  status: string | null
  currentStage: string | null
  activeOutputDir: string | null
}
export interface RunStateSelection {
  path: string | null
  ambiguous: boolean
  candidates: RunStateCandidate[]
}
export type NormalizedRunStateStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'

function errorKind(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : typeof error
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function normalizeRunStateStatus(value: unknown): NormalizedRunStateStatus | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!raw) return null
  if (raw === 'done' || raw === 'completed' || raw === 'complete' || raw === 'success' || raw === 'succeeded') return 'done'
  if (raw === 'failed' || raw === 'error') return 'failed'
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled'
  if (raw === 'blocked' || raw === 'paused' || raw === 'awaiting_input' || raw === 'pending_review') return 'blocked'
  if (raw === 'running' || raw === 'in_progress' || raw === 'processing' || raw === 'pending') return 'running'
  return null
}

function statFile(path: string): { isFile: boolean; isDirectory: boolean; mtimeMs: number } | null {
  try {
    const stat = statSync(path)
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function readRunStateCandidate(path: string, fileName: string): RunStateCandidate | null {
  const stat = statFile(path)
  if (!stat?.isFile || !path.endsWith(fileName)) return null
  let rec: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    rec = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    rec = {}
  }
  return {
    path,
    mtimeMs: stat.mtimeMs,
    taskId: nonEmptyString(rec.task_id) || nonEmptyString(rec.taskId),
    childRunId: nonEmptyString(rec.child_run_id) || nonEmptyString(rec.childRunId),
    status: nonEmptyString(rec.status),
    currentStage: nonEmptyString(rec.current_stage)
      || nonEmptyString(rec.currentStage)
      || nonEmptyString(rec.current_step)
      || nonEmptyString(rec.currentStep),
    activeOutputDir: nonEmptyString(rec.active_output_dir) || nonEmptyString(rec.activeOutputDir),
  }
}

function resolveActiveOutputPath(candidate: RunStateCandidate, fileName: string): string | null {
  const activeOutputDir = nonEmptyString(candidate.activeOutputDir)
  if (!activeOutputDir) return null
  const activePath = isAbsolute(activeOutputDir)
    ? activeOutputDir
    : join(dirname(candidate.path), activeOutputDir)
  return activePath.endsWith(fileName) ? activePath : join(activePath, fileName)
}

function followsExpectedTask(candidate: RunStateCandidate, expectedTaskId: string | null): boolean {
  return !expectedTaskId || !candidate.taskId || candidate.taskId === expectedTaskId
}

function followsExpectedChildRun(candidate: RunStateCandidate, expectedChildRunId: string | null): boolean {
  return !expectedChildRunId || candidate.childRunId === expectedChildRunId
}

function resolveActiveCandidate(
  candidate: RunStateCandidate,
  fileName: string,
  expectedTaskId: string | null,
  expectedChildRunId: string | null = null,
): RunStateCandidate {
  const activeRunStatePath = resolveActiveOutputPath(candidate, fileName)
  if (!activeRunStatePath || activeRunStatePath === candidate.path) return candidate
  const activeCandidate = readRunStateCandidate(activeRunStatePath, fileName)
  if (
    !activeCandidate
    || !followsExpectedTask(activeCandidate, expectedTaskId)
    || !followsExpectedChildRun(activeCandidate, expectedChildRunId)
  ) {
    return candidate
  }
  return activeCandidate
}

function dedupeCandidatesByPath(candidates: RunStateCandidate[]): RunStateCandidate[] {
  const deduped = new Map<string, RunStateCandidate>()
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.path)
    if (!existing || candidate.mtimeMs > existing.mtimeMs) {
      deduped.set(candidate.path, candidate)
    }
  }
  return Array.from(deduped.values()).sort((left, right) => right.mtimeMs - left.mtimeMs)
}

export function collectRunStateCandidates(params: {
  rootDir: string
  fileName?: string
  searchDepth?: number
}): RunStateCandidate[] {
  const rootDir = String(params.rootDir || '').trim()
  if (!rootDir) return []
  const fileName = params.fileName || DEFAULT_RUN_STATE_FILENAME
  const searchDepth = Math.max(0, Math.round(params.searchDepth ?? DEFAULT_SEARCH_DEPTH))
  const candidates = new Map<string, RunStateCandidate>()
  const addCandidate = (path: string): void => {
    const candidate = readRunStateCandidate(path, fileName)
    if (candidate) candidates.set(candidate.path, candidate)
  }

  const rootStat = statFile(rootDir)
  if (!rootStat) return []
  if (rootStat.isFile) {
    addCandidate(rootDir)
    return Array.from(candidates.values()).sort((left, right) => right.mtimeMs - left.mtimeMs)
  }
  if (!rootStat.isDirectory) return []

  addCandidate(join(rootDir, fileName))
  const visit = (dir: string, depth: number): void => {
    if (depth > searchDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[]
    } catch (error) {
      logAgentMetric(TOOL_ERROR_METRICS.runStateSelectionDirSkipped, {
        dir,
        errorKind: errorKind(error),
      })
      return
    }
    for (const entry of entries) {
      const full = join(dir, String(entry.name))
      if (entry.isFile() && entry.name === fileName) {
        addCandidate(full)
      } else if (entry.isDirectory() && depth < searchDepth) {
        visit(full, depth + 1)
      }
    }
  }
  visit(rootDir, 0)
  return Array.from(candidates.values()).sort((left, right) => right.mtimeMs - left.mtimeMs)
}

export function selectRunStateCandidate(params: {
  rootDir?: string | null
  explicitRunStatePath?: string | null
  trustExplicitRunStatePath?: boolean
  expectedTaskId?: string | null
  expectedChildRunId?: string | null
  fileName?: string
  searchDepth?: number
}): RunStateSelection {
  const fileName = params.fileName || DEFAULT_RUN_STATE_FILENAME
  const expectedTaskId = nonEmptyString(params.expectedTaskId)
  const expectedChildRunId = nonEmptyString(params.expectedChildRunId)
  const explicitRunStatePath = nonEmptyString(params.explicitRunStatePath)
  if (explicitRunStatePath && existsSync(explicitRunStatePath) && statFile(explicitRunStatePath)?.isFile) {
    const explicitCandidate = readRunStateCandidate(explicitRunStatePath, fileName)
    if (params.trustExplicitRunStatePath || (!expectedTaskId && !expectedChildRunId)) {
      const resolved = explicitCandidate
        ? resolveActiveCandidate(explicitCandidate, fileName, expectedTaskId, expectedChildRunId)
        : null
      return {
        path: resolved?.path || explicitRunStatePath,
        ambiguous: false,
        candidates: resolved && explicitCandidate ? dedupeCandidatesByPath([explicitCandidate, resolved]) : [],
      }
    }
    if (
      explicitCandidate
      && (!expectedTaskId || !explicitCandidate.taskId || explicitCandidate.taskId === expectedTaskId)
      && followsExpectedChildRun(explicitCandidate, expectedChildRunId)
    ) {
      const resolved = resolveActiveCandidate(explicitCandidate, fileName, expectedTaskId, expectedChildRunId)
      return { path: resolved.path, ambiguous: false, candidates: dedupeCandidatesByPath([explicitCandidate, resolved]) }
    }
  }

  const rootDir = nonEmptyString(params.rootDir)
  if (!rootDir) return { path: null, ambiguous: false, candidates: [] }
  const candidates = dedupeCandidatesByPath(collectRunStateCandidates({
    rootDir,
    fileName,
    searchDepth: params.searchDepth,
  }).map((candidate) => resolveActiveCandidate(candidate, fileName, expectedTaskId, expectedChildRunId)))
  if (candidates.length === 0) return { path: null, ambiguous: false, candidates }

  if (expectedChildRunId) {
    const matches = candidates.filter((candidate) => candidate.childRunId === expectedChildRunId)
    if (matches.length > 0) return { path: matches[0].path, ambiguous: false, candidates }
    return { path: null, ambiguous: candidates.length > 1, candidates }
  }

  if (expectedTaskId) {
    const matches = candidates.filter((candidate) => candidate.taskId === expectedTaskId)
    if (matches.length > 0) return { path: matches[0].path, ambiguous: false, candidates }
    return { path: null, ambiguous: candidates.length > 1, candidates }
  }

  if (candidates.length === 1) return { path: candidates[0].path, ambiguous: false, candidates }
  return { path: null, ambiguous: true, candidates }
}
