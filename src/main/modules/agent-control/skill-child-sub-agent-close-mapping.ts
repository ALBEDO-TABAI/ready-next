import type {
  MutableSkillChildCloseEvent,
  SkillChildCloseEvent,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'
import { freezeSkillChildCloseEvent } from './skill-child-close-event-freeze'
import type {
  SubAgentCloseEvent,
  SubAgentProgress,
} from './sub-agent/sub-agent-types'

export const SKILL_CHILD_CLOSE_EVENT_METADATA_KEY = 'skillChildCloseEvent'

export interface SkillChildCloseMappingRuntimeContext {
  readonly childRunId: string
  readonly skillId: string
  readonly outputDir: string | null
  readonly runStatePath: string | null
  readonly sceneScoresPath?: string | null
  readonly deliveryReportPath?: string | null
  readonly progress?: SkillChildCloseEvent['progress'] | null
  readonly framePatch?: SkillChildCloseEvent['framePatch'] | null
  readonly projectionPatch?: SkillChildCloseEvent['projectionPatch'] | null
  readonly isUserCancel?: boolean
  readonly isParentSessionAbort?: boolean
  readonly isLaunchStuckFired?: boolean
}

export function getSkillChildCloseEventFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): SkillChildCloseEvent | null {
  const childCloseEvent = metadata?.[SKILL_CHILD_CLOSE_EVENT_METADATA_KEY]
  return isSkillChildCloseEvent(childCloseEvent)
    ? freezeSkillChildCloseEvent(childCloseEvent as MutableSkillChildCloseEvent)
    : null
}

export function mapSubAgentCloseToChildClose(
  subAgentClose: SubAgentCloseEvent,
  runtimeContext: SkillChildCloseMappingRuntimeContext,
): SkillChildCloseEvent {
  const preserved = getSkillChildCloseEventFromMetadata(subAgentClose.metadata)
  if (preserved) {
    return freezeSkillChildCloseEvent({
      ...preserved,
      childRunId: runtimeContext.childRunId,
      skillId: runtimeContext.skillId,
      outputDir: preserved.outputDir ?? runtimeContext.outputDir,
      runStatePath: preserved.runStatePath ?? runtimeContext.runStatePath,
      sceneScoresPath: preserved.sceneScoresPath ?? runtimeContext.sceneScoresPath ?? null,
      deliveryReportPath: preserved.deliveryReportPath ?? runtimeContext.deliveryReportPath ?? null,
    } as MutableSkillChildCloseEvent)
  }

  if (subAgentClose.state === 'completed' && subAgentClose.terminalReason === 'completed') {
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'completed',
      terminalReason: 'completed',
      errorKind: null,
    })
  }

  if (subAgentClose.state === 'cancelled' && subAgentClose.terminalReason === 'aborted') {
    if (runtimeContext.isLaunchStuckFired) {
      return makeMappedClose(runtimeContext, subAgentClose, {
        status: 'failed',
        terminalReason: 'launch_stuck',
        errorKind: 'launch_stuck',
      })
    }
    const terminalReason: SkillChildRunTerminalReason = runtimeContext.isParentSessionAbort
      ? 'process_restarted'
      : 'cancelled_user'
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'killed',
      terminalReason,
      errorKind: terminalReason,
    })
  }

  if (subAgentClose.state === 'failed' && subAgentClose.terminalReason === 'persistence_failed') {
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'failed',
      terminalReason: 'persistence_failed',
      errorKind: 'persistence_failed',
    })
  }

  if (subAgentClose.state === 'blocked' && subAgentClose.terminalReason === 'checkpoint_budget') {
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'budget_paused',
      terminalReason: 'checkpoint_budget',
      errorKind: 'checkpoint_budget',
    })
  }

  if (subAgentClose.state === 'blocked' && subAgentClose.terminalReason === 'checkpoint_background') {
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'budget_paused',
      terminalReason: 'checkpoint_background',
      errorKind: 'checkpoint_background',
    })
  }

  if (subAgentClose.state === 'blocked' && subAgentClose.terminalReason === 'blocked_external') {
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'blocked',
      terminalReason: 'blocked_external',
      errorKind: 'blocked_external',
    })
  }

  if (subAgentClose.state === 'blocked' && subAgentClose.terminalReason === 'blocked_config') {
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'blocked',
      terminalReason: 'blocked_config',
      errorKind: 'blocked_config',
    })
  }

  if (subAgentClose.state === 'failed' && subAgentClose.terminalReason === 'failed_subagent') {
    const terminalReason = terminalReasonFromFailedSubAgent(subAgentClose, runtimeContext)
    return makeMappedClose(runtimeContext, subAgentClose, {
      status: 'failed',
      terminalReason,
      errorKind: subAgentClose.error?.kind ?? terminalReason,
    })
  }

  return makeMappedClose(runtimeContext, subAgentClose, {
    status: subAgentClose.state === 'cancelled' ? 'killed' : 'failed',
    terminalReason: subAgentClose.state === 'cancelled' ? 'cancelled_user' : 'child_process_crashed',
    errorKind: subAgentClose.error?.kind ?? subAgentClose.terminalReason,
  })
}

