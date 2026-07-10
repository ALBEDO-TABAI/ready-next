import { buildContextUsageSnapshot } from '../../../../shared/context-usage-types'
import type {
  ExecutionTurnResult,
  RunMessage,
  TaskBudgetRuntime,
  TurnTranscriptEvent
} from '../contracts/run-contracts'
import { logAgentMetric } from '../metrics'
import { inspectDocumentTargetContent, mergeProjectionPatches } from './agent-sdk-document-utils'
import { classifySdkRuntimeError, errorMessage, isAbortError } from './agent-sdk-execution-utils'
import { releaseBudgetCheckpointFlight, taskBudgetDiagnostics } from './agent-sdk-foundation-utils'
import { messageToText } from './agent-sdk-input-context-utils'
import { publicAgentName } from './agent-sdk-model-message-utils'
import { log } from './agent-sdk-provider'
import {
  continuationHandleFromLongSkillCheckpoint,
  isCheckpointTerminalReason,
  shouldRecoverLongSkillCheckpoint,
  summarizeLongSkillCheckpoint
} from './agent-sdk-runtime-outcome-utils'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type {
  AgentSdkProviderDiagnostics,
  AgentSdkSession,
  DocumentTargetGuard,
  ReadyAgentSdkRunResult,
  RunHandle,
  RunMetaRepositoryLike,
  SdkLongSkillCheckpoint
} from './agent-sdk-types'
import { finalizeRunOutcome, writeRunCloseMetric, type RunOutcome } from './run-finalizer'
import type { TurnTerminalReason } from './turn-frame'

export async function recordAdmissionRejection(
  host: TurnOrchestratorHost,
  params: {
    name: string
    runId: string
    taskId: string
    scopeId: string | null
    status: string
    terminalReason: TurnTerminalReason
    finalText: string
    firstMessageText: string
  }
): Promise<void> {
  const kind: RunOutcome['kind'] =
    params.status === 'done'
      ? 'done'
      : params.status === 'cancelled'
        ? 'cancelled'
        : params.status === 'checkpoint'
          ? 'checkpoint'
          : 'error'
  const base = {
    runId: params.runId,
    taskId: params.taskId,
    scopeId: params.scopeId,
    durationMs: 1,
    toolCallsUsed: 0,
    initiator: 'admission',
    projectionPatch: null,
    taskBudgetRuntime: null,
    providerDiagnostics: null,
    usage: null
  }
  try {
    await finalizeRunOutcome(
      kind === 'done'
        ? { kind, ...base, terminalReason: params.terminalReason, finalText: params.finalText }
        : kind === 'checkpoint'
          ? {
              kind,
              ...base,
              continuationHandle:
                params.terminalReason === 'checkpoint_user_input' ? null : params.runId,
              terminalReason: params.terminalReason,
              finalText: params.finalText
            }
          : { kind, ...base, terminalReason: params.terminalReason },
      {
        runMetaRepository: host.getRunMetaRepositoryForFinalize(),
        taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
        learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
        writeProjectionTerminalPatch: () => {},
        writeRunCloseMetric
      }
    )
    await persistRunMetaSnapshot(host, {
      agentName: params.name,
      runId: params.runId,
      taskId: params.taskId,
      scopeId: params.scopeId,
      status: params.status,
      terminalReason: params.terminalReason,
      taskBudgetRuntime: null,
      providerDiagnostics: null,
      continuationRef: null,
      usage: null,
      firstMessageText: params.firstMessageText,
      finalText: params.finalText
    })
  } catch (error) {
    const message = errorMessage(error)
    logAgentMetric('run_meta_admission_rejection_persist_failed', {
      runId: params.runId,
      taskId: params.taskId,
      scopeId: params.scopeId,
      status: params.status,
      terminalReason: params.terminalReason,
      reason: message
    })
    log(`recordAdmissionRejection persist failed runId=${params.runId}: ${message}`)
  }
}

