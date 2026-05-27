import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ScopeRunSkillHandoff } from '../contracts/types'
import { readSkillHandoffStates } from './skill-agent-handoff'

const REQUIRED_SCORE_KEYS = [
  'aesthetic_beauty',
  'credibility',
  'impact',
  'memorability',
  'fun_interest',
] as const

const REQUIRED_STORYBOARD_FIELDS = [
  'shot_size',
  'lighting',
  'camera_movement',
  'visual_style',
  'technique',
] as const

export interface SkillHostBatchProgress {
  totalBatches: number
  completedBatches: number
  statusCounts: Record<string, number>
  receiptStatusCounts: Record<string, number>
}

export interface SkillActivityProgress {
  completedUnits: number
  totalUnits: number
  unitLabel: string
  summary: string
  updatedAt: string
  fingerprint: string
  estimatedCompletedScenes?: number
  totalScenes?: number
}

export interface SkillProgressArtifacts {
  sceneScoresPath: string | null
  hostBatchesIndexPath: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
  hostBatches: SkillHostBatchProgress | null
  activity: SkillActivityProgress | null
  handoff: ScopeRunSkillHandoff | null
  handoffDetail: string | null
  hasEvidence: boolean
}

export interface InspectSkillProgressArtifactsParams {
  outputDir?: string | null
  sceneScoresPath?: string | null
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

const HANDOFF_TASK_LABELS: Record<string, string> = {
  body: '正文',
  diagram: '图表',
  illustrate: '插图说明',
  overview: '总览',
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function summarizeCompletedHandoffs(states: ScopeRunSkillHandoff[]): string | null {
  const labels = uniqueStrings(states
    .filter((state) => state.status === 'completed')
    .map((state) => HANDOFF_TASK_LABELS[state.taskName] || state.taskName)
    .filter((label) => label.trim().length > 0))
  if (labels.length === 0) return null
  return `视听报告分段内容已生成（${labels.join('、')}）`
}

function inspectHandoffProgress(outputDir: string | null): {
  current: ScopeRunSkillHandoff | null
  detail: string | null
} {
  if (!outputDir) return { current: null, detail: null }
  const states = readSkillHandoffStates(outputDir)
  return {
    current: states.find((state) => state.status !== 'completed') || null,
    detail: summarizeCompletedHandoffs(states),
  }
}

function fileExists(path: string | null): path is string {
  if (!path) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function outputDirFromParams(params: InspectSkillProgressArtifactsParams): string | null {
  return nonEmpty(params.outputDir)
    || (nonEmpty(params.sceneScoresPath) ? dirname(nonEmpty(params.sceneScoresPath) as string) : null)
}

function sceneScoresPathFor(params: InspectSkillProgressArtifactsParams): string | null {
  const explicit = nonEmpty(params.sceneScoresPath)
  if (fileExists(explicit)) return explicit
  const outputDir = outputDirFromParams(params)
  const candidate = outputDir ? join(outputDir, 'scene_scores.json') : null
  return fileExists(candidate) ? candidate : null
}

function stringComplete(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 && !text.startsWith('TODO')
}

function scoreComplete(scores: unknown): boolean {
  if (!scores || typeof scores !== 'object') return false
  const rec = scores as Record<string, unknown>
  return REQUIRED_SCORE_KEYS.every((key) => {
    const n = numberValue(rec[key])
    return n !== null && n > 0
  })
}

function storyboardComplete(storyboard: unknown): boolean {
  if (!storyboard || typeof storyboard !== 'object') return false
  const rec = storyboard as Record<string, unknown>
  return REQUIRED_STORYBOARD_FIELDS.every((key) => stringComplete(rec[key]))
}

export function isVeaSceneComplete(scene: unknown): boolean {
  if (!scene || typeof scene !== 'object') return false
  const rec = scene as Record<string, unknown>
  return scoreComplete(rec.scores)
    && stringComplete(rec.type_classification)
    && stringComplete(rec.description)
    && stringComplete(rec.selection_reasoning)
    && stringComplete(rec.edit_suggestion)
    && storyboardComplete(rec.storyboard)
    && (numberValue(rec.weighted_score) || 0) > 0
    && String(rec.selection || '').trim().startsWith('[')
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1
}

function fileStamp(path: string | null): { mtimeMs: number, size: number } | null {
  if (!path) return null
  try {
    const stat = statSync(path)
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
  } catch {
    return null
  }
}

function collectSceneProgress(sceneScoresPath: string | null): {
  totalScenes: number | null
  completedScenes: number | null
  completedSceneNumbers: Set<number>
} {
  if (!sceneScoresPath) {
    return { totalScenes: null, completedScenes: null, completedSceneNumbers: new Set() }
  }
  const payload = readJson(sceneScoresPath)
  const scenes = Array.isArray(payload?.scenes) ? payload.scenes : []
  const totalScenes = scenes.length > 0
    ? scenes.length
    : numberValue(payload?.total_scenes ?? payload?.totalScenes)
  const completedSceneNumbers = new Set<number>()
  for (const scene of scenes) {
    if (!isVeaSceneComplete(scene)) continue
    const sceneNumber = numberValue((scene as Record<string, unknown>).scene_number)
    if (sceneNumber !== null) completedSceneNumbers.add(sceneNumber)
  }
  return {
    totalScenes,
    completedScenes: scenes.length > 0 ? completedSceneNumbers.size : null,
    completedSceneNumbers,
  }
}

function deriveBatchStatus(params: {
  receiptStatus: string
  receiptBlocked: boolean
  scenes: unknown[]
}): string {
  if (params.receiptBlocked || params.receiptStatus === 'blocked') return 'blocked'
  if (params.receiptStatus === 'in_progress') return 'in_progress'
  if (params.receiptStatus !== 'completed') return 'pending'
  if (params.scenes.length === 0) return 'pending'
  return params.scenes.every(isVeaSceneComplete) ? 'completed' : 'pending'
}

function collectHostBatchProgress(outputDir: string | null): {
  progress: SkillHostBatchProgress | null
  activity: SkillActivityProgress | null
  completedSceneNumbers: Set<number>
  totalScenes: number | null
  indexPath: string | null
} {
  const hostDir = outputDir ? join(outputDir, 'host_batches') : null
  const indexPath = hostDir ? join(hostDir, 'index.json') : null
  if (!indexPath || !existsSync(indexPath)) {
    return { progress: null, activity: null, completedSceneNumbers: new Set(), totalScenes: null, indexPath: null }
  }

  const indexPayload = readJson(indexPath)
  const batches = Array.isArray(indexPayload?.batches) ? indexPayload.batches : []
  const statusCounts: Record<string, number> = {}
  const receiptStatusCounts: Record<string, number> = {}
  const completedSceneNumbers = new Set<number>()
  const observedCompleteSceneNumbers = new Set<number>()
  const fingerprintInput: unknown[] = []
  const indexStamp = fileStamp(indexPath)
  let latestMtimeMs = indexStamp?.mtimeMs || 0
  let activityCompletedUnits = 0
  let estimatedCompletedScenes = 0
  let completedBatches = 0
  const totalScenes = numberValue(indexPayload?.total_scenes ?? indexPayload?.totalScenes)

  for (const batch of batches) {
    if (!batch || typeof batch !== 'object') continue
    const rec = batch as Record<string, unknown>
    const outputName = nonEmpty(rec.output)
    const outputPath = outputName && hostDir ? join(hostDir, outputName) : null
    const outputPayload = outputPath && existsSync(outputPath) ? readJson(outputPath) : null
    const outputStamp = fileStamp(outputPath)
    if (outputStamp) latestMtimeMs = Math.max(latestMtimeMs, outputStamp.mtimeMs)
    const receipt = outputPayload?.receipt && typeof outputPayload.receipt === 'object'
      ? outputPayload.receipt as Record<string, unknown>
      : {}
    const receiptStatus = nonEmpty(receipt.status) || 'pending'
    increment(receiptStatusCounts, receiptStatus)
    if (receiptStatus === 'completed') {
      activityCompletedUnits += 1
      estimatedCompletedScenes += Array.isArray(rec.scene_numbers) ? rec.scene_numbers.length : 0
    }
    const receiptBlocked = Array.isArray(receipt.needs_review) && receipt.needs_review.length > 0
    const scenes = Array.isArray(outputPayload?.scenes) ? outputPayload.scenes : []
    for (const scene of scenes) {
      if (!isVeaSceneComplete(scene)) continue
      const sceneNumber = numberValue((scene as Record<string, unknown>)?.scene_number)
      if (sceneNumber !== null) observedCompleteSceneNumbers.add(sceneNumber)
    }
    const derivedStatus = deriveBatchStatus({ receiptStatus, receiptBlocked, scenes })
    increment(statusCounts, derivedStatus)
    fingerprintInput.push({
      batchId: rec.batch_id,
      output: outputName,
      receiptStatus,
      derivedStatus,
      sceneNumbers: rec.scene_numbers,
      outputMtimeMs: outputStamp?.mtimeMs ?? null,
      outputSize: outputStamp?.size ?? null,
    })
    if (derivedStatus !== 'completed') continue
    completedBatches += 1
    for (const scene of scenes) {
      const sceneNumber = numberValue((scene as Record<string, unknown>)?.scene_number)
      if (sceneNumber !== null) completedSceneNumbers.add(sceneNumber)
    }
  }

  const inProgressUnits = receiptStatusCounts.in_progress || 0
  const hasSceneActivity = totalScenes !== null && observedCompleteSceneNumbers.size > 0
  const summaryParts = hasSceneActivity
    ? [`评分场景 ${observedCompleteSceneNumbers.size}/${totalScenes}`]
    : [`${activityCompletedUnits}/${batches.length} batches completed`]
  if (!hasSceneActivity && inProgressUnits > 0) summaryParts.push(`${inProgressUnits} in progress`)
  const activity = batches.length > 0 && latestMtimeMs > 0
    ? {
        completedUnits: hasSceneActivity ? observedCompleteSceneNumbers.size : activityCompletedUnits,
        totalUnits: hasSceneActivity ? totalScenes : batches.length,
        unitLabel: hasSceneActivity ? 'scene' : 'batch',
        summary: summaryParts.join('; '),
        updatedAt: new Date(latestMtimeMs).toISOString(),
        fingerprint: createHash('sha256').update(JSON.stringify({
          indexMtimeMs: indexStamp?.mtimeMs ?? null,
          indexSize: indexStamp?.size ?? null,
          observedCompleteScenes: observedCompleteSceneNumbers.size,
          batches: fingerprintInput,
        })).digest('hex'),
        ...(!hasSceneActivity && estimatedCompletedScenes > 0 ? { estimatedCompletedScenes } : {}),
        ...(totalScenes !== null ? { totalScenes } : {}),
      }
    : null

  return {
    progress: {
      totalBatches: batches.length,
      completedBatches,
      statusCounts,
      receiptStatusCounts,
    },
    activity,
    completedSceneNumbers: observedCompleteSceneNumbers.size > 0
      ? observedCompleteSceneNumbers
      : completedSceneNumbers,
    totalScenes,
    indexPath,
  }
}

function intList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const numbers: number[] = []
  for (const item of value) {
    const number = Number(item)
    if (!Number.isInteger(number) || number <= 0 || numbers.includes(number)) continue
    numbers.push(number)
  }
  return numbers
}

function formatSceneLabels(sceneNumbers: number[], limit = 6): string {
  const labels = sceneNumbers.slice(0, limit).map((number) => `Scene ${String(number).padStart(3, '0')}`)
  return `${labels.join('、')}${sceneNumbers.length > limit ? '、...' : ''}`
}

function collectAutoScoringWarningSummary(outputDir: string | null): string | null {
  if (!outputDir) return null
  const payload = readJson(join(outputDir, 'auto_scoring_validation.json'))
  if (!payload) return null
  const warningSceneNumbers = intList(payload.validation_warning_scene_numbers || payload.needs_review_scene_numbers)
  const blockingSceneNumbers = intList(payload.blocking_scene_numbers)
  if (warningSceneNumbers.length === 0 || blockingSceneNumbers.length > 0) return null
  const failedSceneNumbers = intList(payload.validation_failed_scene_numbers)
  const details = failedSceneNumbers.length > 0
    ? `，含 ${failedSceneNumbers.length} 个图片探测失败`
    : ''
  return `抽样复核非阻断提醒 ${warningSceneNumbers.length} 个：${formatSceneLabels(warningSceneNumbers)}${details}`
}

export function inspectSkillProgressArtifacts(params: InspectSkillProgressArtifactsParams): SkillProgressArtifacts {
  const outputDir = outputDirFromParams(params)
  const sceneScoresPath = sceneScoresPathFor(params)
  const sceneProgress = collectSceneProgress(sceneScoresPath)
  const hostBatchProgress = collectHostBatchProgress(outputDir)
  const handoffProgress = inspectHandoffProgress(outputDir)
  const autoScoringWarningSummary = collectAutoScoringWarningSummary(outputDir)
  const completedSceneNumbers = new Set<number>([
    ...sceneProgress.completedSceneNumbers,
    ...hostBatchProgress.completedSceneNumbers,
  ])
  const totalScenes = sceneProgress.totalScenes ?? hostBatchProgress.totalScenes
  const completedScenes = totalScenes === null
    ? (completedSceneNumbers.size > 0 ? completedSceneNumbers.size : null)
    : completedSceneNumbers.size
  const coverageRatio = totalScenes && totalScenes > 0 && completedScenes !== null
    ? Math.round((completedScenes / totalScenes) * 10_000) / 10_000
    : completedScenes === 0 && totalScenes === 0
      ? 0
      : null

  return {
    sceneScoresPath,
    hostBatchesIndexPath: hostBatchProgress.indexPath,
    totalScenes,
    completedScenes,
    coverageRatio,
    hostBatches: hostBatchProgress.progress,
    activity: hostBatchProgress.activity && autoScoringWarningSummary
      ? {
          ...hostBatchProgress.activity,
          summary: `${hostBatchProgress.activity.summary}；${autoScoringWarningSummary}`,
        }
      : hostBatchProgress.activity,
    handoff: handoffProgress.current,
    handoffDetail: handoffProgress.detail,
    hasEvidence: Boolean(sceneScoresPath || hostBatchProgress.indexPath || handoffProgress.current || handoffProgress.detail),
  }
}
