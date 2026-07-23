import { randomUUID } from 'node:crypto'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { BrowserHumanTakeoverIntentInput, BrowserTargetResumeRequest } from '../../../../shared/browser-workflow-control'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type { AgentExecutionProfileResolver } from '../agents/agent-execution-profile'
import type { ConversationScope, ScopeRunSummary } from '../contracts/types'
import type { ContinuationIntent } from '../contracts/continuation-state'
import type { ProjectionTruthSnapshot, TaskProjectionRecord } from '../contracts/run-contracts'
import type { RunCoordinator } from '../task-projection/run-coordinator'
import type { TaskProjectionRepository } from '../../repositories/task-projection-repository'
import type { ReadyAgentOrchestrator } from './orchestrator'
import {
  AgentSessionCheckpointRepository,
  workflowDigest,
} from '../../repositories/agent-session-checkpoint-repository'
import {
  buildManualSuspendProjectionPatch,
  finalizeRunOutcome,
  type RunMetaRepositoryLike,
  writeRunCloseMetric,
} from './run-finalizer'
import { getBudgetUsagePercent, restoreContinuationTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import { canRespondToUserInteractionWithoutResumeHandle } from './runtime-helpers'
import { getInteractionLifecycleRegistry } from './interaction-lifecycle-registry'
import { logAgentMetric } from '../metrics'
import { buildContinuationIntent } from './continuation-intent-builder'

type TaskControlTarget = {
  scope: ConversationScope
  projection: TaskProjectionRecord | null
  scopeRunSummary: ScopeRunSummary | null
}

export interface BrowserContinuationRuntimeDeps {
  agentSessionCheckpoints: AgentSessionCheckpointRepository
  browserController: BrowserController | null
  orchestrator: ReadyAgentOrchestrator
  taskProjectionStore: TaskProjectionRepository
  runCoordinator: RunCoordinator
  executionProfileResolver: AgentExecutionProfileResolver
  scopeRunSummaries: Map<string, ScopeRunSummary>
  getConversationScope(scopeId: string): ConversationScope | null
  getTaskProjection(taskId: string): TaskProjectionRecord | null
  listTaskProjections(scopeId: string): TaskProjectionRecord[]
  getRunMetaRepositoryForFinalize(): RunMetaRepositoryLike | null
  getTaskProjectionStoreForFinalize(): {
    get(taskId: string): TaskProjectionRecord | null
    update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: { silent?: boolean; reasonHint?: string }): void
  }
  getDomainAdapters(): ReadonlyArray<DomainAdapter>
  sendScoped(payload: {
    scopeId: string
    requestId?: string
    taskId?: string
    message: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string; errorKind?: string; projectionTruth?: ProjectionTruthSnapshot | null }>
}

export class BrowserContinuationRuntime {
  constructor(private readonly deps: BrowserContinuationRuntimeDeps) {}

async createHumanTakeoverIntent(
  input: BrowserHumanTakeoverIntentInput,
): Promise<{ takeoverId: string }> {
  const ref = await this.deps.agentSessionCheckpoints.createHumanTakeoverIntent({
    parentTaskId: input.parentTaskId,
    ownerRunId: input.ownerRunId,
    browserTaskId: input.browserTaskId,
    targetClaimId: input.targetClaimId ?? null,
    targetClaimGeneration: input.targetClaimGeneration ?? null,
    userPrompt: input.userPrompt ?? null,
    physicalTarget: {
      surface: input.surface,
      scopeId: input.scopeId,
      profileId: input.profileId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      physicalTargetToken: input.physicalTargetToken,
      source: input.source,
    },
  })
  const projection = this.deps.getTaskProjection(input.parentTaskId)
  getInteractionLifecycleRegistry().register({
    interactionId: ref.takeoverId,
    runId: input.ownerRunId,
    agentId: projection?.ownerAgentId || 'butler',
    scopeId: projection?.scopeId || input.scopeId || '',
    type: input.targetClaimId ? 'human_takeover' : 'page_challenge',
    timeoutMs: input.targetClaimId ? undefined : Math.max(1, Number(input.userPrompt?.timeoutSec || 300)) * 1_000,
    timeoutDisposition: input.targetClaimId ? undefined : 'checkpoint',
  })
  return { takeoverId: ref.takeoverId }
}

async suspendRun(payload: {
  scopeId: string
  taskId?: string
}): Promise<{ success: boolean; error?: string }> {
  const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
  if (!target) {
    return { success: false, error: 'Conversation scope not found' }
  }
  const restored = restoreContinuationTaskBudgetRuntime({
    taskType: target.projection?.taskType || 'short_task',
    projectionBudget: target.projection?.budget || null,
    projectionBudgetRuntime: null,
    budget: target.projection?.budget || null,
  })
  const runtime = restored.runtime
    ? {
      ...restored.runtime,
      frozen: true,
    }
    : null
  const resolvedTaskId =
    target.projection?.taskId
    || target.scopeRunSummary?.taskId
    || target.scopeRunSummary?.taskProjectionId
    || payload.taskId
    || null
  if (!resolvedTaskId) {
    return { success: false, error: 'Task projection not found' }
  }
  const stopped = this.deps.orchestrator.interruptForSuspend(target.scope.agent, target.scope.id)
  const resolvedRunId =
    stopped.runId
    || target.projection?.runId
    || target.scopeRunSummary?.runId
    || null
  if (!resolvedRunId) {
    return { success: false, error: 'Active run not found' }
  }
  const timestamp = new Date().toISOString()
  const projectionPatch = buildManualSuspendProjectionPatch({
    projection: target.projection,
    taskTitle: target.projection?.taskTitle ?? target.scopeRunSummary?.taskTitle ?? null,
    taskSummary: target.projection?.taskSummary ?? target.scopeRunSummary?.taskSummary ?? null,
    steps: target.projection?.steps ?? [],
    currentStepId: target.projection?.currentStepId ?? target.scopeRunSummary?.currentStepId ?? null,
    continuationRef: target.projection?.continuationRef ?? target.scopeRunSummary?.taskContinuation ?? null,
    budget: target.projection?.budget ?? null,
    budgetUsagePercent: runtime ? getBudgetUsagePercent(runtime) : target.projection?.budgetUsagePercent ?? null,
    budgetWarningLevel: runtime?.warningLevel ?? target.projection?.budgetWarningLevel ?? null,
    recoveryHistory: target.projection?.recoveryHistory ?? [],
    updatedAt: timestamp,
  })
  await finalizeRunOutcome({
    kind: 'interrupted',
    runId: resolvedRunId,
    taskId: resolvedTaskId,
    scopeId: target.scope.id,
    durationMs: 1,
    toolCallsUsed: 0,
    initiator: 'manual_suspend',
    terminalReason: 'manual_suspend',
    projectionPatch,
    taskBudgetRuntime: runtime,
  }, {
    runMetaRepository: this.deps.getRunMetaRepositoryForFinalize(),
    taskProjectionStore: this.deps.getTaskProjectionStoreForFinalize(),
    writeProjectionTerminalPatch: async (patch) => {
      if (!patch) return
      this.deps.taskProjectionStore.update(
        resolvedTaskId,
        patch as Partial<TaskProjectionRecord>,
        { reasonHint: 'update' },
      )
    },
    writeRunCloseMetric,
  })
  return { success: true }
}

async resumeRun(payload: {
  scopeId: string
  taskId?: string
  requestId?: string
  responseText?: string
  continuationIntent?: ContinuationIntent | null
}): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
  if (!target) {
    return { success: false, error: 'Conversation scope not found' }
  }
  if (
    target.projection?.checkpointRefs?.suspensionCheckpointId
    && target.projection.humanTakeoverRef?.state !== 'pending'
  ) {
    if (
      target.projection.blockedReason === 'browser_power_confirmation_checkpoint'
      || target.projection.blockedReason === 'browser_permission_checkpoint'
    ) {
      return {
        success: false,
        error: 'This Browser action requires an explicit confirmation decision.',
        errorKind: 'confirmation_required',
      }
    }
    return this.resumeBrowserWorkflowFromCheckpoint(target.projection, target.scope, {
      kind: 'typed_wake',
      requestId: payload.requestId,
    })
  }
  const builtIntent = buildContinuationIntent({
    projection: target.projection,
    scopeRunSummary: target.scopeRunSummary,
    incoming: payload.continuationIntent || null,
    responseText: payload.responseText,
  })
  // Stage Q (Stage 11) — Audit §F-6 / plan §3.4 contract C6+C7:
  // refuse to fire `sendScoped` with an empty-shell intent. The
  // `buildContinuationIntent` gate (canResumeShape) returns null
  // when no real durable handle is present; the renderer button
  // double-gates via `canResume`, but main MUST also refuse so
  // direct IPC calls (programmatic resumes, future agents) cannot
  // bypass the contract.
  if (builtIntent === null) {
    logAgentMetric('runtime_resume_run_rejected_not_resumable', {
      scopeId: target.scope.id,
      taskId: payload.taskId || null,
    })
    return {
      success: false,
      error: 'Task is not resumable: no durable handle (childRunId, detachedTaskId, or outputDir+runStatePath).',
      errorKind: 'not_resumable',
    }
  }
  return this.deps.sendScoped({
    scopeId: target.scope.id,
    requestId: payload.requestId,
    message: String(payload.responseText || '').trim() || '继续当前任务。',
    continuationIntent: builtIntent,
  })
}

async completeHumanTakeover(payload: {
  taskId: string
  takeoverId: string
}): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  const taskId = String(payload.taskId || '').trim()
  const takeoverId = String(payload.takeoverId || '').trim()
  if (!taskId || !takeoverId) {
    return { success: false, error: 'taskId and takeoverId are required', errorKind: 'invalid_payload' }
  }
  const projection = this.deps.taskProjectionStore.get(taskId) as TaskProjectionRecord | null
  const takeover = projection?.humanTakeoverRef
  if (
    !projection
    || projection.parentTaskId
    || !takeover
    || takeover.state !== 'pending'
    || takeover.takeoverId !== takeoverId
  ) {
    return { success: false, error: 'takeover_receipt_not_pending', errorKind: 'not_resumable' }
  }
  const scope = this.deps.getConversationScope(projection.scopeId)
  if (!scope) return { success: false, error: 'Conversation scope not found', errorKind: 'scope_missing' }
  if (
    takeover.physicalTarget
    && this.deps.browserController
    && this.deps.browserController.getPhysicalTargetToken(takeover.physicalTarget.tabId) !== takeover.physicalTarget.physicalTargetToken
  ) {
    return { success: false, error: 'takeover_physical_target_stale', errorKind: 'not_resumable' }
  }
  return this.resumeBrowserWorkflowFromCheckpoint(projection, scope, {
    kind: 'human_takeover',
    takeoverId,
  })
}