export async function persistRunMetaSnapshot(
  host: TurnOrchestratorHost,
  params: {
    agentName: string
    runId: string
    taskId: string
    scopeId: string | null
    status: string
    terminalReason: TurnTerminalReason | null
    taskBudgetRuntime: TaskBudgetRuntime | null
    providerDiagnostics: AgentSdkProviderDiagnostics | null
    continuationRef: Record<string, unknown> | null
    usage: ReadyAgentSdkRunResult['usage'] | null
    firstMessageText: string
    finalText: string
  }
): Promise<void> {
  let repository: RunMetaRepositoryLike | null = null
  try {
    repository = (host.runtime?.getRunMetaRepository?.() || null) as RunMetaRepositoryLike | null
  } catch {
    repository = null // silent-catch: missing repository skips the best-effort run-meta snapshot
  }
  if (!repository) return
  const budgetDiagnostics = taskBudgetDiagnostics(params.taskBudgetRuntime)
  let status = params.status || (params.terminalReason === 'done' ? 'done' : 'running')
  let terminalReason = params.terminalReason
  let preservedTaskType: string | null | undefined
  let preservedBudget: Record<string, unknown> | null | undefined
  try {
    const existing = repository.get(params.runId) as {
      status?: unknown
      terminalReason?: unknown
      taskType?: unknown
      budget?: unknown
    } | null
    const existingStatus = String(existing?.status || '')
    const terminalStatuses = new Set([
      'done',
      'error',
      'cancelled',
      'interrupted',
      'checkpoint',
      'killed'
    ])
    if (existing && terminalStatuses.has(existingStatus)) {
      preservedTaskType = (existing.taskType as string | null) ?? null
      preservedBudget = (existing.budget as Record<string, unknown> | null) ?? null
      if (!terminalStatuses.has(status)) {
        status = existingStatus
        terminalReason = (existing?.terminalReason as typeof terminalReason) || terminalReason
      }
    }
  } catch {
    // silent-catch: a read failure must not block the best-effort snapshot
  }
  const input = {
    runId: params.runId,
    taskId: params.taskId,
    scopeId: params.scopeId,
    agentId: publicAgentName(params.agentName),
    status,
    taskType:
      preservedTaskType !== undefined
        ? preservedTaskType
        : params.taskBudgetRuntime?.taskType || null,
    terminalReason,
    providerProtocol: params.providerDiagnostics?.agentProtocol || null,
    wireApi: params.providerDiagnostics?.wireApi || null,
    contextWindow: params.providerDiagnostics?.contextWindow || null,
    providerDiagnostics: params.providerDiagnostics,
    budget:
      preservedBudget !== undefined
        ? preservedBudget
        : (budgetDiagnostics.budget as Record<string, unknown> | null),
    continuationRef: params.continuationRef,
    recoveryHistory: [],
    inputTokens: params.usage?.inputTokens ?? 0,
    outputTokens: params.usage?.outputTokens ?? 0,
    totalTokens: params.usage?.totalTokens ?? 0,
    firstMessageText: params.firstMessageText.slice(0, 2_000),
    lastMessageText: params.finalText.slice(0, 2_000),
    followUpText:
      params.terminalReason && isCheckpointTerminalReason(params.terminalReason)
        ? params.terminalReason
        : null
  }
  try {
    if (repository.get(params.runId)) repository.update(params.runId, input)
    else repository.create(input)
  } catch (error) {
    log(`persist run_meta failed runId=${params.runId}: ${errorMessage(error)}`)
  }
}

