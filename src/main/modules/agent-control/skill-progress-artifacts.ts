import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

export interface SkillProgressArtifacts {
  sceneScoresPath: string | null
  hostBatchesIndexPath: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
  hostBatches: SkillHostBatchProgress | null
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
  completedSceneNumbers: Set<number>
  totalScenes: number | null
  indexPath: string | null
} {
  const hostDir = outputDir ? join(outputDir, 'host_batches') : null
  const indexPath = hostDir ? join(hostDir, 'index.json') : null
  if (!indexPath || !existsSync(indexPath)) {
    return { progress: null, completedSceneNumbers: new Set(), totalScenes: null, indexPath: null }
  }

  const indexPayload = readJson(indexPath)
  const batches = Array.isArray(indexPayload?.batches) ? indexPayload.batches : []
  const statusCounts: Record<string, number> = {}
  const receiptStatusCounts: Record<string, number> = {}
  const completedSceneNumbers = new Set<number>()
  let completedBatches = 0

  for (const batch of batches) {
    if (!batch || typeof batch !== 'object') continue
    const rec = batch as Record<string, unknown>
    const outputName = nonEmpty(rec.output)
    const outputPath = outputName && hostDir ? join(hostDir, outputName) : null
    const outputPayload = outputPath && existsSync(outputPath) ? readJson(outputPath) : null
    const receipt = outputPayload?.receipt && typeof outputPayload.receipt === 'object'
      ? outputPayload.receipt as Record<string, unknown>
      : {}
    const receiptStatus = nonEmpty(receipt.status) || 'pending'
    increment(receiptStatusCounts, receiptStatus)
    const receiptBlocked = Array.isArray(receipt.needs_review) && receipt.needs_review.length > 0
    const scenes = Array.isArray(outputPayload?.scenes) ? outputPayload.scenes : []
    const derivedStatus = deriveBatchStatus({ receiptStatus, receiptBlocked, scenes })
    increment(statusCounts, derivedStatus)
    if (derivedStatus !== 'completed') continue
    completedBatches += 1
    for (const scene of scenes) {
      const sceneNumber = numberValue((scene as Record<string, unknown>)?.scene_number)
      if (sceneNumber !== null) completedSceneNumbers.add(sceneNumber)
    }
  }

  return {
    progress: {
      totalBatches: batches.length,
      completedBatches,
      statusCounts,
      receiptStatusCounts,
    },
    completedSceneNumbers,
    totalScenes: numberValue(indexPayload?.total_scenes ?? indexPayload?.totalScenes),
    indexPath,
  }
}

export function inspectSkillProgressArtifacts(params: InspectSkillProgressArtifactsParams): SkillProgressArtifacts {
  const outputDir = outputDirFromParams(params)
  const sceneScoresPath = sceneScoresPathFor(params)
  const sceneProgress = collectSceneProgress(sceneScoresPath)
  const hostBatchProgress = collectHostBatchProgress(outputDir)
  const completedSceneNumbers = new Set([
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
    hasEvidence: Boolean(sceneScoresPath || hostBatchProgress.indexPath),
  }
}
