import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_RUN_STATE_FILENAME = 'run_state.json'
const DEFAULT_SEARCH_DEPTH = 1

export interface RunStateCandidate {
  path: string
  mtimeMs: number
  taskId: string | null
  status: string | null
  currentStage: string | null
}
export interface RunStateSelection {
  path: string | null
  ambiguous: boolean
  candidates: RunStateCandidate[]
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
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
    status: nonEmptyString(rec.status),
    currentStage: nonEmptyString(rec.current_stage)
      || nonEmptyString(rec.currentStage)
      || nonEmptyString(rec.current_step)
      || nonEmptyString(rec.currentStep),
  }
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
    } catch {
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
  expectedTaskId?: string | null
  fileName?: string
  searchDepth?: number
}): RunStateSelection {
  const fileName = params.fileName || DEFAULT_RUN_STATE_FILENAME
  const expectedTaskId = nonEmptyString(params.expectedTaskId)
  const explicitRunStatePath = nonEmptyString(params.explicitRunStatePath)
  if (explicitRunStatePath && existsSync(explicitRunStatePath) && statFile(explicitRunStatePath)?.isFile) {
    return { path: explicitRunStatePath, ambiguous: false, candidates: [] }
  }

  const rootDir = nonEmptyString(params.rootDir)
  if (!rootDir) return { path: null, ambiguous: false, candidates: [] }
  const candidates = collectRunStateCandidates({
    rootDir,
    fileName,
    searchDepth: params.searchDepth,
  })
  if (candidates.length === 0) return { path: null, ambiguous: false, candidates }

  if (expectedTaskId) {
    const matches = candidates.filter((candidate) => candidate.taskId === expectedTaskId)
    if (matches.length > 0) return { path: matches[0].path, ambiguous: false, candidates }
    const legacyUnidentified = candidates.filter((candidate) => !candidate.taskId)
    if (candidates.length === 1 && legacyUnidentified.length === 1) {
      return { path: candidates[0].path, ambiguous: false, candidates }
    }
    return { path: null, ambiguous: candidates.length > 1, candidates }
  }

  if (candidates.length === 1) return { path: candidates[0].path, ambiguous: false, candidates }
  return { path: null, ambiguous: true, candidates }
}