export function buildExecutionTurnResult(
  host: TurnOrchestratorHost,
  params: {
    success: boolean
    finalText: string
    cancelled: boolean
    taskId: string
    usedTools: string[]
    transcriptEvents: TurnTranscriptEvent[]
    projectionPatches: Record<string, unknown>[]
    terminalReason: TurnTerminalReason
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
    usage?: ReadyAgentSdkRunResult['usage'] | null
    error?: string
    scopeRunAuthority?: ExecutionTurnResult['scopeRunAuthority']
  }
): ExecutionTurnResult {
  const taskType =
    params.taskBudgetRuntime?.taskType || host.resolveTaskTypeFromTools(params.usedTools)
  const budgetDiagnostics = taskBudgetDiagnostics(params.taskBudgetRuntime || null)
  const contextUsage = buildContextUsageSnapshot({
    inputTokens: params.usage?.inputTokens ?? null,
    windowTokens: params.providerDiagnostics?.contextWindow ?? null,
    windowSource: params.providerDiagnostics?.contextWindowSource ?? null,
    timestamp: new Date().toISOString()
  })
  return {
    success: params.success,
    status: params.cancelled
      ? 'cancelled'
      : isCheckpointTerminalReason(params.terminalReason)
        ? 'checkpoint'
        : params.success
          ? 'done'
          : 'error',
    finalText: params.finalText,
    cancelled: params.cancelled,
    usedTools: [...params.usedTools],
    error: params.error,
    taskId: params.taskId,
    taskType,
    interactionState: 'running',
    taskProjectionId: params.taskId,
    executionDiagnostics: {
      taskId: params.taskId,
      taskBudgetRuntime: params.taskBudgetRuntime || null,
      budget: budgetDiagnostics.budget,
      budgetUsagePercent: budgetDiagnostics.budgetUsagePercent,
      budgetWarningLevel: budgetDiagnostics.budgetWarningLevel,
      providerDiagnostics: params.providerDiagnostics || null,
      contextUsage,
      toolSnapshots: null
    },
    contextUsage,
    projectionTruth: {
      projectionPatch: mergeProjectionPatches(params.projectionPatches),
      transcriptEvents: params.transcriptEvents
    },
    terminalReason: params.terminalReason,
    scopeRunAuthority: params.scopeRunAuthority
  }
}

export interface TurnErrorCloseoutContext {
  host: TurnOrchestratorHost
  error: unknown
  name: string
  runId: string
  taskId: string
  sessionId?: string
  runStartedAt: number
  runHandle: RunHandle
  abortController: AbortController
  usedTools: string[]
  transcriptEvents: TurnTranscriptEvent[]
  projectionPatches: Record<string, unknown>[]
  runMetaBudgetRuntime: TaskBudgetRuntime | null
  runMetaProviderDiagnostics: AgentSdkProviderDiagnostics | null
  runMetaUsage: ReadyAgentSdkRunResult['usage'] | null
  longSkillCheckpoint: SdkLongSkillCheckpoint | null
  finalText: string
  documentTargetGuardForRecovery: DocumentTargetGuard | null
  requiresLocalDocumentExcerptForRecovery: boolean
  requiresLocalDocumentWriteForRecovery: boolean
  hasSuccessfulLocalDocumentSourceReadForRecovery: boolean
  fileReadExcerptCheckpointForRecovery: string | null
  hasSuccessfulDocumentTargetMutation: boolean
  hasSuccessfulToolProgress: boolean
  lastDocumentSaveSuccessText: string | null
  emitOutputForRun: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitStatusForRun: (status: string, terminalReason?: TurnTerminalReason | null) => void
  emitRuntimeError: (error: unknown, terminalReason: TurnTerminalReason) => void
  finalizeEarlyReturn: (params: {
    status: 'done' | 'checkpoint' | 'error' | 'cancelled'
    terminalReason: TurnTerminalReason
    finalText: string
    error?: string
    continuationHandle?: string | null
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
  }) => Promise<ExecutionTurnResult>
  finalizeBudgetCheckpointReturn: (checkpointText: string) => Promise<ExecutionTurnResult>
  buildLocalDocumentWriteBudgetCheckpoint: () => string
  buildToolProgressBudgetCheckpoint: (usedTools: string[]) => string
  buildResult: (params: Parameters<typeof buildExecutionTurnResult>[1]) => ExecutionTurnResult
}