async resumeBrowserTargetClaim(payload: BrowserTargetResumeRequest): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  const parentTaskId = String(payload.parentTaskId || '').trim()
  const browserTaskId = String(payload.browserTaskId || '').trim()
  const claimId = String(payload.claimId || '').trim()
  const checkpointId = String(payload.checkpointId || '').trim()
  const wakeNonce = String(payload.wakeNonce || '').trim()
  if (!parentTaskId || !browserTaskId || !claimId || !checkpointId || !wakeNonce || !Number.isInteger(payload.oldGeneration)) {
    return { success: false, error: 'invalid_target_resume_payload', errorKind: 'invalid_payload' }
  }
  const projection = this.deps.taskProjectionStore.get(parentTaskId) as TaskProjectionRecord | null
  const takeover = projection?.humanTakeoverRef
  const claim = this.deps.browserController?.getBrowserLeaseSnapshot().claims.find((candidate) => (
    candidate.parentTaskId === parentTaskId
    && candidate.browserTaskId === browserTaskId
    && candidate.claimId === claimId
    && candidate.generation === payload.oldGeneration
    && candidate.suspensionCheckpointId === checkpointId
    && candidate.state === 'user_owned'
  ))
  if (!projection || !takeover || !claim) {
    return { success: false, error: 'target_resume_identity_stale', errorKind: 'not_resumable' }
  }
  const physicalTargetToken = this.deps.browserController?.getPhysicalTargetToken(claim.tabId) || null
  if (!physicalTargetToken) {
    return { success: false, error: 'target_resume_physical_target_stale', errorKind: 'not_resumable' }
  }
  const scope = this.deps.getConversationScope(projection.scopeId)
  if (!scope) return { success: false, error: 'Conversation scope not found', errorKind: 'scope_missing' }
  return this.resumeBrowserWorkflowFromCheckpoint(projection, scope, {
    kind: 'human_takeover',
    takeoverId: takeover.takeoverId,
    wakeNonce,
    targetClaim: {
      partition: claim.partition,
      tabId: claim.tabId,
      physicalTargetToken,
      claimId: claim.claimId,
      generation: claim.generation,
      suspensionCheckpointId: checkpointId,
      browserTaskId,
    },
  })
}

