import type { SkillRunResult } from '../skills-runtime/runtime-manager'

import type { SkillChildDriver } from './skill-child-drivers'
import type {
  MutableSkillChildCloseEvent,
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
  SkillChildRunStatus,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'
import { freezeSkillChildCloseEvent } from './skill-child-close-event-freeze'
import {
  getSkillChildCloseEventFromMetadata,
  SKILL_CHILD_CLOSE_EVENT_METADATA_KEY,
} from './skill-child-sub-agent-close-mapping'
import {
  isSkillChildProgressPayload,
  type SkillChildProgressPayload,
} from './skill-child-sub-agent-events'
import type {
  SubAgent,
  SubAgentContext,
  SubAgentProgress,
  SubAgentRunResult,
  SubAgentTerminalReason,
  SubAgentWorkEvent,
} from './sub-agent/sub-agent-types'

export type SkillChildSubAgentActionExecutor = (
  action: SkillChildDriverAction,
  state: SkillChildDriverState,
) => Promise<SkillRunResult>

export interface SkillChildSubAgentParams {
  readonly childRunId: string
  readonly outputDir: string
  readonly runStatePath: string
  readonly driver: SkillChildDriver
  readonly initialState: SkillChildDriverState
  readonly executeAction: SkillChildSubAgentActionExecutor
  readonly parentScopeId: string | null
  readonly parentSessionId: string | null
  readonly maxActions?: number
  readonly runDriverCall?: <T>(call: () => Promise<T>) => Promise<T>
}

const DEFAULT_MAX_ACTIONS = 24

export function createSkillChildSubAgent(params: SkillChildSubAgentParams): SubAgent {
  return {
    lifecycleId: params.childRunId,
    durableRunId: params.childRunId,
    subagentName: 'SkillChildSubAgent',
    artifactDir: params.outputDir,
    async *run(context: SubAgentContext): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
      let state = params.initialState
      let actionsPlanned = 0
      const maxActions = params.maxActions ?? DEFAULT_MAX_ACTIONS

      while (true) {
        if (context.abortSignal.aborted) {
          return toSubAgentResult(makeAbortClose(params, context.abortSignal.reason))
        }

        let plan: SkillChildDriverAction | SkillChildCloseEvent
        try {
          plan = await runDriverCall(params, () => params.driver.planNextAction(state))
        } catch (error) {
          return toSubAgentResult(makeCloseEvent({
            params,
            status: 'failed',
            terminalReason: 'failed_skill',
            errorKind: 'driver_plan_failed',
            message: errorMessage(error),
          }))
        }

        if (isSkillChildCloseEvent(plan)) {
          return toSubAgentResult(freezeSkillChildCloseEvent({
            ...plan,
            childRunId: params.childRunId,
          } as MutableSkillChildCloseEvent))
        }

        if (actionsPlanned >= maxActions) {
          const closeEvent = makeCloseEvent({
            params,
            status: 'budget_paused',
            terminalReason: 'checkpoint_budget',
            errorKind: 'checkpoint_budget',
            message: `Child action budget exhausted (max=${maxActions})`,
          })
          yield {
            type: 'paused',
            pauseReason: 'budget',
            reason: 'checkpoint_budget',
            message: closeEvent.error?.message ?? null,
            payload: { closeEvent },
            progress: closeEvent.progress,
          }
          return toSubAgentResult(closeEvent)
        }

        actionsPlanned += 1
        yield {
          type: 'progress',
          message: `action_started:${plan.action}`,
          payload: {
            kind: 'action_started',
            actionName: plan.action,
            actionInput: plan.input,
            actionIndex: actionsPlanned,
          } satisfies SkillChildProgressPayload,
        }

        const actionStartedMs = Date.now()
        const result = await params.executeAction(plan, state)
        const durationMs = Math.max(0, Date.now() - actionStartedMs)
        yield {
          type: 'progress',
          message: `action_completed:${plan.action}`,
          payload: {
            kind: 'action_completed',
            actionName: plan.action,
            success: result.success,
            durationMs,
          } satisfies SkillChildProgressPayload,
        }

        if (!result.success) {
          return toSubAgentResult(makeCloseEvent({
            params,
            status: 'failed',
            terminalReason: 'failed_skill',
            errorKind: 'failed_skill',
            message: result.error || 'skill action returned success=false',
          }))
        }

        try {
          state = await runDriverCall(params, () => params.driver.observeAfterAction(state, result))
        } catch (error) {
          return toSubAgentResult(makeCloseEvent({
            params,
            status: 'failed',
            terminalReason: 'failed_skill',
            errorKind: 'driver_observe_failed',
            message: errorMessage(error),
          }))
        }

        yield {
          type: 'progress',
          message: 'state_observed',
          payload: {
            kind: 'state_observed',
            stage: readStateString(state, ['stage', 'currentStage'], ['progress', 'parsedRunState']),
            fingerprint: readStateString(state, ['fingerprint'], ['progress', 'parsedRunState']),
          } satisfies SkillChildProgressPayload,
        }
      }
    },
  }
}

