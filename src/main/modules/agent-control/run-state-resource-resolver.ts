import { existsSync, statSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { RequestEnvelopeResource, RequestEnvelopeResourceRef } from './request-envelope'

const RUN_STATE_FILE = 'run_state.json'
const MAX_RUN_STATE_BYTES = 64 * 1024
const VEA_SKILL_ID = 'video-expert-analyzer'
const VEA_SKILL_NAME = 'Video Expert Analyzer (VNext)'
const VEA_AI_ANALYZE_ACTION = 'video_expert_ai_analyze'
const POST_SCORE_STAGES = new Set(['score_batches', 'merge_validate', 'finalize'])

export interface ExplicitRunStateResourceCandidate {
  skillId: string
  skillName: string
  outputDir: string
  runStatePath: string
  sceneScoresPath: string | null
  currentStage: string | null
  status: string | null
  explicitAction: string | null
}

export type ExplicitRunStateResourceResolution =
  | { status: 'none'; reason?: string }
  | { status: 'resolved'; candidate: ExplicitRunStateResourceCandidate }
  | { status: 'invalid'; reason: string; path?: string }
  | { status: 'ambiguous'; reason: string; candidateCount: number; paths: string[] }

function isTrustedRunStateFileResource(resource: RequestEnvelopeResource): boolean {
  if (!resource.canRead || typeof resource.path !== 'string' || !resource.path.trim()) return false
  if (basename(resource.path.trim()) !== RUN_STATE_FILE) return false
  return resource.source === 'user_attachment'
    || resource.source === 'explicit_reference'
    || resource.source === 'current_document'
    || resource.source === 'document_quote'
    || resource.kind === 'attachment'
    || resource.kind === 'document_context'
    || resource.kind === 'document_quote'
}

function isRunStatePathRef(ref: RequestEnvelopeResourceRef): boolean {
  if (ref.kind !== 'path') return false
  const value = ref.value.trim()
  return Boolean(value) && basename(value) === RUN_STATE_FILE
}

function pickString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

type ParseRunStateResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

function parseRunState(path: string): ParseRunStateResult {
  if (!isAbsolute(path)) return { ok: false, error: 'run_state path must be absolute' }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ok: false, error: 'run_state file is not readable' }
  }
  if (!stat.isFile()) return { ok: false, error: 'run_state path is not a file' }
  if (stat.size > MAX_RUN_STATE_BYTES) return { ok: false, error: 'run_state file is too large' }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, error: 'run_state file is not readable' }
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'run_state JSON must be an object' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, error: 'run_state parse failed' }
  }
}

function looksLikeVeaRunState(rec: Record<string, unknown>): boolean {
  const hasVeaKey = [
    'video_dir',
    'active_output_dir',
    'scores_path',
    'scene_scores_path',
    'sceneScoresPath',
    'next_batch',
    'total_scenes',
    'completed_scenes',
    'coverage_ratio',
    'can_finalize',
  ].some((key) => Object.prototype.hasOwnProperty.call(rec, key))
  if (hasVeaKey) return true
  return rec.version === 'vnext' && (
    Object.prototype.hasOwnProperty.call(rec, 'current_stage')
    || Object.prototype.hasOwnProperty.call(rec, 'currentStage')
  )
}

function resolveExistingSceneScoresPath(outputDir: string, rec: Record<string, unknown>): string | null {
  const rawPath = pickString(rec, ['scene_scores_path', 'sceneScoresPath', 'scores_path'])
  const candidates: string[] = []
  if (rawPath) candidates.push(isAbsolute(rawPath) ? rawPath : join(outputDir, rawPath))
  candidates.push(join(outputDir, 'scene_scores.json'))

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function buildVeaCandidate(runStatePath: string, rec: Record<string, unknown>): ExplicitRunStateResourceCandidate | null {
  if (!looksLikeVeaRunState(rec)) return null
  const outputDir = dirname(runStatePath)
  const currentStage = pickString(rec, ['current_stage', 'currentStage', 'current_step', 'currentStep'])
  const status = pickString(rec, ['status'])?.toLowerCase() || null
  const sceneScoresPath = resolveExistingSceneScoresPath(outputDir, rec)
  const explicitAction = currentStage && POST_SCORE_STAGES.has(currentStage) && sceneScoresPath
    ? VEA_AI_ANALYZE_ACTION
    : null

  return {
    skillId: VEA_SKILL_ID,
    skillName: VEA_SKILL_NAME,
    outputDir,
    runStatePath,
    sceneScoresPath,
    currentStage,
    status,
    explicitAction,
  }
}

export function resolveExplicitRunStateResource(
  resources: ReadonlyArray<RequestEnvelopeResource>,
  referencedResources: ReadonlyArray<RequestEnvelopeResourceRef> = [],
): ExplicitRunStateResourceResolution {
  const paths = Array.from(new Set(
    [
      ...resources
        .filter(isTrustedRunStateFileResource)
        .map((resource) => resource.path?.trim())
        .filter((path): path is string => Boolean(path)),
      ...referencedResources
        .filter(isRunStatePathRef)
        .map((ref) => ref.value.trim()),
    ],
  ))

  if (paths.length === 0) return { status: 'none' }
  if (paths.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'multiple explicit run_state resources',
      candidateCount: paths.length,
      paths,
    }
  }

  const path = paths[0]
  const parsed = parseRunState(path)
  if (!parsed.ok) return { status: 'invalid', reason: parsed.error, path }

  const candidate = buildVeaCandidate(path, parsed.value)
  if (!candidate) return { status: 'invalid', reason: 'unrecognized run_state shape', path }

  return { status: 'resolved', candidate }
}
