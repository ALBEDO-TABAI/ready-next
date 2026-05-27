import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { SkillRunContract } from '../contracts/run-contracts'
import type { TurnFrame } from '../runtime-core/turn-frame'

const VEA_SKILL_ID = 'video-expert-analyzer'
const VEA_AI_ANALYZE_ACTION = 'video_expert_ai_analyze'
const SCENE_SCORES_FILE = 'scene_scores.json'

export type CanonicalChildRunHandleFailureReason =
  | 'missing_continuation_handle'
  | 'path_outside_allowed_roots'

export type CanonicalChildRunHandleResolution =
  | {
    ok: true
    input: Record<string, unknown>
    outputDir: string | null
    runStatePath: string | null
    sceneScoresPath: string | null
  }
  | {
    ok: false
    reason: CanonicalChildRunHandleFailureReason
    input: Record<string, unknown>
  }

export interface ResolveCanonicalChildRunHandleParams {
  skillId: string | null | undefined
  action: string | null | undefined
  requestedInput: Record<string, unknown>
  contract?: SkillRunContract | null
  frame?: TurnFrame | null
  runtimeOutputsRoot?: string | null
  durableHandles?: {
    outputDir?: string | null
    runStatePath?: string | null
    sceneScoresPath?: string | null
  } | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function isResumeOnlySkillAction(skillId: string | null | undefined, action: string | null | undefined): boolean {
  return nonEmpty(skillId) === VEA_SKILL_ID && nonEmpty(action) === VEA_AI_ANALYZE_ACTION
}

function safeCanonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  const ancestor = deepestExistingAncestor(absolute)
  if (!ancestor) return absolute
  try {
    const realAncestor = realpathSync.native(ancestor)
    const tail = relative(ancestor, absolute)
    return tail ? resolve(realAncestor, tail) : realAncestor
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return absolute
    throw error
  }
}

function deepestExistingAncestor(absPath: string): string | null {
  let current = absPath
  for (let index = 0; index < 64; index += 1) {
    try {
      realpathSync.native(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

function isWithinRoot(absPath: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep
  return absPath === root || absPath.startsWith(normalizedRoot)
}

function pushRoot(roots: string[], candidate: string | null | undefined): void {
  const value = nonEmpty(candidate)
  if (!value || !isAbsolute(value)) return
  const real = safeCanonicalPath(value)
  if (!roots.includes(real)) roots.push(real)
}

function userGrantedRoots(): string[] {
  const home = homedir()
  return [
    join(home, 'Documents'),
    join(home, 'Desktop'),
    join(home, 'Downloads'),
    join(home, 'Movies'),
    tmpdir(),
    '/tmp',
    '/private/tmp',
  ].map((root) => safeCanonicalPath(root))
}

function isBlockedSystemPath(absPath: string): boolean {
  const blockedRoots = [
    '/bin',
    '/sbin',
    '/etc',
    '/System',
    '/usr/bin',
    '/usr/sbin',
  ]
  return blockedRoots.some((root) => isWithinRoot(absPath, root))
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function buildAllowedRoots(params: ResolveCanonicalChildRunHandleParams, durableOutputDir: string | null): string[] {
  const roots: string[] = []
  pushRoot(roots, durableOutputDir)
  pushRoot(roots, params.runtimeOutputsRoot)
  for (const root of params.contract?.artifactRoots || []) pushRoot(roots, root)
  for (const root of params.frame?.activeArtifactRoots || []) pushRoot(roots, root)
  pushRoot(roots, params.durableHandles?.outputDir)
  pushRoot(roots, params.durableHandles?.runStatePath ? dirname(params.durableHandles.runStatePath) : null)
  pushRoot(roots, params.contract?.runStatePath ? dirname(params.contract.runStatePath) : null)
  pushRoot(roots, params.frame?.skill?.runStatePath ? dirname(params.frame.skill.runStatePath) : null)
  for (const root of userGrantedRoots()) pushRoot(roots, root)
  return roots
}

function isAllowedPath(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false
  const real = safeCanonicalPath(path)
  if (isBlockedSystemPath(real)) return false
  return roots.some((root) => isWithinRoot(real, root))
}

function resolveSceneScoresPath(input: Record<string, unknown>, contract?: SkillRunContract | null, frame?: TurnFrame | null): string | null {
  return nonEmpty(input.sceneScoresPath)
    || nonEmpty(contract?.artifactPaths?.sceneScoresPath)
    || nonEmpty(frame?.skill?.artifactPaths?.sceneScoresPath)
}

function resolveDurableSceneScoresPath(params: ResolveCanonicalChildRunHandleParams): string | null {
  return nonEmpty(params.durableHandles?.sceneScoresPath)
    || resolveSceneScoresPath(params.requestedInput, params.contract, params.frame)
}

function resolveDurableOutputDir(params: ResolveCanonicalChildRunHandleParams): string | null {
  return nonEmpty(params.durableHandles?.outputDir)
    || nonEmpty(params.contract?.outputDir)
    || nonEmpty(params.frame?.skill?.outputDir)
}

function resolveRunStatePath(input: Record<string, unknown>, outputDir: string | null, params: ResolveCanonicalChildRunHandleParams): string | null {
  return nonEmpty(input.runStatePath)
    || nonEmpty(params.durableHandles?.runStatePath)
    || nonEmpty(params.contract?.runStatePath)
    || nonEmpty(params.frame?.skill?.runStatePath)
    || (outputDir ? join(outputDir, 'run_state.json') : null)
}

export function resolveCanonicalChildRunHandle(
  params: ResolveCanonicalChildRunHandleParams,
): CanonicalChildRunHandleResolution {
  const input = { ...params.requestedInput }
  const action = nonEmpty(params.action)
  if (!isResumeOnlySkillAction(params.skillId, action)) {
    return {
      ok: true,
      input,
      outputDir: nonEmpty(input.outputDir),
      runStatePath: nonEmpty(input.runStatePath),
      sceneScoresPath: nonEmpty(input.sceneScoresPath),
    }
  }

  const sceneScoresPath = resolveDurableSceneScoresPath(params)
  if (!sceneScoresPath || !isAbsolute(sceneScoresPath)) {
    return { ok: false, reason: 'missing_continuation_handle', input }
  }

  const durableOutputDir = resolveDurableOutputDir(params)
  const requestedOutputDir = nonEmpty(input.outputDir)
  const allowedRoots = buildAllowedRoots(params, durableOutputDir)
  let outputDir = requestedOutputDir || durableOutputDir

  if (outputDir) {
    if (!isAllowedPath(outputDir, allowedRoots) || !isAllowedPath(sceneScoresPath, allowedRoots)) {
      return { ok: false, reason: 'path_outside_allowed_roots', input }
    }
  } else {
    if (!fileExists(sceneScoresPath) || !isAllowedPath(sceneScoresPath, allowedRoots)) {
      return { ok: false, reason: 'missing_continuation_handle', input }
    }
    outputDir = dirname(resolve(sceneScoresPath))
  }

  const canonicalOutputDir = outputDir ? resolve(outputDir) : null
  const canonicalSceneScoresPath = resolve(sceneScoresPath)
  const runStatePath = resolveRunStatePath(input, canonicalOutputDir, params)

  return {
    ok: true,
    input: {
      ...input,
      sceneScoresPath: canonicalSceneScoresPath,
      outputDir: canonicalOutputDir,
    },
    outputDir: canonicalOutputDir,
    runStatePath: runStatePath ? resolve(runStatePath) : null,
    sceneScoresPath: canonicalSceneScoresPath,
  }
}