export function getSkillChildCloseEventFromSubAgentResult(result: SubAgentRunResult): SkillChildCloseEvent | null {
  return getSkillChildCloseEventFromMetadata(result.metadata)
}

export function getSkillChildCloseEventFromSubAgentClose(closeEvent: {
  metadata?: Readonly<Record<string, unknown>>
}): SkillChildCloseEvent | null {
  return getSkillChildCloseEventFromMetadata(closeEvent.metadata)
}

export { isSkillChildProgressPayload as isSkillChildSubAgentProgressPayload }

function toSubAgentResult(closeEvent: SkillChildCloseEvent): SubAgentRunResult {
  const frozenCloseEvent = freezeSkillChildCloseEvent(closeEvent as MutableSkillChildCloseEvent)
  return {
    state: subAgentStateForChildStatus(frozenCloseEvent.status),
    terminalReason: subAgentReasonForChildClose(frozenCloseEvent),
    outputDir: frozenCloseEvent.outputDir,
    runStatePath: frozenCloseEvent.runStatePath,
    sceneScoresPath: frozenCloseEvent.sceneScoresPath,
    deliveryReportPath: frozenCloseEvent.deliveryReportPath,
    progress: frozenCloseEvent.progress satisfies SubAgentProgress,
    framePatch: frozenCloseEvent.framePatch,
    projectionPatch: frozenCloseEvent.projectionPatch,
    error: frozenCloseEvent.error,
    metadata: {
      [SKILL_CHILD_CLOSE_EVENT_METADATA_KEY]: frozenCloseEvent,
    },
  }
}

function subAgentStateForChildStatus(status: SkillChildCloseEvent['status']): SubAgentRunResult['state'] {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'killed':
      return 'cancelled'
    case 'blocked':
    case 'recoverable_paused':
    case 'budget_paused':
      return 'blocked'
    case 'failed':
      return 'failed'
  }
}

function subAgentReasonForChildClose(closeEvent: SkillChildCloseEvent): SubAgentTerminalReason {
  switch (closeEvent.terminalReason) {
    case 'completed':
    case 'cancelled_user':
    case 'host_unavailable':
    case 'persistence_failed':
    case 'blocked_config':
    case 'blocked_external':
    case 'checkpoint_budget':
    case 'checkpoint_background':
    case 'process_restarted':
      return closeEvent.terminalReason
    default:
      return closeEvent.status === 'failed' ? 'failed_subagent' : 'blocked_external'
  }
}

function makeAbortClose(params: SkillChildSubAgentParams, reason: unknown): SkillChildCloseEvent {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'cancelled_user'
  const isLaunchStuck = message === 'launch_stuck'
  return makeCloseEvent({
    params,
    status: isLaunchStuck ? 'failed' : 'killed',
    terminalReason: isLaunchStuck ? 'launch_stuck' : 'cancelled_user',
    errorKind: isLaunchStuck ? 'launch_stuck' : 'cancelled_user',
    message,
  })
}

function runDriverCall<T>(params: SkillChildSubAgentParams, call: () => Promise<T>): Promise<T> {
  return params.runDriverCall ? params.runDriverCall(call) : call()
}

function makeCloseEvent(args: {
  params: SkillChildSubAgentParams
  status: SkillChildRunStatus
  terminalReason: SkillChildRunTerminalReason
  errorKind: string | null
  message: string | null
}): SkillChildCloseEvent {
  const status = args.status === 'queued' || args.status === 'running'
    ? 'recoverable_paused'
    : args.status
  return freezeSkillChildCloseEvent({
    childRunId: args.params.childRunId,
    skillId: args.params.driver.skillId,
    status,
    terminalReason: args.terminalReason,
    outputDir: args.params.outputDir,
    runStatePath: args.params.runStatePath,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
    error: args.errorKind && args.message
      ? { kind: args.errorKind, message: args.message }
      : null,
  })
}

function isSkillChildCloseEvent(value: unknown): value is SkillChildCloseEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.status === 'string'
    && typeof candidate.terminalReason === 'string'
    && typeof candidate.skillId === 'string'
    && 'progress' in candidate
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function readStateString(
  state: SkillChildDriverState,
  directKeys: string[],
  objectKeys: string[],
): string | null {
  for (const key of directKeys) {
    const value = state[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  for (const objectKey of objectKeys) {
    const nested = state[objectKey]
    if (!nested || typeof nested !== 'object') continue
    const record = nested as Record<string, unknown>
    for (const key of directKeys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  return null
}
