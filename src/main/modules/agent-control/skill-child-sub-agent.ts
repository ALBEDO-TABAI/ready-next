import { readFileSync } from 'node:fs'

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
          return toSubAgentResult(makeActionFailureClose(params, result))
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
  handles?: {
    outputDir?: string | null
    runStatePath?: string | null
    sceneScoresPath?: string | null
    deliveryReportPath?: string | null
  }
}): SkillChildCloseEvent {
  const status = args.status === 'queued' || args.status === 'running'
    ? 'recoverable_paused'
    : args.status
  return freezeSkillChildCloseEvent({
    childRunId: args.params.childRunId,
    skillId: args.params.driver.skillId,
    status,
    terminalReason: args.terminalReason,
    outputDir: args.handles?.outputDir ?? args.params.outputDir,
    runStatePath: args.handles?.runStatePath ?? args.params.runStatePath,
    sceneScoresPath: args.handles?.sceneScoresPath ?? null,
    deliveryReportPath: args.handles?.deliveryReportPath ?? null,
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

function makeActionFailureClose(
  params: SkillChildSubAgentParams,
  result: SkillRunResult,
): SkillChildCloseEvent {
  const handles = actionResultHandles(params, result)
  if (result.status === 'blocked' || readRunStateStatus(handles.runStatePath) === 'blocked') {
    return makeCloseEvent({
      params,
      status: 'blocked',
      terminalReason: 'blocked_external',
      errorKind: 'blocked_external',
      message: result.error || 'skill action returned blocked result',
      handles,
    })
  }

  return makeCloseEvent({
    params,
    status: 'failed',
    terminalReason: 'failed_skill',
    errorKind: 'failed_skill',
    message: result.error || 'skill action returned success=false',
  })
}

function actionResultHandles(
  params: SkillChildSubAgentParams,
  result: SkillRunResult,
): {
  outputDir: string | null
  runStatePath: string | null
  sceneScoresPath: string | null
  deliveryReportPath: string | null
} {
  const resultRecord = result as unknown as Record<string, unknown>
  const outputs = result.outputs ?? {}
  const outputDir = pickString(result.outputDir)
    ?? pickRecordString(outputs, ['outputDir', 'output_dir'])
    ?? pickRecordString(resultRecord, ['outputDir', 'output_dir'])
    ?? params.outputDir
  return {
    outputDir,
    runStatePath: pickRecordString(outputs, ['runStatePath', 'run_state_path'])
      ?? pickRecordString(resultRecord, ['runStatePath', 'run_state_path'])
      ?? params.runStatePath,
    sceneScoresPath: pickRecordString(outputs, ['sceneScoresPath', 'scene_scores_path'])
      ?? pickRecordString(resultRecord, ['sceneScoresPath', 'scene_scores_path']),
    deliveryReportPath: pickRecordString(outputs, ['deliveryReportPath', 'delivery_report_path'])
      ?? pickRecordString(resultRecord, ['deliveryReportPath', 'delivery_report_path']),
  }
}

function readRunStateStatus(runStatePath: string | null): string | null {
  if (!runStatePath) return null
  try {
    const parsed = JSON.parse(readFileSync(runStatePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return pickString((parsed as Record<string, unknown>).status)?.toLowerCase() ?? null
  } catch {
    return null
  }
}

function pickRecordString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = pickString(record[key])
    if (value) return value
  }
  return null
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
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
