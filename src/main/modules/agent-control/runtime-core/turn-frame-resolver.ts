import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import type { ReferenceSkillHint } from '../skills/skill-reference-hints'
import {
  loadSkillRunContract,
  type SkillRunContract,
  type TaskProjectionRecord,
} from '../contracts/run-contracts'
import { isDirectlyResumableTaskStatus, isPausedTaskStatus } from '../contracts/task-open-status'
import type { SkillTaskRunRecord } from '../../repositories/skill-task-run-repository'
import type { SkillTaskSupervisorSnapshot } from '../skills/skill-task-supervisor'
import {
  getRememberedActiveSkillContext,
  resolveActiveSkillContextFromInputs,
  type ActiveSkillContext,
} from '../session/active-skill-context'
import { applySteeringToTurnFrame } from './turn-frame-steering'
import type { TurnFrame, TurnFrameLiveness, TurnFrameMode, TurnUserIntent } from './turn-frame'
import type { FollowupTaskRef } from '../../../../shared/agent-followup-intent'

/**
 * Stage M (M0a) — seed `frame.activeArtifactRoots` from the resolved
 * `ActiveSkillContext` and `SkillRunContract` so cold-session reads via
 * `skill_read_artifact` succeed without needing a prior `skill_inspect_run_state`.
 *
 * Mirrors the legacy fallback list in `skills-tools.ts:1689-1695` so removing
 * that fallback (M4+M5) does not regress reads of frame-known directories.
 *
 * Pure helper. The primary load-bearing source is `ActiveSkillContext` —
 * `runContract.artifactRoots` is currently `[outputDir]` (run-contracts.ts:1407)
 * so it is additive and harmless when redundant.
 */
export function deriveSeedArtifactRoots(args: {
  context: ActiveSkillContext | null
  runContract: SkillRunContract | null
  additionalReadRoots?: string[]
}): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  const push = (path?: string | null): void => {
    if (typeof path !== 'string') return
    const trimmed = path.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    roots.push(trimmed)
  }
  if (args.context) {
    push(args.context.outputDir)
    if (args.context.runStatePath) push(dirname(args.context.runStatePath))
    if (args.context.sceneScoresPath) push(dirname(args.context.sceneScoresPath))
    if (args.context.deliveryReportPath) push(dirname(args.context.deliveryReportPath))
  }
  if (args.runContract) {
    push(args.runContract.outputDir)
    if (args.runContract.runStatePath) push(dirname(args.runContract.runStatePath))
    for (const root of args.runContract.artifactRoots || []) push(root)
    if (args.runContract.artifactPaths?.sceneScoresPath) {
      push(dirname(args.runContract.artifactPaths.sceneScoresPath))
    }
    if (args.runContract.artifactPaths?.deliveryReportPath) {
      push(dirname(args.runContract.artifactPaths.deliveryReportPath))
    }
  }
  for (const root of args.additionalReadRoots || []) push(root)
  return roots
}

export type ChainedSkillReadRootKind = 'sibling_asset' | 'sibling_output'

export interface ChainedSkillDefinition {
  id: string
  name?: string | null
  managedPath?: string | null
  sourcePath?: string | null
  executionMode?: string | null
  runtime?: string | null
  actions?: Array<{ runtime?: string | null }>
}

function resolveExistingDirectoryWithinRoot(root: string, candidate: string): string | null {
  try {
    const canonicalRoot = realpathSync.native(resolve(root))
    const canonicalCandidate = realpathSync.native(resolve(candidate))
    if (!statSync(canonicalRoot).isDirectory() || !statSync(canonicalCandidate).isDirectory()) return null
    const rel = relative(canonicalRoot, canonicalCandidate)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? canonicalCandidate : null
  } catch {
    return null // silent-catch: missing/unreadable roots are never authorized.
  }
}

function isReferenceKindSkill(skill: ChainedSkillDefinition): boolean {
  return skill.executionMode === 'advisory'
    || skill.runtime === 'reference'
    || Boolean(skill.actions?.some((action) => action.runtime === 'reference'))
}

