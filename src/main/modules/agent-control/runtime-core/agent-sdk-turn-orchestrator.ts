import { MemorySession } from '@openai/agents'
import { randomUUID } from 'crypto'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import {
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  resolveMaxOutputTokens
} from '../../../../shared/ai-providers'
import { resolveModelContextWindow } from '../../../../shared/context-budget-types'
import { buildAgentSpawnContextFromAIConfig } from '../../skills-runtime/agent-context-source'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import { normalizeSessionSnapshotForSeed } from '../compaction/compact-agent-input'
import type {
  ExecutionTurnResult,
  MultimodalBlock,
  RunMessage,
  TaskBudgetRuntime,
  TaskProjectionRecord,
  TurnTranscriptEvent
} from '../contracts/run-contracts'
import {
  computeCapabilityFloors,
  enforceCapabilityFloors
} from '../domain-adapters/capability-floors'
import { buildPreparedSkillTurnTruth, preparedSkillDigest } from '../skills/prepared-skill-turn'
import type { CheckInRecord } from '../quality/task-adjudicator'
import { loadScopeSessionSnapshot } from '../session/scope-session-snapshot'
import { beginBackgroundTaskTerminalReminderRun } from '../system-reminders/background-task-terminal-reminder'
import { createTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import { sanitizeAssistantText } from '../tools-runtime/tool-call-text-guard'
import { createEmptyActiveFrameContext } from '../tools-runtime/tool-runtime'
import { mergeProjectionPatches } from './agent-sdk-document-utils'
import {
  errorMessage,
  hasCurrentDocumentContextResource,
  hasLocalDocumentResource
} from './agent-sdk-execution-utils'
import {
  SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS,
  acquireBudgetCheckpointFlight,
  releaseBudgetCheckpointFlight,
  resolveAgentSdkProviderDiagnostics,
  resolvePureUserTextForClassification
} from './agent-sdk-foundation-utils'
import { messageToText } from './agent-sdk-input-context-utils'
import {
  continuationChildRunId,
  continuationRunStatePath,
  nonEmptyString
} from './agent-sdk-model-message-utils'
import { resolveAgentSdkProvider } from './agent-sdk-provider'
import { resolveConfiguredModelDef } from './agent-sdk-provider-utils'
import {
  projectionPatchFromChildClose,
  summarizeChildResume
} from './agent-sdk-runtime-outcome-utils'
import type {
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  DocumentTargetGuard,
  ObservedDocumentToolTarget,
  ReadyAgentSdkRunResult,
  SdkLongSkillCheckpoint
} from './agent-sdk-types'
import {
  finalizeRunOutcome,
  reconcileTerminalTaskBudgetRuntime,
  writeRunCloseMetric,
  type RunFinalizerDeps,
} from './run-finalizer'
import type { TurnTerminalReason } from './turn-frame'
import {
  buildExecutionTurnResult,
  finalizeAgentSdkTurnLifecycle,
  handleAgentSdkTurnError,
  recordAdmissionRejection
} from './agent-sdk-turn-closeout'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import {
  executeAgentSdkPreparedTurn,
  type AgentSdkPreparedTurnState
} from './agent-sdk-turn-execution'
import { prepareAgentSdkTurn } from './agent-sdk-turn-preparation'
import {
  isExplicitToolEnableConsentMessage,
  maybeHandleToolCapabilityConsent
} from './tool-capability-consent'
import { ToolConsentRetryCoordinator } from './tool-consent-retry-coordinator'
import { resolveBeginRunRejection } from './agent-sdk-admission-outcome'
import {
  buildLocalDocumentWriteBudgetCheckpoint,
  buildToolProgressBudgetCheckpoint
} from './agent-sdk-budget-messages'

export type { TurnOrchestratorHost } from './agent-sdk-turn-context'

/**
 * Owns the model/tool turn loop and funnel-pinned finalizers. The stability gate
 * enforces the run-finalize invariants against this file.
 */
export class AgentSdkTurnOrchestrator {
  private readonly toolConsentRetries = new ToolConsentRetryCoordinator()

  constructor(private readonly host: TurnOrchestratorHost) {}

  async sendMessage(
    name: string,
    content: string | MultimodalBlock[],
    requestId?: string,
    executionOptions?: AgentSdkExecutionOptions
  ): Promise<ExecutionTurnResult> {
    const runStartedAt = Date.now()
    const runId = requestId || randomUUID()
    let lastRollingCheckpointToolCalls = 0
    // S5-1: lazy restore — a missing session after a process restart seeds
    // from the persisted scope snapshot with an explicit notice; a corrupt
    // snapshot resets with an explicit notice. Never silent amnesia.
    let sessionRestoreNotice: string | null = null
    if (!this.host.sessionManager.has(name)) {
      this.host.newSession(name)
      const restored = loadScopeSessionSnapshot(name)
      if (restored.ok && restored.items.length > 0) {
        const seeded = this.host.sessionManager.get(name)
        if (seeded) {
          seeded.sdkSession = new MemorySession({
            sessionId: name,
            initialItems: normalizeSessionSnapshotForSeed(restored.items as never[])
          })
          sessionRestoreNotice = '已恢复上次会话上下文（应用此前重启过）。如与当前请求无关可忽略。'
        }
      } else if (!restored.ok && restored.reason === 'corrupt') {
        sessionRestoreNotice = '上次会话快照损坏，会话已重置（无法恢复早前上下文）。'
      }
    }
    const taskId = executionOptions?.taskId || `task-${runId}`
    const sessionId =
      executionOptions?.publicSessionId ||
      this.host.sessionManager.extractSessionIdFromInternalName(name)
    const transcriptEvents: TurnTranscriptEvent[] = []
    const usedTools: string[] = []
    const toolArgsByName = new Map<string, Record<string, unknown>[]>()
    const projectionPatches: Record<string, unknown>[] = []
    const activeFrame = createEmptyActiveFrameContext()
    let longSkillCheckpoint: SdkLongSkillCheckpoint | null = null
    let finalText = ''
    let documentTargetGuardForRecovery: DocumentTargetGuard | null = null
    let requiresLocalDocumentExcerptForRecovery = false
    let requiresLocalDocumentWriteForRecovery = false
    let hasSuccessfulLocalDocumentSourceReadForRecovery = false
    let fileReadExcerptCheckpointForRecovery: string | null = null
    let hasSuccessfulDocumentTargetMutation = false
    let observedDocumentMutationTarget: ObservedDocumentToolTarget | null = null
    let observedDocumentMutationConflict = false
    let observedDocumentMutationMissingTarget = false
    let hasSuccessfulToolProgress = false
    let lastDocumentSaveSuccessText: string | null = null
    let actionAnnouncementSteered = false
    // D2 — 验收标准自检每 run 只注入一次（首个模型调用）。
    let criteriaSelfCheckInjected = false
    let skillClarificationSteered = false
    let runMetaStatus: string = 'running'
    let runMetaTerminalReason: TurnTerminalReason | null = null
    let runMetaBudgetRuntime: TaskBudgetRuntime | null = null
    let runMetaProviderDiagnostics: AgentSdkProviderDiagnostics | null = null
    let runMetaContinuationRef: Record<string, unknown> | null = null
    let runMetaUsage: ReadyAgentSdkRunResult['usage'] | null = null
    const continuationIntent = executionOptions?.continuationIntent
    const requestedCheckpointPath = continuationRunStatePath(executionOptions)
    const hasNonBudgetContinuation = Boolean(
      continuationChildRunId(executionOptions) ||
      continuationIntent?.detachedTaskId ||
      continuationIntent?.taskRunId ||
      continuationIntent?.jobId
    )
    const checkpointLoad =
      hasNonBudgetContinuation || !requestedCheckpointPath
        ? ({ status: 'absent' } as const)
        : await this.host.runLifecycle.loadBudgetCheckpointState({
            ...executionOptions,
            taskId,
            publicSessionId: sessionId
          })
    if (checkpointLoad.status === 'invalid') {
      const userMessage = '续跑检查点无法验证，已停止恢复以避免从头重复执行。'
      await recordAdmissionRejection(this.host, {
        name,
        runId,
        taskId,
        scopeId: sessionId || null,
        status: 'error',
        terminalReason: 'persistence_failed',
        finalText: '',
        firstMessageText: messageToText(content as RunMessage)
      })
      return buildExecutionTurnResult(this.host, {
        success: false,
        error: `${userMessage} (${checkpointLoad.reason})`,
        finalText: '',
        cancelled: false,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason: 'persistence_failed'
      })
    }
    const checkpointRestore = checkpointLoad.status === 'loaded' ? checkpointLoad.restore : null
    const budgetCheckpointFlightKey = checkpointRestore?.runStatePath || null
    let ownsBudgetCheckpointFlight = false

    if (budgetCheckpointFlightKey) {
      ownsBudgetCheckpointFlight = acquireBudgetCheckpointFlight(budgetCheckpointFlightKey)
      if (!ownsBudgetCheckpointFlight) {
        await recordAdmissionRejection(this.host, {
          name,
          runId,
          taskId,
          scopeId: sessionId || null,
          status: 'checkpoint',
          terminalReason: 'checkpoint_budget',
          finalText: '这项任务已经在继续执行，请等待当前续跑完成。',
          firstMessageText: messageToText(content as RunMessage)
        })
        return buildExecutionTurnResult(this.host, {
          success: true,
          finalText: '这项任务已经在继续执行，请等待当前续跑完成。',
          cancelled: false,
          taskId,
          usedTools,
          transcriptEvents,
          projectionPatches,
          terminalReason: 'checkpoint_budget',
          taskBudgetRuntime: checkpointRestore!.taskBudgetRuntime
        })
      }
    }

    const begin = await this.host.runLifecycle.beginRun({ name, runId, sessionId })
    if (!begin.ok) {
      if (ownsBudgetCheckpointFlight) releaseBudgetCheckpointFlight(budgetCheckpointFlightKey)
      const rejection = resolveBeginRunRejection(begin.reason)
      if (begin.reason !== 'active_owner_exists') {
        await recordAdmissionRejection(this.host, {
          name,
          runId,
          taskId,
          scopeId: sessionId || null,
          status: rejection.status,
          terminalReason: rejection.terminalReason,
          finalText: '',
          firstMessageText: messageToText(content as RunMessage)
        })
      }
      return buildExecutionTurnResult(this.host, {
        success: false,
        error: begin.message,
        finalText: '',
        cancelled: rejection.cancelled,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason: rejection.terminalReason,
        scopeRunAuthority:
          begin.reason === 'superseded'
            ? {
                state: 'lost',
                reason: 'superseded_by_newer_send',
                currentRunId: begin.currentRunId ?? null
              }
            : undefined
      })
    }
    const { session, runHandle, abortController, runGeneration } = begin
    // This remains the only committed/shared SDK session until the canonical
    // core closeout succeeds.  Checkpoint restore is a run-local seed only.
    const committedPublicSession = runHandle.capturedSession
    const checkpointRepository = this.host.runtime?.getAgentSessionCheckpointRepository?.()
    const durableCheckpoint = checkpointRepository
      && this.host.runtime?.getTaskProjectionStoreForFinalize?.()?.get(taskId)
      ? checkpointRepository.current(taskId, 'suspension')
        || checkpointRepository.current(taskId, 'clean_base')
      : null
    const finishBackgroundTaskTerminalReminderRun = beginBackgroundTaskTerminalReminderRun(
      sessionId,
      taskId
    )
    const effectiveExecutionOptions: AgentSdkExecutionOptions | undefined = checkpointRestore
      ? {
          ...(executionOptions || {}),
          taskBudgetRuntime:
            executionOptions?.taskBudgetRuntime ?? checkpointRestore.taskBudgetRuntime
        }
      : executionOptions
    // Intent and transaction classification only consume the user's envelope text.
    const pureUserTurnText = resolvePureUserTextForClassification(
      effectiveExecutionOptions?.requestEnvelope,
      messageToText(content as RunMessage)
    )
    if (sessionId && !isExplicitToolEnableConsentMessage(pureUserTurnText)) {
      this.toolConsentRetries.discard(sessionId)
    }
    if (checkpointRestore) {
      const restoredSession = new MemorySession({
        sessionId: name,
        initialItems: checkpointRestore.sessionSnapshot
      })
      runHandle.capturedSession = restoredSession
    } else if (durableCheckpoint) {
      const restoredSession = new MemorySession({
        sessionId: `${name}:checkpoint:${durableCheckpoint.checkpointId}`,
        initialItems: durableCheckpoint.finalInput,
      })
      runHandle.capturedSession = restoredSession
      sessionRestoreNotice = '已从上一个完整操作边界恢复任务。'
    }

    const isCurrentRun = (): boolean => {
      const latest = this.host.sessionManager.get(name)
      return Boolean(
        latest && latest.generation === runGeneration && latest.currentRun?.runId === runId
      )
    }
    const emitOutputForRun = (
      chunk: string,
      type: string,
      projectionPatch?: Record<string, unknown> | null,
      canonicalReceipt?: CanonicalAssistantMessageReceipt,
    ): void => {
      const safeChunk =
        type === 'text'
          ? sanitizeAssistantText(chunk, {
              sessionId: sessionId || undefined,
              source: 'transcript_emit'
            })
          : chunk
      if (type === 'text' && !safeChunk) return
      transcriptEvents.push({
        kind: 'output',
        type,
        chunk: safeChunk,
        projectionPatch: projectionPatch || null
      })
      this.host.emit('output', {
        agent: name,
        sessionId,
        runId,
        taskId,
        chunk: safeChunk,
        type,
        projectionPatch: projectionPatch || null,
        ...(canonicalReceipt || {}),
      })
    }
    // P0-1 (2026-07-02 P0 visibility batch) — response-boundary release for
    // hold-until-final turns. A native tool execution proves the response
    // that produced the buffered narration cannot become the run-final
    // clarification text (the guard only converts run-final text), so the
    // buffer flushes right before each tool row. Armed per model call and
    // disarmed the moment runAgent settles: post-run tool executions
    // (leaked-call recovery) must never flush the guard-pending final text.
    const nativeTextToolBoundaryFlush: { current: (() => void) | null } = { current: null }
    const emitOutput = (
      chunk: string,
      type: string,
      projectionPatch?: Record<string, unknown> | null
    ): void => {
      if (!isCurrentRun()) return
      if (type === 'tool_use') nativeTextToolBoundaryFlush.current?.()
      emitOutputForRun(chunk, type, projectionPatch)
    }
    // P0-3 (2026-07-02 P0 visibility batch) — pre-first-event heartbeats.
    // Phase stays 'planning' (no new enum value) and only latestText
    // progresses; publishScopeRunEvent reuses the runtime's recorded
    // scope-run channel, so this adds zero IPC surface. isCurrentRun keeps a
    // superseded run's late heartbeat away from the newer run's visible
    // state (run-continuity contract).
    const emitHeartbeat = (text: string): void => {
      if (!isCurrentRun() || !sessionId) return
      this.host.runtime?.publishScopeRunEvent?.({
        type: 'updated',
        scopeId: sessionId,
        agent: name,
        runId,
        ...(taskId ? { taskId } : {}),
        phase: 'planning',
        latestText: text,
        timestamp: new Date().toISOString()
      })
    }
    const emitStatusForRun = (status: string, terminalReason?: TurnTerminalReason | null): void => {
      runMetaStatus = status
      if (terminalReason !== undefined) runMetaTerminalReason = terminalReason || null
      transcriptEvents.push({ kind: 'status', status, terminalReason: terminalReason || null })
      this.host.emit('status', {
        agent: name,
        sessionId,
        runId,
        status,
        ...(typeof terminalReason === 'undefined' ? {} : { terminalReason }),
        isMock: false
      })
    }
    const emitStatus = (status: string, terminalReason?: TurnTerminalReason | null): void => {
      if (!isCurrentRun()) return
      emitStatusForRun(status, terminalReason)
    }
    const emitRuntimeError = (error: unknown, terminalReason: TurnTerminalReason): void => {
      if (!isCurrentRun()) return
      const message = errorMessage(error)
      transcriptEvents.push({ kind: 'error', error: message })
      this.host.emit('error', {
        agent: name,
        sessionId,
        runId,
        error: message,
        type: 'runtime',
        errorKind: terminalReason,
        recoverable: false
      })
    }
    let preparedTurnState: AgentSdkPreparedTurnState | null = null
    const syncOuterFromPreparedTurn = (): void => {
      if (!preparedTurnState) return
      runMetaBudgetRuntime = preparedTurnState.runMetaBudgetRuntime
      runMetaProviderDiagnostics = preparedTurnState.runMetaProviderDiagnostics
      runMetaContinuationRef = preparedTurnState.runMetaContinuationRef
      runMetaUsage = preparedTurnState.runMetaUsage
      finalText = preparedTurnState.finalText
    }
    const finalizeEarlyReturn = async (params: {
      status: 'done' | 'error' | 'cancelled' | 'checkpoint'
      terminalReason: TurnTerminalReason
      finalText: string
      error?: string
      continuationHandle?: string | null
      taskBudgetRuntime?: TaskBudgetRuntime | null
      providerDiagnostics?: AgentSdkProviderDiagnostics | null
      initiator?: string
    }): Promise<ExecutionTurnResult> => {
      const requestedBudgetRuntime = params.taskBudgetRuntime ?? runMetaBudgetRuntime
      if (
        params.status === 'done'
        && usedTools.length === 0
        && (!requestedBudgetRuntime || requestedBudgetRuntime.bootstrapBudget)
      ) {
        projectionPatches.push({ taskType: 'direct_answer', module: 'system' })
      }
      const projectionPatch = mergeProjectionPatches(projectionPatches) || {}
      const projectedContinuation =
        projectionPatch.taskContinuation && typeof projectionPatch.taskContinuation === 'object'
          ? (projectionPatch.taskContinuation as Record<string, unknown>)
          : projectionPatch.continuationRef && typeof projectionPatch.continuationRef === 'object'
            ? (projectionPatch.continuationRef as Record<string, unknown>)
            : null
      const effectiveBudgetRuntime = reconcileTerminalTaskBudgetRuntime(
        requestedBudgetRuntime,
        projectionPatch,
        usedTools.length
      )
      const effectiveProviderDiagnostics = params.providerDiagnostics ?? runMetaProviderDiagnostics
      finalText = params.finalText
      runMetaBudgetRuntime = effectiveBudgetRuntime
      runMetaProviderDiagnostics = effectiveProviderDiagnostics
      runMetaContinuationRef =
        params.status === 'checkpoint' ? projectedContinuation || runMetaContinuationRef : null
      if (preparedTurnState) {
        preparedTurnState.finalText = finalText
        preparedTurnState.runMetaBudgetRuntime = runMetaBudgetRuntime
        preparedTurnState.runMetaProviderDiagnostics = runMetaProviderDiagnostics
        preparedTurnState.runMetaContinuationRef = runMetaContinuationRef
        preparedTurnState.runMetaUsage = runMetaUsage
      }
      const base = {
        runId,
        taskId,
        scopeId: sessionId || null,
        durationMs: Math.max(1, Date.now() - runStartedAt),
        toolCallsUsed: usedTools.length,
        initiator: params.initiator || params.status,
        projectionPatch,
        taskBudgetRuntime: effectiveBudgetRuntime,
        providerDiagnostics: effectiveProviderDiagnostics,
        usage: runMetaUsage,
        canonicalMessageReceipt: params.status === 'checkpoint' ? preparedTurnState?.checkpointCanonicalReceipt || null : null,
      }
      const deps = {
        runMetaRepository: this.host.getRunMetaRepositoryForFinalize(),
        taskProjectionStore: this.host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
        learnFromCheckIn: (input: {
          checkIn: CheckInRecord
          projection: TaskProjectionRecord
          now: Date
        }) => this.host.learnSiteCardsFromCheckIn(input),
        commitCanonicalCoreCloseout: this.host.runtime
          ? (input: Parameters<NonNullable<RunFinalizerDeps['commitCanonicalCoreCloseout']>>[0]) =>
              this.host.runtime!.commitCanonicalCoreCloseout(input)
          : undefined,
        writeProjectionTerminalPatch: (
          patch: Record<string, unknown> | null,
          terminalReason: string,
          status: string,
          canonicalReceipt?: CanonicalAssistantMessageReceipt,
        ) => {
          emitOutputForRun('', 'done', patch, canonicalReceipt)
          emitStatusForRun(status, terminalReason as TurnTerminalReason)
        },
        writeRunCloseMetric
      }
      const finalized =
        params.status === 'done'
          ? await finalizeRunOutcome(
              {
                kind: 'done',
                ...base,
                finalText: params.finalText
              },
              deps
            )
          : params.status === 'checkpoint'
            ? await finalizeRunOutcome(
                {
                  kind: 'checkpoint',
                  ...base,
                  continuationHandle: params.continuationHandle || null,
                  terminalReason: params.terminalReason,
                  finalText: params.finalText
                },
                deps
              )
            : await finalizeRunOutcome(
                {
                  kind: params.status === 'cancelled' ? 'cancelled' : 'error',
                  ...base,
                  terminalReason: params.terminalReason,
                  finalText: params.finalText,
                },
                deps
              )
      const terminalReason = finalized.terminalReason as TurnTerminalReason
      const cancelled = finalized.status === 'cancelled'
      const success = finalized.status !== 'error'
      return buildExecutionTurnResult(this.host, {
        success,
        error: success ? undefined : params.error,
        finalText: finalized.canonicalMessage?.content ?? params.finalText,
        cancelled,
        taskId,
        usedTools,
        transcriptEvents,
        projectionPatches,
        terminalReason,
        taskBudgetRuntime: effectiveBudgetRuntime,
        providerDiagnostics: effectiveProviderDiagnostics,
        usage: runMetaUsage,
        canonicalMessage: finalized.canonicalMessage,
        canonicalMessageDigest: finalized.canonicalMessageDigest,
      })
    }
    let checkpointRequiredCapabilityGroups: string[] = []
    let checkpointRequiredToolNames: string[] = []
    const finalizeBudgetCheckpointReturn = async (
      checkpointText: string
    ): Promise<ExecutionTurnResult> => {
      const checkpointBudgetRuntime = runMetaBudgetRuntime || createTaskBudgetRuntime('short_task')
      runMetaBudgetRuntime = checkpointBudgetRuntime
      const checkpoint = await this.host.runLifecycle.writeBudgetCheckpointState({
        agentName: name,
        sessionId,
        runId,
        taskId,
        taskBudgetRuntime: checkpointBudgetRuntime,
        runHandle,
        usedTools,
        requiredCapabilityGroups: checkpointRequiredCapabilityGroups,
        requiredToolNames: checkpointRequiredToolNames,
        lastUserMessage: pureUserTurnText,
        terminalReason: 'checkpoint_budget',
        resumeKind: 'paused'
      })
      runMetaContinuationRef =
        checkpoint.projectionPatch.taskContinuation &&
        typeof checkpoint.projectionPatch.taskContinuation === 'object'
          ? (checkpoint.projectionPatch.taskContinuation as Record<string, unknown>)
          : null
      projectionPatches.push(checkpoint.projectionPatch)
      finalText = checkpointText
      emitOutput(finalText, 'text', checkpoint.projectionPatch)
      return finalizeEarlyReturn({
        status: 'checkpoint',
        terminalReason: 'checkpoint_budget',
        finalText,
        continuationHandle: checkpoint.runStatePath,
        taskBudgetRuntime: checkpointBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics
      })
    }

    emitStatus('working')
    emitHeartbeat('正在理解需求…')

    try {
      const configDetail = this.host.loadAIConfig()
      if (!configDetail.ok) {
        const userMessage =
          configDetail.reason === 'json_corrupt'
            ? 'AI 配置已损坏（JSON 解析失败），请前往设置页重置'
            : 'AI 配置读取失败（数据库错误），请稍后重试或检查日志'
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason:
            configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed',
          error: userMessage,
          finalText: userMessage
        })
      }
      if (!configDetail.config?.apiKey) {
        const userMessage = '未配置 API Key，请前往设置页配置'
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_config',
          error: userMessage,
          finalText: userMessage
        })
      }

      const normalizedConfig = normalizeAIConfig(configDetail.config)
      const { provider, model } = resolveAgentSdkProvider(normalizedConfig,
        { fetchWithTimeout: this.host.fetchWithTimeout, onModelStreamActivity: () => runHandle.noteModelStreamActivity?.() })
      const maxOutputTokens = resolveMaxOutputTokens(normalizedConfig)
      const capabilities = resolveAIConfigCapabilities(normalizedConfig)
      const modelDef = resolveConfiguredModelDef(normalizedConfig, capabilities?.baseUrl)
      const contextWindowTokens = resolveModelContextWindow(normalizedConfig, modelDef)
      session.contextWindowTokens = contextWindowTokens
      if (capabilities) {
        runMetaProviderDiagnostics = resolveAgentSdkProviderDiagnostics({
          config: normalizedConfig,
          capabilities,
          modelDef,
          contextWindowTokens
        })
      }
      const useTextToolBridge = capabilities?.toolCallTransport === 'text'
      const agentContext = buildAgentSpawnContextFromAIConfig(normalizedConfig, {
        baseUrl: String(capabilities?.baseUrl || normalizedConfig.baseUrl || '').trim()
      })
      const resumeChildRunId = continuationChildRunId(effectiveExecutionOptions)
      if (resumeChildRunId) {
        usedTools.push('skill_child_resume')
        transcriptEvents.push({
          kind: 'tool_action',
          tool: 'skill_child_resume',
          args: { childRunId: resumeChildRunId }
        })
        this.host.emit('toolAction', {
          agent: name,
          sessionId,
          runId,
          tool: 'skill_child_resume',
          args: { childRunId: resumeChildRunId }
        })
        emitOutput(`正在继续技能任务 ${resumeChildRunId}。`, 'text')
        const resumed = await this.host.resumeSkillChildRun(resumeChildRunId, { agentContext })
        const waited = resumed.closeEvent
          ? null
          : await this.host.waitForSkillChildRunClose(resumed.childRunId, {
              timeoutMs: SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS,
              signal: abortController.signal
            })
        const close = resumed.closeEvent || (waited?.kind === 'closed' ? waited.closeEvent : null)
        const closeProjectionPatch = projectionPatchFromChildClose(close)
        if (closeProjectionPatch) {
          projectionPatches.push(closeProjectionPatch)
        }
        const outcome = summarizeChildResume(resumed.childRunId, close)
        finalText = outcome.message
        emitOutput(
          outcome.message,
          outcome.status === 'error' ? 'error' : 'text',
          closeProjectionPatch
        )
        const childContinuation = closeProjectionPatch?.taskContinuation as
          | Record<string, unknown>
          | undefined
        return finalizeEarlyReturn({
          status: outcome.status,
          terminalReason: outcome.terminalReason,
          error: outcome.status === 'error' ? outcome.message : undefined,
          finalText,
          continuationHandle:
            outcome.status === 'checkpoint'
              ? nonEmptyString(childContinuation?.runStatePath) ||
                nonEmptyString(childContinuation?.childRunId) ||
                resumed.childRunId
              : null
        })
      }
      const preparedTurn = prepareAgentSdkTurn({
        host: this.host,
        content: content as RunMessage,
        effectiveExecutionOptions,
        checkpointRestore,
        durableCheckpoint,
        activeFrame,
        sessionId,
        runId,
        taskId,
        config: configDetail.config,
        runMetaBudgetRuntime,
        runMetaProviderDiagnostics,
        emitOutput,
        finalizeEarlyReturn
      })
      if (preparedTurn.terminalResult) return await preparedTurn.terminalResult
      const {
        skillCatalogSnapshot,
        skillHintRelevanceForTurn,
        documentTargetGuard,
        requiresLocalDocumentExcerpt,
        preferCurrentDocumentRead,
        requiresLocalDocumentWrite,
        providerContent,
        requestedCapabilityConflicts,
        turnFollowup
      } = preparedTurn
      let {
        authorization,
        skillSurface,
        skillIdentity,
        preNarrowingToolDefinitions,
        toolDefinitions,
      } = preparedTurn
      if (preparedTurn.documentTargetHydration) await preparedTurn.documentTargetHydration
      if (capabilities) {
        const providerToolsBlocked = requestedCapabilityConflicts.some(
          (conflict) => conflict.reason === 'provider_disabled_tools'
        )
        if (
          sessionId &&
          providerToolsBlocked &&
          !isExplicitToolEnableConsentMessage(pureUserTurnText)
        ) {
          this.toolConsentRetries.remember({
            scopeId: sessionId,
            sourceRunId: runId,
            agentName: name,
            content,
            taskId,
            executionOptions: effectiveExecutionOptions,
          })
        }
        const consentRetryDispatch = sessionId
          ? this.toolConsentRetries.createDispatch(sessionId, this.host.dispatchToolConsentRetry)
          : undefined
        const consentResult = await maybeHandleToolCapabilityConsent({
          conflicts: requestedCapabilityConflicts,
          supportsToolCalls: capabilities.supportsToolCalls,
          currentConfig: capabilities.config,
          activeProfileId: configDetail.activeProfileId ?? null,
          localSettingsConsentAllowed:
            !(this.host.runtime?.isScopeChannelBound?.(sessionId) ?? false),
          userText: pureUserTurnText,
          agentName: name,
          sessionId,
          runId,
          taskId,
          signal: abortController.signal,
          emitOutput,
          finalizeEarlyReturn,
          setActiveToolUseMode: this.host.setActiveToolUseMode,
          onEnabledAfterFinalize: consentRetryDispatch
        })
        if (consentResult) {
          if (sessionId) this.toolConsentRetries.discard(sessionId)
          return consentResult
        }
      }
      documentTargetGuardForRecovery = documentTargetGuard
      requiresLocalDocumentExcerptForRecovery = requiresLocalDocumentExcerpt
      requiresLocalDocumentWriteForRecovery = requiresLocalDocumentWrite
      // P1-3 不变量：管线末端 surface ⊇ floors。任何收窄掏空地板项 → 响亮回退并从收窄前面补回；
      //   floors 只含 skill/文档读取工具（永不含 browser），故补回不会撤销 S4-2 等安全收窄。
      const turnCapabilityFloors = computeCapabilityFloors({
        authorization,
        hasLocalDocumentResource: hasLocalDocumentResource(
          content as RunMessage,
          effectiveExecutionOptions?.requestEnvelope
        ),
        hasCurrentDocumentContext: hasCurrentDocumentContextResource(
          effectiveExecutionOptions?.requestEnvelope
        )
      })
      const floorEnforcement = enforceCapabilityFloors(
        toolDefinitions,
        turnCapabilityFloors,
        preNarrowingToolDefinitions
      )
      if (floorEnforcement.missing.length > 0) {
        appendToolCapabilityLog(
          [
            '[tool_capability]',
            'stage=tool_surface_floor_violation',
            `missing=${floorEnforcement.missing.join('|')}`
          ].join(' ')
        )
      }
      toolDefinitions = floorEnforcement.definitions
      const requestAnchorDigest = this.host.runtime
        ?.getTaskProjectionStoreForFinalize?.()
        ?.get(taskId)
        ?.requestAnchor
        ?.snapshotDigest
        || preparedSkillDigest({
          requestEnvelope: effectiveExecutionOptions?.requestEnvelope ?? null,
          pureUserTurnText,
        })
      const preparedSkillTurn = buildPreparedSkillTurnTruth({
        identity: skillIdentity,
        authorization,
        requestOrResourceAnchorDigest: requestAnchorDigest,
        floors: turnCapabilityFloors,
        surface: skillSurface,
      })
      preparedTurnState = {
        actionAnnouncementSteered,
        criteriaSelfCheckInjected,
        fileReadExcerptCheckpointForRecovery,
        finalText,
        hasSuccessfulDocumentTargetMutation,
        hasSuccessfulLocalDocumentSourceRead: false,
        hasSuccessfulLocalDocumentSourceReadForRecovery,
        hasSuccessfulToolProgress,
        lastDocumentSaveFailure: null,
        lastDocumentSaveSuccessText,
        lastRollingCheckpointToolCalls,
        longSkillCheckpoint,
        newDocumentNeedsSave: false,
        observedDocumentMutationConflict,
        observedDocumentMutationMissingTarget,
        observedDocumentMutationTarget,
        runMetaBudgetRuntime,
        runMetaContinuationRef,
        runMetaProviderDiagnostics,
        runMetaUsage,
        sessionRestoreNotice,
        skillClarificationSteered,
        checkpointCanonicalReceipt: null, finishProviderTransferCheckpoint: null,
      }
      const executionResult = await executeAgentSdkPreparedTurn({
        state: preparedTurnState,
        host: this.host,
        name,
        runId,
        taskId,
        sessionId,
        runStartedAt,
        content: content as RunMessage,
        pureUserTurnText,
        effectiveExecutionOptions,
        checkpointRestore,
        checkpointRequiredCapabilityGroups,
        checkpointRequiredToolNames,
        skillCatalogSnapshot,
        skillHintRelevanceForTurn,
        turnCapabilityFloors,
        toolDefinitions,
        abortController,
        runHandle,
        committedPublicSession,
        session,
        isCurrentRun,
        toolArgsByName,
        transcriptEvents,
        usedTools,
        projectionPatches,
        emitOutputForRun,
        emitOutput,
        emitHeartbeat,
        emitStatusForRun,
        finalizeEarlyReturn: async (params) => {
          if (preparedTurnState) {
            runMetaBudgetRuntime = preparedTurnState.runMetaBudgetRuntime
            runMetaProviderDiagnostics = preparedTurnState.runMetaProviderDiagnostics
            runMetaContinuationRef = preparedTurnState.runMetaContinuationRef
            runMetaUsage = preparedTurnState.runMetaUsage
            finalText = preparedTurnState.finalText
          }
          return finalizeEarlyReturn(params)
        },
        finalizeBudgetCheckpointReturn: async (checkpointText) => {
          if (preparedTurnState) {
            runMetaBudgetRuntime = preparedTurnState.runMetaBudgetRuntime
            runMetaProviderDiagnostics = preparedTurnState.runMetaProviderDiagnostics
            runMetaContinuationRef = preparedTurnState.runMetaContinuationRef
            runMetaUsage = preparedTurnState.runMetaUsage
            finalText = preparedTurnState.finalText
          }
          return finalizeBudgetCheckpointReturn(checkpointText)
        },
        buildResult: (params) => buildExecutionTurnResult(this.host, params),
        requestedCapabilityConflicts,
        turnFollowup,
        useTextToolBridge,
        documentTargetGuard,
        requiresLocalDocumentExcerpt,
        preferCurrentDocumentRead,
        requiresLocalDocumentWrite,
        providerContent,
        capabilities,
        authorization,
        skillSurface,
        preparedSkillTurn,
        activeFrame,
        contextWindowTokens,
        maxOutputTokens,
        agentContext,
        provider,
        model,
        nativeTextToolBoundaryFlush
      })
      syncOuterFromPreparedTurn()
      return executionResult
    } catch (error) {
      syncOuterFromPreparedTurn()
      return await handleAgentSdkTurnError({
        host: this.host,
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
        runMetaBudgetRuntime: preparedTurnState
          ? preparedTurnState.runMetaBudgetRuntime
          : runMetaBudgetRuntime,
        runMetaProviderDiagnostics: preparedTurnState
          ? preparedTurnState.runMetaProviderDiagnostics
          : runMetaProviderDiagnostics,
        runMetaUsage: preparedTurnState ? preparedTurnState.runMetaUsage : runMetaUsage,
        longSkillCheckpoint: preparedTurnState
          ? preparedTurnState.longSkillCheckpoint
          : longSkillCheckpoint,
        finalText: preparedTurnState ? preparedTurnState.finalText : finalText,
        documentTargetGuardForRecovery,
        requiresLocalDocumentExcerptForRecovery,
        requiresLocalDocumentWriteForRecovery,
        hasSuccessfulLocalDocumentSourceReadForRecovery: preparedTurnState
          ? preparedTurnState.hasSuccessfulLocalDocumentSourceReadForRecovery
          : hasSuccessfulLocalDocumentSourceReadForRecovery,
        fileReadExcerptCheckpointForRecovery: preparedTurnState
          ? preparedTurnState.fileReadExcerptCheckpointForRecovery
          : fileReadExcerptCheckpointForRecovery,
        hasSuccessfulDocumentTargetMutation: preparedTurnState
          ? preparedTurnState.hasSuccessfulDocumentTargetMutation
          : hasSuccessfulDocumentTargetMutation,
        hasSuccessfulToolProgress: preparedTurnState
          ? preparedTurnState.hasSuccessfulToolProgress
          : hasSuccessfulToolProgress,
        lastDocumentSaveSuccessText: preparedTurnState ? preparedTurnState.lastDocumentSaveSuccessText : lastDocumentSaveSuccessText,
        finishProviderTransferCheckpoint: preparedTurnState?.finishProviderTransferCheckpoint || null,
        emitOutputForRun,
        emitOutput,
        emitStatusForRun,
        emitRuntimeError,
        finalizeEarlyReturn,
        finalizeBudgetCheckpointReturn,
        buildLocalDocumentWriteBudgetCheckpoint,
        buildToolProgressBudgetCheckpoint,
        buildResult: (params) => buildExecutionTurnResult(this.host, params)
      })
    } finally {
      this.host.dynamicDelivery.close(runId)
      await finalizeAgentSdkTurnLifecycle({
        host: this.host,
        name,
        runId,
        taskId,
        sessionId,
        status: runMetaStatus,
        terminalReason: runMetaTerminalReason,
        taskBudgetRuntime: runMetaBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics,
        continuationRef: runMetaContinuationRef,
        usage: runMetaUsage,
        content: content as RunMessage,
        finalText,
        session,
        runHandle,
        finishBackgroundTaskTerminalReminderRun,
        ownsBudgetCheckpointFlight,
        budgetCheckpointFlightKey
      })
    }
  }
}
