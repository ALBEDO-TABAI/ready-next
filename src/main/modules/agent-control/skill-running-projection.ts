import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const RUN_STATE_FILENAME = 'run_state.json'
const SEARCH_DEPTH_LIMIT = 1
const MAX_ARTIFACTS = 6

interface RunStateSummary {
  currentStage: string | null
  currentStep: string | null
  totalScenes: string | null
  completedScenes: string | null
  coverageRatio: string | null
  completedSteps: string | null
  waitingFor: string | null
  lastError: string | null
  status: string | null
  updatedAt: string | null
}

interface ArtifactRef {
  id: string
  module: string
  kind: string
  label: string
  path?: string | null
  createdAt: string
  meta?: Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stringifyStateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const values = value.map((item) => stringifyStateValue(item)).filter(Boolean)
    return values.length > 0 ? values.join(', ') : null
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractRunStateSummary(parsed: unknown): RunStateSummary {
  if (!parsed || typeof parsed !== 'object') {
    return {
      currentStage: null,
      currentStep: null,
      totalScenes: null,
      completedScenes: null,
      coverageRatio: null,
      completedSteps: null,
      waitingFor: null,
      lastError: null,
      status: null,
      updatedAt: null,
    }
  }
  const rec = parsed as Record<string, unknown>
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      if (key in rec) return stringifyStateValue(rec[key])
    }
    return null
  }
  return {
    currentStage: pick('current_stage', 'currentStage'),
    currentStep: pick('current_step', 'currentStep', 'step'),
    totalScenes: pick('total_scenes', 'totalScenes'),
    completedScenes: pick('completed_scenes', 'completedScenes'),
    coverageRatio: pick('coverage_ratio', 'coverageRatio'),
    completedSteps: pick('completed_steps', 'completedSteps'),
    waitingFor: pick('waiting_for', 'waitingFor', 'pending', 'pendingHandoff'),
    lastError: pick('last_error', 'lastError', 'error'),
    status: pick('status'),
    updatedAt: pick('updated_at', 'updatedAt', 'lastUpdated'),
  }
}

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function findRunStateFile(rootDir: string): string | null {
  const direct = join(rootDir, RUN_STATE_FILENAME)
  const directStat = safeStat(direct)
  if (directStat?.isFile()) return direct
  const rootStat = safeStat(rootDir)
  if (!rootStat?.isDirectory()) return null

  let bestPath: string | null = null
  let bestMtime = -1
  const visit = (dir: string, depth: number): void => {
    if (depth > SEARCH_DEPTH_LIMIT) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, String(entry.name))
      if (entry.isFile() && entry.name === RUN_STATE_FILENAME) {
        const stat = safeStat(full)
        if (stat && stat.mtimeMs > bestMtime) {
          bestPath = full
          bestMtime = stat.mtimeMs
        }
      } else if (entry.isDirectory() && depth < SEARCH_DEPTH_LIMIT) {
        visit(full, depth + 1)
      }
    }
  }
  visit(rootDir, 0)
  return bestPath
}