/** R-XREAD — seed only explicitly referenced sibling skill assets and output
 * directories proven to belong to this task and the managed outputs root. */
export function deriveChainedSkillReadRoots(args: {
  selectedSkillId: string | null
  referencedSkillNames: string[]
  skills: ChainedSkillDefinition[]
  outputsRoot: string
  taskProjection?: TaskProjectionRecord | null
}): Array<{ path: string; kind: ChainedSkillReadRootKind }> {
  const roots: Array<{ path: string; kind: ChainedSkillReadRootKind }> = []
  const seen = new Set<string>()
  const push = (path: unknown, kind: ChainedSkillReadRootKind): void => {
    const trimmed = typeof path === 'string' ? path.trim() : ''
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    roots.push({ path: trimmed, kind })
  }

  const referenced = new Set(args.referencedSkillNames.map((name) => name.trim()).filter(Boolean))
  for (const skill of args.skills) {
    if (skill.id === args.selectedSkillId || !isReferenceKindSkill(skill)) continue
    if (!referenced.has(skill.id) && !referenced.has(String(skill.name || '').trim())) continue
    push(skill.managedPath || skill.sourcePath, 'sibling_asset')
  }

  const outputsRoot = String(args.outputsRoot || '').trim()
  if (outputsRoot) {
    for (const artifact of args.taskProjection?.recentArtifacts || []) {
      if (!artifact || typeof artifact !== 'object') continue
      const meta = artifact.meta && typeof artifact.meta === 'object'
        ? artifact.meta as Record<string, unknown>
        : null
      const explicitOutputDir = typeof meta?.outputDir === 'string'
        ? meta.outputDir
        : typeof meta?.output_dir === 'string'
          ? meta.output_dir
          : null
      const artifactPath = typeof artifact.path === 'string' ? artifact.path : null
      const candidate = explicitOutputDir || (artifactPath ? dirname(artifactPath) : null)
      if (!candidate) continue
      const canonicalCandidate = resolveExistingDirectoryWithinRoot(outputsRoot, candidate)
      if (!canonicalCandidate) continue
      push(canonicalCandidate, 'sibling_output')
    }
  }
  return roots
}

export interface ResolveTurnFrameInputs {
  sessionId?: string | null
  requestId?: string | null
  userIntent?: TurnUserIntent
  explicitSkillId?: string | null
  explicitSkillName?: string | null
  explicitTaskRunId?: string | null
  explicitDetachedTaskId?: string | null
  explicitAction?: string | null
  explicitOutputDir?: string | null
  explicitRunStatePath?: string | null
  explicitSceneScoresPath?: string | null
  explicitDeliveryReportPath?: string | null
  supervisorSnapshot?: SkillTaskSupervisorSnapshot | null
  projections?: TaskProjectionRecord[]
  taskRuns?: SkillTaskRunRecord[]
  activeContext?: ActiveSkillContext | null
  referenceHint?: ReferenceSkillHint | null
  resumableTaskRefs?: ReadonlyArray<FollowupTaskRef>
}

export function buildTurnFrameResumableCandidates(
  refs: ReadonlyArray<FollowupTaskRef> | null | undefined,
): TurnFrame['resumableCandidates'] {
  return (refs || [])
    .filter((ref) => ref.canResume === true)
    .map((ref) => ({
      taskId: ref.taskId,
      ownerAgentId: ref.ownerAgentId || null,
      summary: ref.summary || null,
      blockerCategory: ref.blockerCategory || null,
      checkpointId: ref.continuationCheckpointId || null,
      browserTaskId: ref.browserTaskId || null,
    }))
}

