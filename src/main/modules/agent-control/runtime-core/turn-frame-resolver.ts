import { dirname } from 'node:path'

import type { ReferenceSkillHint } from '../skills/skill-reference-hints'
import {
  loadSkillRunContract,
  type SkillRunContract,
  type TaskProjectionRecord,
} from '../contracts/run-contracts'
import type { SkillTaskRunRecord } from '../repositories/skill-task-run-repository'
import type { SkillTaskSupervisorSnapshot } from '../skills/skill-task-supervisor'
import {
  getRememberedActiveSkillContext,
  resolveActiveSkillContextFromInputs,
  type ActiveSkillContext,
} from '../active-skill-context'
import { applySteeringToTurnFrame } from './turn-frame-steering'
import type { TurnFrame, TurnFrameLiveness, TurnFrameMode, TurnUserIntent } from './turn-frame'

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
    if (snapshot.status === 'recoverable_paused' || snapshot.status === 'budget_paused') return 'recoverable_paused'
    if (snapshot.status === 'blocked') return 'blocked'
  }
  // ActiveSkillContext.status carries the projection / task-run status
  // strings, which still use legacy `done` / `background_running` /
  // `running`. Phase 7 normalized supervisor output (`completed`,
  // `running` + `liveness='background'`) is also tolerated.
  if (context.status === 'done' || context.status === 'completed') return 'done'
  if (context.status === 'failed') return 'failed'
  if (context.status === 'background_running' || context.status === 'running') return 'running_process'
  if (context.status === 'budget_paused' || context.status === 'recoverable_paused') return 'recoverable_paused'
  if (context.status === 'blocked') return 'blocked'
  return 'unknown'
}

function livenessFromSupervisorSnapshot(snapshot?: SkillTaskSupervisorSnapshot | null): TurnFrameLiveness | null {
  if (!snapshot) return null
  if (snapshot.status === 'completed') return 'done'
  if (snapshot.status === 'failed') return 'failed'
  if (snapshot.hasLiveWork) return 'running_process'
  if (snapshot.hasRecentProgress) return 'recent_progress'
  if (snapshot.status === 'recoverable_paused' || snapshot.status === 'budget_paused') return 'recoverable_paused'
  if (snapshot.status === 'blocked') return 'blocked'
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