function readRunState(path: string | null): RunStateSummary | null {
  if (!path) return null
  try {
    return extractRunStateSummary(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

function collectProbeDirs(toolInput?: Record<string, unknown>): string[] {
  const dirs: string[] = []
  const pushDir = (value: string | null): void => {
    if (!value || dirs.includes(value)) return
    dirs.push(value)
  }
  pushDir(asNonEmptyString(toolInput?.outputDir))
  pushDir(asNonEmptyString(toolInput?.output_dir))
  const sceneScoresPath = asNonEmptyString(toolInput?.sceneScoresPath) || asNonEmptyString(toolInput?.scene_scores_path)
  if (sceneScoresPath) pushDir(dirname(sceneScoresPath))
  return dirs
}

function isInterestingArtifactName(name: string): boolean {
  if (name === RUN_STATE_FILENAME) return true
  if (name === 'scene_scores.json') return true
  if (name === 'auto_scoring_validation.json') return true
  if (name === 'selected_clips.json') return true
  if (/report|analysis|storyboard|summary|delivery/i.test(name) && /\.(md|json|txt|csv)$/i.test(name)) {
    return true
  }
  return false
}

function artifactKind(name: string): string {
  if (name === RUN_STATE_FILENAME) return 'run_state'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.txt')) return 'text'
  if (name.endsWith('.csv')) return 'table'
  return 'artifact'
}

function collectArtifacts(params: {
  probeDirs: string[]
  runStatePath: string | null
  createdAt: string
  toolName: string
}): ArtifactRef[] {
  const paths = new Map<string, number>()
  const addPath = (path: string): void => {
    const stat = safeStat(path)
    if (!stat?.isFile()) return
    paths.set(path, stat.mtimeMs)
  }
  if (params.runStatePath) addPath(params.runStatePath)

  const visit = (dir: string, depth: number): void => {
    if (depth > SEARCH_DEPTH_LIMIT) return
    const stat = safeStat(dir)
    if (!stat?.isDirectory()) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const name = String(entry.name)
      const full = join(dir, name)
      if (entry.isFile() && isInterestingArtifactName(name)) {
        addPath(full)
      } else if (entry.isDirectory() && depth < SEARCH_DEPTH_LIMIT) {
        visit(full, depth + 1)
      }
    }
  }

  for (const dir of params.probeDirs) visit(dir, 0)
  return Array.from(paths.entries())
    .sort((left, right) => {
      if (left[0] === params.runStatePath) return -1
      if (right[0] === params.runStatePath) return 1
      return right[1] - left[1]
    })
    .slice(0, MAX_ARTIFACTS)
    .map(([path]) => {
      const label = basename(path)
      return {
        id: `${params.toolName}:${label}:${path}`,
        module: 'skill',
        kind: artifactKind(label),
        label,
        path,
        createdAt: params.createdAt,
        meta: {
          toolName: params.toolName,
          liveHeartbeat: true,
        },
      }
    })
}

export function formatElapsedDuration(ms: number): string {
  const safeMs = Math.max(0, ms)
  const totalSeconds = Math.floor(safeMs / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`
}

export function buildLongSkillRunningProjection(params: {
  sessionId?: string
  toolName: string
  toolInput?: Record<string, unknown>
  startedAt: number
  now: number
}): Record<string, unknown> {
  const elapsed = formatElapsedDuration(params.now - params.startedAt)
  const updatedAt = new Date(params.now).toISOString()
  const probeDirs = collectProbeDirs(params.toolInput)
  const runStatePath = probeDirs.map(findRunStateFile).find(Boolean) || null
  const runState = readRunState(runStatePath)
  const progressText = runState?.totalScenes && runState?.completedScenes
    ? `${runState.completedScenes}/${runState.totalScenes}`
    : runState?.coverageRatio
      ? `${Math.round(Number(runState.coverageRatio) * 100)}%`
      : null
  const stageText = runState?.currentStage || runState?.currentStep || null
  const artifacts = collectArtifacts({
    probeDirs: runStatePath ? [dirname(runStatePath), ...probeDirs] : probeDirs,
    runStatePath,
    createdAt: updatedAt,
    toolName: params.toolName,
  })

  const confirmations = [
    stageText ? `阶段：${stageText}` : null,
    progressText ? `进度：${progressText}` : null,
    !stageText && runState?.status ? `状态：${runState.status}` : null,
    runState?.waitingFor ? `等待：${runState.waitingFor}` : null,
    artifacts.length > 0 ? `已发现 ${artifacts.length} 个中间文件` : null,
  ].filter(Boolean)
  const detail = `正在执行技能工具，已运行 ${elapsed}${confirmations.length > 0 ? `；${confirmations.join('；')}` : ''}`
  const stepDetail = runState?.lastError
    ? `${detail}；最近错误：${runState.lastError}`
    : detail
  const projection: Record<string, unknown> = {
    module: 'skill',
    taskId: `skill:${params.sessionId || '__global_skill_session__'}:${params.toolName}`,
    taskTitle: '技能执行',
    taskSummary: detail,
    steps: [{
      id: params.toolName,
      title: stageText ? `执行：${stageText}` : '执行技能工具',
      status: 'running',
      detail: stepDetail,
      updatedAt,
    }],
    currentStepId: params.toolName,
    waitingFor: 'background',
    resumableActions: artifacts.length > 0 ? ['open_artifact'] : ['none'],
    blockedReason: null,
    taskContinuation: null,
  }
  if (artifacts.length > 0) {
    projection.recentArtifacts = artifacts
  }
  return projection
}
