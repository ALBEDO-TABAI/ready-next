import type { ReferenceSkillHint } from './skill-reference-hints'
import type { TaskProjectionRecord } from './run-contracts'
import type { SkillTaskRunRecord } from '../repositories/skill-task-run-repository'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import {
  getRememberedActiveSkillContext,
  resolveActiveSkillContextFromInputs,
  type ActiveSkillContext,
} from './active-skill-context'
import { applySteeringToTurnFrame } from './turn-frame-steering'
import type { TurnFrame, TurnFrameLiveness, TurnFrameMode, TurnUserIntent } from './turn-frame'

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

function inferLiveness(context: ActiveSkillContext | null, snapshot?: SkillTaskSupervisorSnapshot | null): TurnFrameLiveness {
  if (!context) return 'unknown'
  if (snapshot && context.source === 'supervisor') {
    if (snapshot.status === 'done') return 'done'
    if (snapshot.status === 'failed') return 'failed'
    if (snapshot.hasLiveWork) return 'running_process'
    if (snapshot.hasRecentProgress) return 'recent_progress'
    if (snapshot.status === 'blocked') return 'blocked'
  }
  if (context.status === 'done') return 'done'
  if (context.status === 'failed') return 'failed'
  if (context.status === 'background_running' || context.status === 'running') return 'running_process'
  if (context.status === 'budget_paused') return 'recoverable_paused'
  if (context.status === 'blocked') return 'blocked'
  return 'unknown'
}

function livenessFromSupervisorSnapshot(snapshot?: SkillTaskSupervisorSnapshot | null): TurnFrameLiveness | null {
  if (!snapshot) return null
  if (snapshot.status === 'done') return 'done'
  if (snapshot.status === 'failed') return 'failed'
  if (snapshot.hasLiveWork) return 'running_process'
  if (snapshot.hasRecentProgress) return 'recent_progress'
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
      }
      : null,
    liveness: inferLiveness(context, supervisorForContext),
    progress: progressFromSnapshot(supervisorForContext),
    steering: {
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames: [],
      systemReminder: null,
    },
    budget: {
      leaseEndIteration: null,
      hardCapIteration: null,
      exhausted: false,
    },
    terminalReason: null,
  }
  return applySteeringToTurnFrame(frame)
}