function contextWithoutRemembered(inputs: Parameters<typeof resolveActiveSkillContextFromInputs>[0]): ActiveSkillContext | null {
  return resolveActiveSkillContextFromInputs({
    ...inputs,
    sessionId: null,
  })
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function contextFromExplicitInputs(inputs: ResolveTurnFrameInputs): ActiveSkillContext | null {
  const skillId = nonEmpty(inputs.explicitSkillId)
  if (!skillId) return null
  return {
    skillId,
    skillName: nonEmpty(inputs.explicitSkillName) || skillId,
    taskRunId: nonEmpty(inputs.explicitTaskRunId),
    detachedTaskId: nonEmpty(inputs.explicitDetachedTaskId),
    runStatePath: nonEmpty(inputs.explicitRunStatePath),
    outputDir: nonEmpty(inputs.explicitOutputDir),
    sceneScoresPath: nonEmpty(inputs.explicitSceneScoresPath),
    deliveryReportPath: nonEmpty(inputs.explicitDeliveryReportPath),
    action: nonEmpty(inputs.explicitAction),
    source: 'explicit',
    confidence: 100,
    status: null,
    staleBlockerReason: null,
    observedAt: new Date().toISOString(),
  }
}

function chooseContext(inputs: ResolveTurnFrameInputs): ActiveSkillContext | null {
  if (inputs.explicitSkillId) {
    return contextFromExplicitInputs(inputs)
  }

  const supervisor = contextWithoutRemembered({
    supervisorSnapshot: inputs.supervisorSnapshot || null,
  })
  if (supervisor) return supervisor

  const projection = contextWithoutRemembered({
    projections: inputs.projections || [],
  })
  if (projection) return projection

  const taskRun = contextWithoutRemembered({
    taskRuns: inputs.taskRuns || [],
  })
  if (taskRun) return taskRun

  if (inputs.activeContext && inputs.activeContext.source !== 'reference_hint') return inputs.activeContext

  const referenceHint = contextWithoutRemembered({
    referenceHint: inputs.referenceHint || null,
  })
  if (referenceHint) return referenceHint

  if (inputs.activeContext) return inputs.activeContext

  return getRememberedActiveSkillContext(inputs.sessionId)
}

function inferLiveness(
  context: ActiveSkillContext | null,
  snapshot?: SkillTaskSupervisorSnapshot | null,
  userIntent?: TurnUserIntent,
): TurnFrameLiveness {
  if (!context) return 'unknown'
  // Stage Q (Stage 11) — when the user said "start" (fresh /
  // restart_from_existing intent), do NOT borrow stale supervisor or
  // context liveness. Even if a supervisor snapshot was loaded, treat
  // the frame as having unknown liveness so steering doesn't checkpoint
  // the new turn into the old run's blocked/budget_paused state.
  // Audit §C-9 / §E / plan §3.6 contract C9.
  if (userIntent === 'start') return 'unknown'
  if (snapshot && context.source === 'supervisor') {
    if (snapshot.status === 'completed') return 'done'
    if (snapshot.status === 'failed') return 'failed'
    if (snapshot.hasLiveWork) return 'running_process'
    if (snapshot.hasRecentProgress) return 'recent_progress'
    if (isDirectlyResumableTaskStatus(snapshot.status)) return 'recoverable_paused'
    if (isPausedTaskStatus(snapshot.status)) return 'blocked'
  }
  // ActiveSkillContext.status carries the projection / task-run status
  // strings, which still use legacy `done` / `background_running` /
  // `running`. Phase 7 normalized supervisor output (`completed`,
  // `running` + `liveness='background'`) is also tolerated.
  if (context.status === 'done' || context.status === 'completed') return 'done'
  if (context.status === 'failed') return 'failed'
  if (context.status === 'background_running' || context.status === 'running') return 'running_process'
  if (isDirectlyResumableTaskStatus(context.status)) return 'recoverable_paused'
  if (isPausedTaskStatus(context.status)) return 'blocked'
  return 'unknown'
}

function livenessFromSupervisorSnapshot(snapshot?: SkillTaskSupervisorSnapshot | null): TurnFrameLiveness | null {
  if (!snapshot) return null
  if (snapshot.status === 'completed') return 'done'
  if (snapshot.status === 'failed') return 'failed'
  if (snapshot.hasLiveWork) return 'running_process'
  if (snapshot.hasRecentProgress) return 'recent_progress'
  if (isDirectlyResumableTaskStatus(snapshot.status)) return 'recoverable_paused'
  if (isPausedTaskStatus(snapshot.status)) return 'blocked'
  return null
}

function progressFromSnapshot(snapshot?: SkillTaskSupervisorSnapshot | null): TurnFrame['progress'] {
  const progress = snapshot?.progress || null
  return {
    stage: typeof progress?.currentStage === 'string' ? progress.currentStage : null,
    totalUnits: typeof progress?.totalScenes === 'number' ? progress.totalScenes : null,
    completedUnits: typeof progress?.completedScenes === 'number' ? progress.completedScenes : null,
    coverageRatio: typeof progress?.coverageRatio === 'number' ? progress.coverageRatio : null,
    fingerprint: snapshot?.progressFingerprint || null,
  }
}

function inferMode(context: ActiveSkillContext | null, userIntent: TurnUserIntent): TurnFrameMode {
  if (!context) return 'general'
  if (userIntent === 'repair_config') return 'skill_repair'
  if (userIntent === 'inspect') return 'skill_inspect'
  if (userIntent === 'continue') return 'skill_resume'
  if (userIntent === 'start' || context.source === 'explicit') return 'skill_start'
  return 'general'
}

export function applySupervisorRuntimeToTurnFrame(
  frame: TurnFrame,
  snapshot?: SkillTaskSupervisorSnapshot | null,
): TurnFrame {
  if (!snapshot || !frame.skill || snapshot.skillId !== frame.skill.skillId) return frame
  return applySteeringToTurnFrame({
    ...frame,
    liveness: livenessFromSupervisorSnapshot(snapshot) || frame.liveness,
    progress: progressFromSnapshot(snapshot),
  })
}

export function resolveTurnFrame(inputs: ResolveTurnFrameInputs): TurnFrame {
  const context = chooseContext(inputs)
  const supervisorForContext =
    context?.source === 'supervisor'
      && inputs.supervisorSnapshot?.skillId === context.skillId
      ? inputs.supervisorSnapshot
      : null

  const userIntent = inputs.userIntent || 'unknown'

  // Step C5 — when supervisor snapshot exposes durable handles, build a
  // SkillRunContract read model and place it on frame.skill.runContract so
  // the next iteration's steering / dispatch decisions can derive forced
  // typed action input from the contract instead of from in-memory locals.
  const runContract = context
    ? loadSkillRunContract({
      sessionId: inputs.sessionId,
      skillId: context.skillId,
      outputDir: context.outputDir,
      runStatePath: context.runStatePath,
      supervisorSnapshot: supervisorForContext,
      referenceHint: inputs.referenceHint || null,
    })
    : null

  const frame: TurnFrame = {
    ids: {
      sessionId: inputs.sessionId || null,
      requestId: inputs.requestId || null,
    },
    mode: inferMode(context, userIntent),
    userIntent,
    skill: context
      ? {
        skillId: context.skillId,
        skillName: context.skillName,
        source: context.source,
        confidence: context.confidence,
        taskRunId: context.taskRunId,
        detachedTaskId: context.detachedTaskId,
        action: context.action,
        runStatePath: context.runStatePath,
        outputDir: context.outputDir,
        artifactPaths: {
          sceneScoresPath: context.sceneScoresPath,
          deliveryReportPath: context.deliveryReportPath,
        },
        status: context.status,
        staleBlockerReason: context.staleBlockerReason,
        runContract,
      }
      : null,
    resumableCandidates: buildTurnFrameResumableCandidates(inputs.resumableTaskRefs),
    liveness: inferLiveness(context, supervisorForContext, userIntent),
    progress: progressFromSnapshot(supervisorForContext),
    steering: {
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames: [],
      systemReminder: null,
      action: null,
    },
    budget: {
      leaseEndIteration: null,
      hardCapIteration: null,
      exhausted: false,
    },
    // Stage M (M0a) — seed read-sandbox roots from the resolved context +
    // run contract so cold-session reads via `skill_read_artifact` succeed
    // without a prior `skill_inspect_run_state`. Mirrors the legacy fallback
    // list in skills-tools.ts:1689-1695, which M4+M5 will then remove.
    activeArtifactRoots: deriveSeedArtifactRoots({ context, runContract }),
    configValidation: null,
    terminalReason: null,
  }
  return applySteeringToTurnFrame(frame)
}