async resumeBrowserWorkflowFromCheckpoint(
  projection: TaskProjectionRecord,
  scope: ConversationScope,
  trigger:
    | {
        kind: 'human_takeover'
        takeoverId: string
        wakeNonce?: string
        targetClaim?: {
          partition: string
          tabId: string
          physicalTargetToken: string
          claimId: string
          generation: number
          suspensionCheckpointId: string
          browserTaskId: string
        }
      }
    | { kind: 'typed_wake'; requestId?: string; confirmationDecision?: 'confirmed' | 'denied' },
): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  const ownerAgentId = projection.ownerAgentId || scope.activeAgentId || scope.agent
  const newOwnerRunId = `run-${randomUUID()}`
  let ownerCommitted = false
  const settleLaunchFailure = async (error: unknown): Promise<void> => {
    if (!ownerCommitted) return
    await this.deps.agentSessionCheckpoints.settleOwnerFailure({
      parentTaskId: projection.taskId,
      failedOwnerRunId: newOwnerRunId,
      terminalReason: 'owner_launch_failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    const profile = await this.deps.executionProfileResolver.resolve(ownerAgentId)
    const executionBinding = this.deps.executionProfileResolver.createBinding({
      profile,
      runId: newOwnerRunId,
      ownerAgentIdAtStart: ownerAgentId,
      runOrigin: 'continuation',
      ownerAssignmentSource: 'continuation',
    })
    if (trigger.kind === 'human_takeover') {
      const resumed = await this.deps.agentSessionCheckpoints.completeHumanTakeover({
        taskId: projection.taskId,
        takeoverId: trigger.takeoverId,
        newOwnerRunId,
        executionBinding,
        wakeId: trigger.wakeNonce,
        targetClaim: trigger.targetClaim,
      })
      if (!resumed.createdSuccessor) return { success: true }
      getInteractionLifecycleRegistry().settle({
        interactionId: trigger.takeoverId,
        runId: projection.runId,
        agentId: projection.ownerAgentId || scope.activeAgentId || scope.agent,
        scopeId: projection.scopeId,
        disposition: 'resume_with_result',
      })
      ownerCommitted = true
    } else {
      const checkpoint = this.deps.agentSessionCheckpoints.current(projection.taskId, 'suspension')
      if (!checkpoint) throw new Error('checkpoint_resume_source_missing')
      const blockedReason = String(projection.blockedReason || '')
      const wakeKind = blockedReason === 'browser_steering_checkpoint'
        ? 'steering'
        : blockedReason === 'browser_power_confirmation_checkpoint'
          ? 'browser_power_confirmation'
        : blockedReason === 'browser_permission_checkpoint'
          ? 'browser_permission'
        : blockedReason === 'browser_owner_crash_checkpoint'
          ? 'owner_crash'
        : blockedReason === 'browser_provider_transfer_checkpoint'
          ? 'provider_transfer'
          : blockedReason === 'browser_background_checkpoint'
            ? 'background_ready'
            : blockedReason === 'browser_foreground_checkpoint'
              ? 'foreground_resume'
              : 'user_continue'
      const steeringSourceIndex = checkpoint.steeringReceiptIds.length - 1
      const powerConfirmation = wakeKind === 'browser_power_confirmation'
        ? this.deps.agentSessionCheckpoints.currentBrowserPowerConfirmation(projection.taskId)
        : null
      const permissionConfirmation = wakeKind === 'browser_permission'
        ? this.deps.agentSessionCheckpoints.currentBrowserPermissionConfirmation(projection.taskId)
        : null
      const ownerCrashRecovery = wakeKind === 'owner_crash'
        ? this.deps.agentSessionCheckpoints.currentOwnerCrashRecovery(projection.taskId)
        : null
      if (wakeKind === 'browser_power_confirmation' && !powerConfirmation) {
        throw new Error('browser_power_confirmation_receipt_missing')
      }
      if (wakeKind === 'browser_permission' && !permissionConfirmation) {
        throw new Error('browser_permission_confirmation_receipt_missing')
      }
      if (wakeKind === 'owner_crash' && !ownerCrashRecovery) {
        throw new Error('browser_owner_crash_receipt_missing')
      }
      if (
        (wakeKind === 'browser_power_confirmation' || wakeKind === 'browser_permission')
        && !trigger.confirmationDecision
      ) {
        throw new Error('browser_confirmation_decision_required')
      }
      if (
        wakeKind === 'browser_permission'
        && trigger.confirmationDecision === 'denied'
      ) {
        if (!this.deps.browserController) throw new Error('browser_controller_unavailable')
        const siteRequestId = permissionConfirmation!.request.actionIntent.siteRequestId
        const readback = this.deps.browserController.setBrowserPermission(siteRequestId, 'deny')
        if (
          readback.requestId !== siteRequestId
          || readback.state !== 'applied'
          || readback.applied !== true
          || readback.decision !== 'deny'
        ) throw new Error('browser_permission_request_expired')
      }
      const sourceId = wakeKind === 'steering'
        ? checkpoint.steeringReceiptIds[steeringSourceIndex]
        : wakeKind === 'browser_power_confirmation'
          ? powerConfirmation!.request.requestId
          : wakeKind === 'browser_permission'
            ? permissionConfirmation!.request.requestId
          : wakeKind === 'owner_crash'
            ? ownerCrashRecovery!.receipt.receiptId
          : String(trigger.requestId || `resume-${randomUUID()}`)
      const sourceDigest = wakeKind === 'steering'
        ? checkpoint.steeringReceiptDigests[steeringSourceIndex]
        : wakeKind === 'browser_power_confirmation'
          ? workflowDigest({
              parentTaskId: projection.taskId,
              checkpointId: checkpoint.checkpointId,
              basisRevision: Number(projection.revision || 0),
              kind: wakeKind,
              sourceId,
              decision: trigger.confirmationDecision,
              request: powerConfirmation!.request,
            })
          : wakeKind === 'browser_permission'
            ? workflowDigest({
                parentTaskId: projection.taskId,
                checkpointId: checkpoint.checkpointId,
                basisRevision: Number(projection.revision || 0),
                kind: wakeKind,
                sourceId,
                decision: trigger.confirmationDecision,
                request: permissionConfirmation!.request,
              })
          : wakeKind === 'owner_crash'
            ? workflowDigest({
                parentTaskId: projection.taskId,
                checkpointId: checkpoint.checkpointId,
                basisRevision: Number(projection.revision || 0),
                kind: wakeKind,
                sourceId,
                receipt: ownerCrashRecovery!.receipt,
              })
          : workflowDigest({
              parentTaskId: projection.taskId,
              checkpointId: checkpoint.checkpointId,
              basisRevision: Number(projection.revision || 0),
              kind: wakeKind,
              sourceId,
            })
      if (!sourceId || !sourceDigest) throw new Error('checkpoint_resume_wake_source_missing')
      await this.deps.agentSessionCheckpoints.resumeSuspendedBrowserWorkflow({
        taskId: projection.taskId,
        newOwnerRunId,
        executionBinding,
        wake: {
          wakeId: `wake-${randomUUID()}`,
          kind: wakeKind,
          sourceId,
          sourceDigest,
          checkpointId: checkpoint.checkpointId,
          basisRevision: Number(projection.revision || 0),
          issuedAt: new Date().toISOString(),
          ...(wakeKind === 'browser_power_confirmation' || wakeKind === 'browser_permission'
            ? { decision: trigger.confirmationDecision }
            : {}),
        },
      })
      ownerCommitted = true
    }
    const result = await this.deps.runCoordinator.runScoped({
      scope,
      message: '',
      requestId: newOwnerRunId,
      sourceMessageId: projection.requestAnchor?.messageId || null,
      taskId: projection.taskId,
      taskOrigin: projection.taskOrigin,
      runOrigin: 'continuation',
      preboundExecutionBinding: executionBinding,
      coordinators: this.deps.getDomainAdapters(),
    })
    if (!result.success) await settleLaunchFailure(result.error || 'owner_launch_failed')
    return {
      success: result.success,
      error: result.error,
      errorKind: result.errorKind,
    }
  } catch (error) {
    // silent-catch: launch failures are settled durably below and returned to the caller.
    try {
      await settleLaunchFailure(error)
    } catch (settleError) {
      // silent-catch: settlement failure is itself returned as a typed persistence failure.
      return {
        success: false,
        error: `owner_launch_failure_settlement_failed:${settleError instanceof Error ? settleError.message : String(settleError)}`,
        errorKind: 'persistence_failed',
      }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorKind: 'persistence_failed',
    }
  }
}

async respondToInteraction(payload: {
  scopeId: string
  taskId?: string
  requestId?: string
  responseText: string
  confirmed?: boolean
  continuationIntent?: ContinuationIntent | null
}): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  const responseText = String(payload.responseText || '').trim()
  if (!responseText) return { success: false, error: 'Interaction response is required' }
  const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
  if (!target) return { success: false, error: 'Conversation scope not found' }
  if (target.projection?.blockedReason === 'browser_confirmation_expired_checkpoint') {
    return {
      success: false,
      error: 'This browser confirmation expired when Ready restarted.',
      errorKind: 'stale_interaction',
    }
  }
  if (typeof payload.confirmed === 'boolean' && payload.requestId) {
    const request = (target.projection?.continuationRef as Record<string, unknown> | null)?.suspensionRequest
    const currentRequestId = request && typeof request === 'object'
      ? String((request as Record<string, unknown>).requestId || '')
      : ''
    if (currentRequestId !== payload.requestId) {
      return { success: false, error: 'This browser confirmation is no longer pending.', errorKind: 'stale_interaction' }
    }
  }
  if (
    (target.projection?.blockedReason === 'browser_power_confirmation_checkpoint'
      || target.projection?.blockedReason === 'browser_permission_checkpoint')
    && target.projection.checkpointRefs?.suspensionCheckpointId
  ) {
    if (typeof payload.confirmed !== 'boolean') {
      return { success: false, error: 'A confirmation decision is required.', errorKind: 'confirmation_required' }
    }
    return this.resumeBrowserWorkflowFromCheckpoint(target.projection, target.scope, {
      kind: 'typed_wake',
      requestId: payload.requestId,
      confirmationDecision: payload.confirmed ? 'confirmed' : 'denied',
    })
  }
  const builtIntent = buildContinuationIntent({
    projection: target.projection,
    scopeRunSummary: target.scopeRunSummary,
    incoming: payload.continuationIntent || null,
    responseText,
  })
  if (builtIntent === null && !canRespondToUserInteractionWithoutResumeHandle(target)) {
    logAgentMetric('runtime_respond_to_interaction_rejected_not_resumable', {
      scopeId: target.scope.id,
      taskId: payload.taskId || null,
    })
    return {
      success: false,
      error: 'Task is not resumable: no durable handle (childRunId, detachedTaskId, or outputDir+runStatePath).',
      errorKind: 'not_resumable',
    }
  }
  return this.deps.sendScoped({
    scopeId: target.scope.id,
    requestId: payload.requestId,
    taskId: target.projection?.taskId || target.scopeRunSummary?.taskId || payload.taskId,
    message: responseText,
    continuationIntent: builtIntent,
  })
}

resolveTaskControlTarget(
  scopeId: string,
  taskId?: string,
): {
  scope: ConversationScope
  projection: TaskProjectionRecord | null
  scopeRunSummary: ScopeRunSummary | null
} | null {
  const scope = this.deps.getConversationScope(scopeId)
  if (!scope) return null
  const scopeRunSummary = this.deps.scopeRunSummaries.get(scopeId) || null
  if (taskId) {
    return {
      scope,
      projection: this.deps.getTaskProjection(taskId),
      scopeRunSummary,
    }
  }

  const projections = this.deps.listTaskProjections(scopeId)
  const matchedProjection = [
    scopeRunSummary?.taskId || null,
    scopeRunSummary?.taskContinuation?.taskId || null,
  ]
    .filter(Boolean)
    .map((candidateTaskId) => this.deps.getTaskProjection(candidateTaskId as string))
    .find((item) => Boolean(item)) || null
  const activeProjection = projections.find((item) =>
    item.status === 'running' || item.status === 'blocked' || item.interactionState === 'resuming',
  ) || null

  return {
    scope,
    projection: matchedProjection || activeProjection || projections[0] || null,
    scopeRunSummary,
  }
}

}