export async function handleAgentSdkTurnError(
  ctx: TurnErrorCloseoutContext
): Promise<ExecutionTurnResult> {
  const {
    host,
    error,
    name,
    runId,
    taskId,
    sessionId,
    runStartedAt,
    runHandle,
    abortController,
    usedTools,
    transcriptEvents,
    projectionPatches,
    runMetaBudgetRuntime,
    runMetaProviderDiagnostics,
    runMetaUsage,
    finalText,
    emitOutputForRun,
    emitOutput,
    emitStatusForRun,
    emitRuntimeError,
    finalizeEarlyReturn,
    finalizeBudgetCheckpointReturn,
    buildResult
  } = ctx
  if (isAbortError(error)) {
    const abortReason = abortController.signal.reason
    const preemptedByNewerSend =
      abortReason instanceof Error && abortReason.message === 'process_restarted'
    const abortInitiator =
      runHandle.abortInitiator || (preemptedByNewerSend ? 'preempted' : 'user_stop')
    const terminalReason: TurnTerminalReason =
      abortInitiator === 'user_stop'
        ? 'cancelled_user'
        : abortInitiator === 'manual_suspend'
          ? 'manual_suspend'
          : abortInitiator === 'timeout'
            ? 'main_no_progress_timeout'
            : 'cancelled_runtime'
    const latestRunId = host.sessionManager.get(name)?.currentRun?.runId
    if (abortInitiator === 'user_stop')
      emitOutputForRun('已手动停止，进度已保存至当前会话。', 'text')
    if (abortInitiator === 'manual_suspend') {
      return finalizeEarlyReturn({
        status: 'checkpoint',
        terminalReason,
        finalText: '',
        taskBudgetRuntime: runMetaBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics
      })
    }
    await finalizeRunOutcome(
      {
        kind: abortInitiator === 'preempted' ? 'preempted' : 'cancelled',
        runId,
        taskId,
        scopeId: sessionId || null,
        durationMs: Math.max(1, Date.now() - runStartedAt),
        toolCallsUsed: usedTools.length,
        initiator: abortInitiator,
        terminalReason,
        projectionPatch: mergeProjectionPatches(projectionPatches),
        taskBudgetRuntime: runMetaBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics,
        usage: runMetaUsage
      },
      {
        runMetaRepository: host.getRunMetaRepositoryForFinalize(),
        taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
        learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
        writeProjectionTerminalPatch: (projectionPatch, reason, status) => {
          emitOutputForRun('', 'done', projectionPatch)
          emitStatusForRun(status, reason as TurnTerminalReason)
        },
        writeRunCloseMetric
      }
    )
    return buildResult({
      success: true,
      finalText: '',
      cancelled: true,
      taskId,
      usedTools,
      transcriptEvents,
      projectionPatches,
      terminalReason,
      taskBudgetRuntime: runMetaBudgetRuntime,
      providerDiagnostics: runMetaProviderDiagnostics,
      usage: runMetaUsage,
      scopeRunAuthority: preemptedByNewerSend
        ? {
            state: 'lost',
            reason: 'preempted_by_same_user',
            currentRunId: latestRunId && latestRunId !== runId ? latestRunId : null
          }
        : undefined
    })
  }

  const message = errorMessage(error)
  const checkpoint = ctx.longSkillCheckpoint
  if (/Max turns \(\d+\) exceeded/i.test(message) && shouldRecoverLongSkillCheckpoint(checkpoint)) {
    const checkpointText = finalText || summarizeLongSkillCheckpoint(checkpoint)
    if (!finalText) emitOutput(checkpointText, 'text')
    return finalizeEarlyReturn({
      status: 'checkpoint',
      terminalReason: checkpoint.terminalReason,
      finalText: checkpointText,
      continuationHandle: continuationHandleFromLongSkillCheckpoint(checkpoint)
    })
  }
  if (
    /Max turns \(\d+\) exceeded/i.test(message) &&
    ctx.documentTargetGuardForRecovery &&
    ctx.hasSuccessfulDocumentTargetMutation &&
    ctx.lastDocumentSaveSuccessText &&
    (!ctx.requiresLocalDocumentExcerptForRecovery ||
      ctx.hasSuccessfulLocalDocumentSourceReadForRecovery)
  ) {
    const contentIssue = await inspectDocumentTargetContent(ctx.documentTargetGuardForRecovery, {
      forbidFutureLeakage: ctx.requiresLocalDocumentExcerptForRecovery
    })
    if (!contentIssue) {
      const fallbackText =
        finalText || `已完成并保存到 ${ctx.documentTargetGuardForRecovery.targetName}。`
      if (!finalText) emitOutput(fallbackText, 'text')
      return finalizeEarlyReturn({
        status: 'done',
        terminalReason: 'done',
        finalText: fallbackText
      })
    }
  }
  if (
    /Max turns \(\d+\) exceeded/i.test(message) &&
    ctx.documentTargetGuardForRecovery &&
    !ctx.hasSuccessfulDocumentTargetMutation
  ) {
    return finalizeBudgetCheckpointReturn(
      `本轮工具调用次数已用完，但目标文档 ${ctx.documentTargetGuardForRecovery.targetName} 还没有发生有效写入。请继续这项任务，我会从当前文档状态接着修。`
    )
  }
  if (
    /Max turns \(\d+\) exceeded/i.test(message) &&
    ctx.fileReadExcerptCheckpointForRecovery &&
    ctx.requiresLocalDocumentWriteForRecovery &&
    !ctx.lastDocumentSaveSuccessText
  ) {
    return finalizeBudgetCheckpointReturn(ctx.buildLocalDocumentWriteBudgetCheckpoint())
  }
  if (/Max turns \(\d+\) exceeded/i.test(message) && ctx.fileReadExcerptCheckpointForRecovery) {
    return finalizeBudgetCheckpointReturn(ctx.fileReadExcerptCheckpointForRecovery)
  }
  if (/Max turns \(\d+\) exceeded/i.test(message) && ctx.hasSuccessfulToolProgress) {
    return finalizeBudgetCheckpointReturn(ctx.buildToolProgressBudgetCheckpoint(usedTools))
  }
  const failure = classifySdkRuntimeError(error)
  emitOutput(`${failure.userMessagePrefix}: ${message}`, 'error')
  emitRuntimeError(error, failure.terminalReason)
  await finalizeRunOutcome(
    {
      kind: 'error',
      runId,
      taskId,
      scopeId: sessionId || null,
      durationMs: Math.max(1, Date.now() - runStartedAt),
      toolCallsUsed: usedTools.length,
      initiator: 'error',
      terminalReason: failure.terminalReason,
      projectionPatch: mergeProjectionPatches(projectionPatches),
      taskBudgetRuntime: runMetaBudgetRuntime,
      providerDiagnostics: runMetaProviderDiagnostics,
      usage: runMetaUsage
    },
    {
      runMetaRepository: host.getRunMetaRepositoryForFinalize(),
      taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
      learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
      writeProjectionTerminalPatch: (projectionPatch, reason, status) => {
        emitOutputForRun('', 'done', projectionPatch)
        emitStatusForRun(status, reason as TurnTerminalReason)
      },
      writeRunCloseMetric
    }
  )
  return buildResult({
    success: false,
    error: message,
    finalText: '',
    cancelled: false,
    taskId,
    usedTools,
    transcriptEvents,
    projectionPatches,
    terminalReason: failure.terminalReason,
    taskBudgetRuntime: runMetaBudgetRuntime,
    providerDiagnostics: runMetaProviderDiagnostics,
    usage: runMetaUsage
  })
}