function terminalReasonFromFailedSubAgent(
  subAgentClose: SubAgentCloseEvent,
  runtimeContext: SkillChildCloseMappingRuntimeContext,
): SkillChildRunTerminalReason {
  if (runtimeContext.isLaunchStuckFired) return 'launch_stuck'
  const errorKind = subAgentClose.error?.kind ?? ''
  if (errorKind === 'failed_skill') return 'failed_skill'
  if (errorKind === 'child_process_crashed') return 'child_process_crashed'
  if (errorKind === 'input_validation') return 'input_validation'
  if (errorKind === 'host_unavailable') return 'host_unavailable'
  if (errorKind === 'tool_not_registered') return 'tool_not_registered'
  if (errorKind === 'ProcessExitError' || errorKind === 'ChildProcessTerminationError') {
    return 'child_process_crashed'
  }
  if (errorKind === 'ZodError' || errorKind === 'SchemaValidationError') {
    return 'input_validation'
  }
  if (errorKind === 'ToolHostUnavailableError') return 'host_unavailable'
  if (errorKind === 'DriverInternalError' || errorKind.startsWith('driver_')) return 'failed_skill'
  return 'child_process_crashed'
}

function makeMappedClose(
  runtimeContext: SkillChildCloseMappingRuntimeContext,
  subAgentClose: SubAgentCloseEvent,
  args: {
    status: SkillChildCloseEvent['status']
    terminalReason: SkillChildRunTerminalReason
    errorKind: string | null
  },
): SkillChildCloseEvent {
  const message = subAgentClose.error?.message
    || (args.terminalReason === 'completed' ? null : args.terminalReason)
  return freezeSkillChildCloseEvent({
    childRunId: runtimeContext.childRunId,
    skillId: runtimeContext.skillId,
    status: args.status,
    terminalReason: args.terminalReason,
    outputDir: subAgentClose.outputDir ?? runtimeContext.outputDir,
    runStatePath: subAgentClose.runStatePath ?? runtimeContext.runStatePath,
    sceneScoresPath: subAgentClose.sceneScoresPath ?? runtimeContext.sceneScoresPath ?? null,
    deliveryReportPath: subAgentClose.deliveryReportPath ?? runtimeContext.deliveryReportPath ?? null,
    progress: normalizeProgress(subAgentClose.progress ?? runtimeContext.progress ?? null),
    framePatch: subAgentClose.framePatch ?? runtimeContext.framePatch ?? null,
    projectionPatch: subAgentClose.projectionPatch ?? runtimeContext.projectionPatch ?? null,
    error: args.errorKind && message
      ? { kind: args.errorKind, message }
      : null,
  })
}

function normalizeProgress(
  progress: SkillChildCloseEvent['progress'] | SubAgentProgress | null,
): SkillChildCloseEvent['progress'] {
  if (!progress) return emptyProgress()
  return {
    stage: progress.stage ?? null,
    totalUnits: progress.totalUnits ?? null,
    completedUnits: progress.completedUnits ?? null,
    coverageRatio: progress.coverageRatio ?? null,
    overallCoverageRatio: progress.overallCoverageRatio ?? null,
    fingerprint: progress.fingerprint ?? null,
  }
}

function emptyProgress(): SkillChildCloseEvent['progress'] {
  return {
    stage: null,
    totalUnits: null,
    completedUnits: null,
    coverageRatio: null,
    overallCoverageRatio: null,
    fingerprint: null,
  }
}

function isSkillChildCloseEvent(value: unknown): value is SkillChildCloseEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.status === 'string'
    && typeof candidate.terminalReason === 'string'
    && typeof candidate.skillId === 'string'
    && 'progress' in candidate
}