export async function finalizeAgentSdkTurnLifecycle(ctx: {
  host: TurnOrchestratorHost
  name: string
  runId: string
  taskId: string
  sessionId?: string
  status: string
  terminalReason: TurnTerminalReason | null
  taskBudgetRuntime: TaskBudgetRuntime | null
  providerDiagnostics: AgentSdkProviderDiagnostics | null
  continuationRef: Record<string, unknown> | null
  usage: ReadyAgentSdkRunResult['usage'] | null
  content: RunMessage
  finalText: string
  session: AgentSdkSession
  runHandle: RunHandle
  finishBackgroundTaskTerminalReminderRun: () => void
  ownsBudgetCheckpointFlight: boolean
  budgetCheckpointFlightKey: string | null
}): Promise<void> {
  try {
    await persistRunMetaSnapshot(ctx.host, {
      agentName: ctx.name,
      runId: ctx.runId,
      taskId: ctx.taskId,
      scopeId: ctx.sessionId || null,
      status: ctx.status,
      terminalReason: ctx.terminalReason,
      taskBudgetRuntime: ctx.taskBudgetRuntime,
      providerDiagnostics: ctx.providerDiagnostics,
      continuationRef: ctx.continuationRef,
      usage: ctx.usage,
      firstMessageText: messageToText(ctx.content),
      finalText: ctx.finalText
    })
    await ctx.host.runLifecycle.finalizeRun(ctx.name, ctx.session, ctx.runHandle)
  } finally {
    ctx.finishBackgroundTaskTerminalReminderRun()
    if (ctx.ownsBudgetCheckpointFlight) releaseBudgetCheckpointFlight(ctx.budgetCheckpointFlightKey)
  }
}
