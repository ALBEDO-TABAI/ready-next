import type { AgentInputItem, MemorySession, ModelProvider } from '@openai/agents'
import { classifyExecutionError } from '../../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../../claude-bridge/recovery-router'
import {
  buildTextToolResultMessage,
  parseTextToolBridgeResponse
} from '../../claude-bridge/tool-bridge'
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
import type { ExecutionTurnResult, RunMessage, TaskBudgetRuntime } from '../contracts/run-contracts'
import { logAgentMetric } from '../metrics'
import { consumeIterationBudget } from '../task-projection/run-budget-policy'
import { buildActivePlanReminderText } from '../system-reminders/active-plan-step-reminder'
import {
  drainBackgroundTaskTerminalReminders,
  prependSystemReminderInput,
  registerBackgroundTaskTerminalReminder
} from '../system-reminders/background-task-terminal-reminder'
import { registerBrowserActionSessionReminder } from '../system-reminders/browser-action-session-reminder'
import { registerCriteriaSelfCheckReminder } from '../system-reminders/criteria-self-check-reminder'
import { createSystemReminderRegistry } from '../system-reminders/system-reminder-registry'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput
} from '../tools-runtime/tool-result-types'
import {
  buildDocumentTargetContentRepairInput,
  buildDocumentTargetContinuationRepairInput,
  buildDocumentTargetRepairInput,
  buildNewDocumentSaveRepairInput,
  finalTextIndicatesIncompleteDocument,
  inspectDocumentTargetContent,
  isDocumentToolFailure
} from './agent-sdk-document-utils'
import {
  buildLocalDocumentExcerptRepairInput,
  classifySdkRuntimeError,
  errorMessage,
  extractSdkMissingToolName,
  isAbortError,
  recoverLooseXmlToolCallText,
  shouldSuppressVisibleTextOnToolCall,
  throwIfAbortSignalAborted
} from './agent-sdk-execution-utils'
import {
  ROLLING_BUDGET_CHECKPOINT_TOOL_INTERVAL,
  removeAlreadyEmittedNativeText,
  resolveAgentSdkMaxTurns,
  resolveTaskTypeFromBrowserWorkflowText,
  splitNativeTextBufferForSafeFlush
} from './agent-sdk-foundation-utils'
import { log } from './agent-sdk-provider'
import { mapToolFailureClose } from './agent-sdk-runtime-outcome-utils'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type {
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  AgentSdkSession,
  DocumentTargetGuard,
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  RunHandle,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import type { TurnTerminalReason } from './turn-frame'
import { addRunUsage } from './run-usage-accumulator'
import { isHandoffTakeoverToolOutput } from '../agents/handoff-control'
import {
  ensureResearchSearchResultDelivered,
  recoverResearchSearchDeliveryAfterTimeout
} from './research-result-delivery'

const NATIVE_TEXT_BUFFER_TIMED_FLUSH_MS = 700

export interface AgentSdkModelToolLoopState {
  criteriaSelfCheckInjected: boolean
  finalText: string
  hasSuccessfulDocumentTargetMutation: boolean
  hasSuccessfulLocalDocumentSourceRead: boolean
  lastDocumentSaveFailure: string | null
  lastDocumentSaveSuccessText: string | null
  lastRollingCheckpointToolCalls: number
  liveTaskBudgetRuntime: TaskBudgetRuntime | null
  newDocumentNeedsSave: boolean
  nextInput: ReadyAgentSdkRunParams['input']
  runMetaBudgetRuntime: TaskBudgetRuntime | null
  runMetaContinuationRef: Record<string, unknown> | null
  runMetaUsage: ReadyAgentSdkRunResult['usage'] | null
  sessionRestoreNotice: string | null
}

export interface AgentSdkModelToolLoopContext {
  state: AgentSdkModelToolLoopState
  host: TurnOrchestratorHost
  name: string
  runId: string
  taskId: string
  sessionId?: string
  pureUserTurnText: string
  effectiveExecutionOptions?: AgentSdkExecutionOptions
  providerContent: RunMessage
  useTextToolBridge: boolean
  toolDefinitions: ToolDefinition[]
  allowedToolNames: string[]
  definitionByName: Map<string, ToolDefinition>
  toolBridgeRuntimeContext: ToolBridgeRuntimeContext
  documentTargetGuard: DocumentTargetGuard | null
  requiresLocalDocumentExcerpt: boolean
  preferCurrentDocumentRead: boolean
  requiresLocalDocumentWrite: boolean
  runHandle: RunHandle
  /** Dynamic Delivery uses a candidate-only working session until verifier accept. */
  modelSession?: MemorySession
  session: AgentSdkSession
  abortController: AbortController
  instructions: string
  model: string
  provider: ModelProvider
  sdkTools: ReadyAgentSdkRunParams['tools']
  contextWindowTokens: number
  maxOutputTokens: number
  inferredSdkTaskType: ReturnType<typeof resolveTaskTypeFromBrowserWorkflowText>
  requiredCapabilityGroups: string[]
  usedTools: string[]
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitHeartbeat: (text: string) => void
  checkpointSnapshotProvider?: () => Promise<AgentInputItem[] | null>
  nativeTextToolBoundaryFlush: { current: (() => void) | null }
  finishBudgetCheckpointIfNeeded: () => Promise<ExecutionTurnResult | null>
  maybeHandleSkillClarificationGuard: (
    text: string
  ) => Promise<'continue' | ExecutionTurnResult | null>
  maybeHandleActionAnnouncementGuard: (
    text: string
  ) => Promise<'continue' | ExecutionTurnResult | null>
  finalizeEarlyReturn: (params: {
    status: 'done' | 'checkpoint' | 'error' | 'cancelled'
    terminalReason: TurnTerminalReason
    finalText: string
    error?: string
    continuationHandle?: string | null
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
    initiator?: string
  }) => Promise<ExecutionTurnResult>
}

export async function executeAgentSdkModelToolLoop(
  ctx: AgentSdkModelToolLoopContext
): Promise<ExecutionTurnResult | null> {
  const {
    state,
    host,
    name,
    runId,
    taskId,
    sessionId,
    pureUserTurnText,
    effectiveExecutionOptions,
    providerContent,
    useTextToolBridge,
    toolDefinitions,
    allowedToolNames,
    definitionByName,
    toolBridgeRuntimeContext,
    documentTargetGuard,
    requiresLocalDocumentExcerpt,
    preferCurrentDocumentRead,
    requiresLocalDocumentWrite,
    runHandle,
    modelSession = runHandle.capturedSession,
    session,
    abortController,
    instructions,
    model,
    provider,
    sdkTools,
    contextWindowTokens,
    maxOutputTokens,
    inferredSdkTaskType,
    requiredCapabilityGroups,
    usedTools,
    emitOutput,
    emitHeartbeat,
    checkpointSnapshotProvider,
    nativeTextToolBoundaryFlush,
    finishBudgetCheckpointIfNeeded,
    maybeHandleSkillClarificationGuard,
    maybeHandleActionAnnouncementGuard,
    finalizeEarlyReturn
  } = ctx
  const currentAgentSdkMaxTurns = (): number =>
    resolveAgentSdkMaxTurns({
      message: providerContent,
      requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
      requiresLocalDocumentWrite,
      taskBudgetRuntime: state.liveTaskBudgetRuntime
    })
  const consumeModelIterations = (amount: number): number => {
    if (!state.liveTaskBudgetRuntime) return 0
    const remaining = Math.max(
      0,
      state.liveTaskBudgetRuntime.budget.maxIterations -
        state.liveTaskBudgetRuntime.usage.iterationsUsed
    )
    const count = Math.min(remaining, Math.max(0, Math.round(amount || 0)))
    let nextBudgetRuntime = state.liveTaskBudgetRuntime
    for (let index = 0; index < count; index += 1) {
      nextBudgetRuntime = consumeIterationBudget(nextBudgetRuntime)
    }
    state.liveTaskBudgetRuntime = nextBudgetRuntime
    state.runMetaBudgetRuntime = nextBudgetRuntime
    toolBridgeRuntimeContext.taskBudgetRuntime = nextBudgetRuntime
    return count
  }
  let documentTargetRepairAttempts = 0
  let documentTargetContinuationRepairAttempts = 0
  let documentTargetContentRepairAttempts = 0
  let newDocumentSaveRepairAttempts = 0
  let localDocumentExcerptRepairAttempts = 0
  let sdkMissingToolRecoveries = 0
  const bufferNativeTextUntilParsed = !useTextToolBridge && toolDefinitions.length > 0
  const holdNativeTextUntilFinal =
    bufferNativeTextUntilParsed && allowedToolNames.includes('skill_ask_user')
  for (let bridgeTurn = 0; bridgeTurn < (useTextToolBridge ? 4 : 3); bridgeTurn += 1) {
    let streamedText = ''
    let nativeTextBuffer = ''
    let nativeTextAlreadyEmitted = ''
    let nativeTextFlushTimer: ReturnType<typeof setTimeout> | null = null
    {
      const checkpointResult = await finishBudgetCheckpointIfNeeded()
      if (checkpointResult) return checkpointResult
    }
    const clearNativeTextFlushTimer = () => {
      if (nativeTextFlushTimer) {
        clearTimeout(nativeTextFlushTimer)
        nativeTextFlushTimer = null
      }
    }
    const emitNativeText = (text: string) => {
      if (!text) return
      nativeTextAlreadyEmitted += text
      emitOutput(text, 'text')
    }
    const flushNativeTextBuffer = (flushWithoutMarker = false) => {
      const next = splitNativeTextBufferForSafeFlush(nativeTextBuffer, { flushWithoutMarker })
      if (next.emitText) emitNativeText(next.emitText)
      nativeTextBuffer = next.remainingText
    }
    const scheduleNativeTextFlush = () => {
      if (nativeTextFlushTimer || !nativeTextBuffer) return
      nativeTextFlushTimer = setTimeout(() => {
        nativeTextFlushTimer = null
        flushNativeTextBuffer(true)
      }, NATIVE_TEXT_BUFFER_TIMED_FLUSH_MS)
    }
    const visibleNativeTextAfterFlush = (text: string): string => {
      const remaining = removeAlreadyEmittedNativeText(text, nativeTextAlreadyEmitted)
      return splitNativeTextBufferForSafeFlush(remaining, {
        flushWithoutMarker: true
      }).emitText.trimStart()
    }
    let contextCompressedForBridgeTurn = false
    let providerRetryAttempts = 0
    let runResult: ReadyAgentSdkRunResult | null = null
    const maybeWriteRollingBudgetCheckpoint = async (): Promise<void> => {
      if (
        !state.liveTaskBudgetRuntime ||
        state.liveTaskBudgetRuntime.warningLevel === 'exhausted' ||
        state.liveTaskBudgetRuntime.usage.toolCallsUsed - state.lastRollingCheckpointToolCalls <
          ROLLING_BUDGET_CHECKPOINT_TOOL_INTERVAL
      ) {
        return
      }
      state.lastRollingCheckpointToolCalls = state.liveTaskBudgetRuntime.usage.toolCallsUsed
      try {
        const rolling = await host.runLifecycle.writeBudgetCheckpointState({
          agentName: name,
          sessionId,
          runId,
          taskId,
          taskBudgetRuntime: state.liveTaskBudgetRuntime,
          runHandle,
          usedTools,
          requiredCapabilityGroups,
          requiredToolNames: allowedToolNames,
          lastUserMessage: pureUserTurnText,
          resumeKind: 'snapshot',
          sessionSnapshotOverride: await checkpointSnapshotProvider?.() ?? null
        })
        state.runMetaContinuationRef =
          rolling.projectionPatch.taskContinuation &&
          typeof rolling.projectionPatch.taskContinuation === 'object'
            ? (rolling.projectionPatch.taskContinuation as Record<string, unknown>)
            : state.runMetaContinuationRef
      } catch (rollingError) {
        log(`rolling budget checkpoint failed: ${errorMessage(rollingError)}`)
      }
    }
    while (true) {
      streamedText = ''
      nativeTextBuffer = ''
      nativeTextAlreadyEmitted = ''
      clearNativeTextFlushTimer()
      const baseItems = await modelSession.getItems()
      const usedToolsAtAttemptStart = usedTools.length
      try {
        if (abortController.signal.aborted) {
          const error =
            abortController.signal.reason instanceof Error
              ? abortController.signal.reason
              : new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        // L-f5: rolling budget checkpoint — refresh the durable
        // continuation handle every N clean tool batches (the boundary
        // before a model call is clean: all prior tools settled), so a
        // mid-run crash loses at most N batches instead of everything
        // written only at exhaustion. Failure is loud, never blocking.
        await maybeWriteRollingBudgetCheckpoint()
        const terminalReminderTexts = drainBackgroundTaskTerminalReminders(sessionId)
        if (state.sessionRestoreNotice) {
          terminalReminderTexts.unshift(state.sessionRestoreNotice)
          state.sessionRestoreNotice = null
        }
        const activePlanReminder = buildActivePlanReminderText(sessionId)
        const registry = createSystemReminderRegistry()
        if (terminalReminderTexts.length > 0) {
          registerBackgroundTaskTerminalReminder(registry, terminalReminderTexts)
        }
        if (activePlanReminder) {
          registry.register({
            topic: 'active-plan-step',
            priority: 80,
            conflictsWith: [],
            text: activePlanReminder
          })
        }
        registerBrowserActionSessionReminder(registry, sessionId)
        // D2 — 结果型任务的验收标准（事中自检），与终态裁决同一模板源。
        // 每 run 只注入一次（首个模型调用）：criteria 是 run 级静态清单，
        // 重复注入既费 token 也会改变后续迭代（如 text-bridge 回喂）的
        // 输入形状。非结果型任务在 builder 内跳过。
        if (!state.criteriaSelfCheckInjected) {
          state.criteriaSelfCheckInjected = registerCriteriaSelfCheckReminder(
            registry,
            state.liveTaskBudgetRuntime?.taskType || inferredSdkTaskType || null
          )
        }
        const reminderText = registry.compose()
        if (reminderText) {
          state.nextInput = prependSystemReminderInput(state.nextInput, reminderText)
        }
        // P0-3 — the model call is the longest pre-output stage; say so.
        emitHeartbeat(
          contextCompressedForBridgeTurn ? '上下文较长，压缩后重新调用模型…' : '正在调用模型…'
        )
        // P0-1 — arm the response-boundary release for hold turns only.
        nativeTextToolBoundaryFlush.current = holdNativeTextUntilFinal
          ? () => {
              flushNativeTextBuffer(true)
            }
          : null
        runResult = await host.runAgent({
          agentName: name,
          runId,
          taskId,
          sessionId,
          input: state.nextInput,
          instructions,
          model,
          provider,
          session: modelSession,
          tools: sdkTools,
          signal: abortController.signal,
          maxTurns: currentAgentSdkMaxTurns(),
          contextWindowTokens,
          maxOutputTokens,
          onTextDelta: (delta) => {
            streamedText += delta
            if (!useTextToolBridge && !bufferNativeTextUntilParsed) {
              emitOutput(delta, 'text')
            } else if (!useTextToolBridge && bufferNativeTextUntilParsed) {
              nativeTextBuffer += delta
              if (!holdNativeTextUntilFinal) {
                flushNativeTextBuffer(false)
                scheduleNativeTextFlush()
              }
            }
          }
        })
        throwIfAbortSignalAborted(abortController.signal)
        nativeTextToolBoundaryFlush.current = null
        clearNativeTextFlushTimer()
        if (runResult.usage) {
          session.lastUsageTokens = runResult.usage.totalTokens
        }
        state.runMetaUsage = addRunUsage(state.runMetaUsage, runResult.usage)
        consumeModelIterations(Math.max(1, Math.round(runResult.iterationsUsed || 1)))
        await maybeWriteRollingBudgetCheckpoint()
        if (toolBridgeRuntimeContext.hostControl === 'handoff_takeover') {
          return finalizeEarlyReturn({ status: 'checkpoint', terminalReason: 'manual_suspend', finalText: '' })
        }
        break
      } catch (error) {
        nativeTextToolBoundaryFlush.current = null
        clearNativeTextFlushTimer()
        if (abortController.signal.aborted) {
          const abortError =
            abortController.signal.reason instanceof Error
              ? abortController.signal.reason
              : new Error('aborted')
          const recoveredResearchText = recoverResearchSearchDeliveryAfterTimeout(
            abortError,
            toolBridgeRuntimeContext.latestResearchSearchDelivery
          )
          if (recoveredResearchText) {
            state.finalText = recoveredResearchText
            emitOutput(recoveredResearchText, 'text')
            return finalizeEarlyReturn({
              status: 'done',
              terminalReason: 'done',
              finalText: recoveredResearchText,
              initiator: 'research_result_timeout_recovery'
            })
          }
          abortError.name = 'AbortError'
          throw abortError
        }
        const errorIterations =
          error && typeof error === 'object'
            ? Number((error as { iterationsUsed?: unknown }).iterationsUsed || 0)
            : 0
        if (consumeModelIterations(errorIterations) > 0) {
          const checkpointResult = await finishBudgetCheckpointIfNeeded()
          if (checkpointResult) return checkpointResult
        }
        const replayWouldDuplicateProgress =
          streamedText.length > 0 || usedTools.length > usedToolsAtAttemptStart
        if (
          !replayWouldDuplicateProgress &&
          classifySdkRuntimeError(error).terminalReason === 'context_overflow' &&
          !contextCompressedForBridgeTurn
        ) {
          const compacted = await host.compactCapturedSession(
            name,
            modelSession === runHandle.capturedSession
              ? runHandle
              : { ...runHandle, capturedSession: modelSession },
            baseItems,
            'overflow',
            contextWindowTokens
          )
          if (compacted.status === 'compacted' || compacted.status === 'noop') {
            contextCompressedForBridgeTurn = true
            continue
          }
        }
        const missingToolName = extractSdkMissingToolName(error)
        if (!replayWouldDuplicateProgress && missingToolName && sdkMissingToolRecoveries < 1) {
          sdkMissingToolRecoveries += 1
          logAgentMetric('agent_sdk_missing_tool_soft_recovery', {
            runId,
            taskId,
            toolName: missingToolName,
            allowedToolNames
          })
          state.nextInput = prependSystemReminderInput(
            state.nextInput,
            [
              `系统补充：你刚才调用了未注册工具 ${missingToolName}，本轮不能使用它。`,
              allowedToolNames.length > 0
                ? `本轮实际可用工具是：${allowedToolNames.join(', ')}。请改用其中合适的工具继续完成任务。`
                : '本轮没有开放工具；请直接说明缺口，不要再次调用工具。'
            ].join('\n')
          )
          continue
        }
        // S5-2: classified transient provider failures (429/5xx/stream
        // cut/timeouts) retry with bounded backoff through the SAME
        // policy source as tool execution (error-classifier +
        // recovery-router) — no second retry config. Abort always wins;
        // context-overflow recovery stays with the compaction branch
        // above; exhausted retries fall through to the existing
        // classified failure path.
        if (
          !replayWouldDuplicateProgress &&
          !abortController.signal.aborted &&
          !isAbortError(error)
        ) {
          const classified = classifyExecutionError(error, { source: 'model_request' })
          const recovery = buildRecoveryPlan(classified)
          if (
            recovery.shouldRetry &&
            !recovery.shouldCompressContext &&
            providerRetryAttempts < recovery.maxAttempts
          ) {
            providerRetryAttempts += 1
            const base = recovery.retryDelayMs || 400
            const delayMs =
              recovery.backoff === 'exponential_jitter'
                ? Math.min(
                    base * 2 ** (providerRetryAttempts - 1) + Math.floor(Math.random() * 100),
                    8_000
                  )
                : base
            log(
              `provider ${classified.kind} retry ${providerRetryAttempts}/${recovery.maxAttempts} in ${delayMs}ms`
            )
            // Review-team D5: the wait must yield to abort immediately,
            // not after the full backoff window.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delayMs)
              abortController.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  resolve()
                },
                { once: true }
              )
            })
            if (abortController.signal.aborted) {
              const abortError =
                abortController.signal.reason instanceof Error
                  ? abortController.signal.reason
                  : new Error('aborted')
              abortError.name = 'AbortError'
              throw abortError
            }
            if (!abortController.signal.aborted) continue
          }
        }
        throw error
      }
    }
    if (!runResult) throw new Error('SDK run did not produce a result.')
    const modelText = runResult.finalText || streamedText
    const nativeMapCriticalClose = !useTextToolBridge
      ? (toolBridgeRuntimeContext.nativeMapCriticalClose ?? null)
      : null
    if (nativeMapCriticalClose) {
      state.finalText = nativeMapCriticalClose.message
      emitOutput(
        nativeMapCriticalClose.message,
        nativeMapCriticalClose.status === 'error' ? 'error' : 'text'
      )
      return finalizeEarlyReturn({
        status: nativeMapCriticalClose.status,
        terminalReason: nativeMapCriticalClose.terminalReason,
        error: nativeMapCriticalClose.success ? undefined : nativeMapCriticalClose.message,
        finalText: state.finalText
      })
    }
    if (!useTextToolBridge) {
      let leakedToolCall = /<tool_call>|<function=|<parameter=|:::tool_call/i.test(modelText)
        ? parseTextToolBridgeResponse(modelText)
        : { visibleText: modelText, toolCalls: [] }
      if (
        leakedToolCall.toolCalls.length === 0 &&
        /<tool_call>|<function=|<parameter=/i.test(modelText)
      ) {
        leakedToolCall = recoverLooseXmlToolCallText(modelText)
      }
      if (leakedToolCall.toolCalls.length > 0) {
        const visibleText = visibleNativeTextAfterFlush(leakedToolCall.visibleText)
        if (visibleText && !shouldSuppressVisibleTextOnToolCall(visibleText)) {
          emitOutput(visibleText, 'text')
        }
        const bridgeResults: ToolBridgeResultItem[] = []
        for (const call of leakedToolCall.toolCalls) {
          const definition = definitionByName.get(call.name)
          if (!definition) {
            bridgeResults.push({
              id: `native-xml-recovery-${bridgeTurn}-${bridgeResults.length}`,
              name: call.name,
              args: call.args,
              result: createToolExecutionOutput(`工具 ${call.name} 未在本轮授权列表中。`, {
                shape: 'json',
                data: {
                  errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code,
                  toolName: call.name
                }
              })
            })
            continue
          }
          const output = await host.toolExecutor.executeReadyToolDefinition(
            definition,
            call.args,
            toolBridgeRuntimeContext
          )
          if (call.name === 'document_save_tab') {
            state.lastDocumentSaveFailure = isDocumentToolFailure(output)
              ? normalizeToolExecutionOutput(output).text || 'document_save_tab failed'
              : null
          }
          bridgeResults.push({
            id: `native-xml-recovery-${bridgeTurn}-${bridgeResults.length}`,
            name: call.name,
            args: call.args,
            result: output
          })
          if (isHandoffTakeoverToolOutput(output)) {
            return finalizeEarlyReturn({ status: 'checkpoint', terminalReason: 'manual_suspend', finalText: '' })
          }
        }
        const handledMapAmbiguity = await host.resolveMapPlaceAmbiguityIfNeeded({
          bridgeResults,
          definitionByName,
          runtimeContext: toolBridgeRuntimeContext
        })
        const criticalClose = mapToolFailureClose(bridgeResults)
        if (criticalClose) {
          state.finalText = criticalClose.message
          emitOutput(criticalClose.message, criticalClose.status === 'error' ? 'error' : 'text')
          return finalizeEarlyReturn({
            status: criticalClose.status,
            terminalReason: criticalClose.terminalReason,
            error: criticalClose.success ? undefined : criticalClose.message,
            finalText: state.finalText
          })
        }
        if (handledMapAmbiguity) {
          state.nextInput = buildTextToolResultMessage(bridgeResults)
          state.finalText = leakedToolCall.visibleText
          continue
        }
        {
          const checkpointResult = await finishBudgetCheckpointIfNeeded()
          if (checkpointResult) return checkpointResult
        }
        state.nextInput = buildTextToolResultMessage(bridgeResults)
        state.finalText = leakedToolCall.visibleText
        continue
      }
      state.finalText = ensureResearchSearchResultDelivered(
        modelText,
        toolBridgeRuntimeContext.latestResearchSearchDelivery,
      )
      {
        const skillClarificationResult = await maybeHandleSkillClarificationGuard(state.finalText)
        if (skillClarificationResult === 'continue') continue
        if (skillClarificationResult) return skillClarificationResult
      }
      if (bufferNativeTextUntilParsed && state.finalText) {
        const visibleText = visibleNativeTextAfterFlush(state.finalText)
        if (visibleText) emitOutput(visibleText, 'text')
      } else if (!streamedText && state.finalText) {
        emitOutput(state.finalText, 'text')
      }
      if (
        requiresLocalDocumentExcerpt &&
        !state.hasSuccessfulLocalDocumentSourceRead &&
        localDocumentExcerptRepairAttempts < 1
      ) {
        localDocumentExcerptRepairAttempts += 1
        state.nextInput = buildLocalDocumentExcerptRepairInput(preferCurrentDocumentRead)
        emitOutput('还没有读取指定章节正文，我会先读取原文再重做结果。', 'text')
        continue
      }
      if (state.newDocumentNeedsSave && newDocumentSaveRepairAttempts < 1) {
        newDocumentSaveRepairAttempts += 1
        state.nextInput = buildNewDocumentSaveRepairInput()
        emitOutput('新文档已经写入但还没有保存，我会先保存再结束。', 'text')
        continue
      }
      if (
        documentTargetGuard &&
        finalTextIndicatesIncompleteDocument(state.finalText) &&
        documentTargetContinuationRepairAttempts < 1
      ) {
        documentTargetContinuationRepairAttempts += 1
        state.nextInput = buildDocumentTargetContinuationRepairInput(documentTargetGuard)
        emitOutput('目标文档看起来还没补完，我会继续修正并保存。', 'text')
        continue
      }
      if (documentTargetGuard && documentTargetContentRepairAttempts < 1) {
        const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
          forbidFutureLeakage: requiresLocalDocumentExcerpt
        })
        if (contentIssue) {
          documentTargetContentRepairAttempts += 1
          state.nextInput = buildDocumentTargetContentRepairInput(documentTargetGuard, contentIssue)
          emitOutput('目标文档里有未通过检查的内容，我会改成稳定版本并保存。', 'text')
          continue
        }
      }
      if (
        documentTargetGuard &&
        !state.hasSuccessfulDocumentTargetMutation &&
        documentTargetRepairAttempts < 1
      ) {
        documentTargetRepairAttempts += 1
        state.nextInput = buildDocumentTargetRepairInput(documentTargetGuard)
        emitOutput('目标文档还没有实际写入，我会继续完成写入并保存。', 'text')
        continue
      }
      {
        const actionAnnouncementResult = await maybeHandleActionAnnouncementGuard(state.finalText)
        if (actionAnnouncementResult === 'continue') continue
        if (actionAnnouncementResult) return actionAnnouncementResult
      }
      break
    }

    const parsed = parseTextToolBridgeResponse(modelText)
    if (parsed.toolCalls.length === 0) {
      state.finalText = ensureResearchSearchResultDelivered(
        parsed.visibleText || modelText,
        toolBridgeRuntimeContext.latestResearchSearchDelivery,
      )
      {
        const skillClarificationResult = await maybeHandleSkillClarificationGuard(state.finalText)
        if (skillClarificationResult === 'continue') continue
        if (skillClarificationResult) return skillClarificationResult
      }
      if (state.finalText) {
        emitOutput(state.finalText, 'text')
      }
      if (
        requiresLocalDocumentExcerpt &&
        !state.hasSuccessfulLocalDocumentSourceRead &&
        localDocumentExcerptRepairAttempts < 1
      ) {
        localDocumentExcerptRepairAttempts += 1
        state.nextInput = buildLocalDocumentExcerptRepairInput(preferCurrentDocumentRead)
        emitOutput('还没有读取指定章节正文，我会先读取原文再重做结果。', 'text')
        continue
      }
      if (state.newDocumentNeedsSave && newDocumentSaveRepairAttempts < 1) {
        newDocumentSaveRepairAttempts += 1
        state.nextInput = buildNewDocumentSaveRepairInput()
        emitOutput('新文档已经写入但还没有保存，我会先保存再结束。', 'text')
        continue
      }
      if (
        documentTargetGuard &&
        finalTextIndicatesIncompleteDocument(state.finalText) &&
        documentTargetContinuationRepairAttempts < 1
      ) {
        documentTargetContinuationRepairAttempts += 1
        state.nextInput = buildDocumentTargetContinuationRepairInput(documentTargetGuard)
        emitOutput('目标文档看起来还没补完，我会继续修正并保存。', 'text')
        continue
      }
      if (documentTargetGuard && documentTargetContentRepairAttempts < 1) {
        const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
          forbidFutureLeakage: requiresLocalDocumentExcerpt
        })
        if (contentIssue) {
          documentTargetContentRepairAttempts += 1
          state.nextInput = buildDocumentTargetContentRepairInput(documentTargetGuard, contentIssue)
          emitOutput('目标文档里有未通过检查的内容，我会改成稳定版本并保存。', 'text')
          continue
        }
      }
      {
        const actionAnnouncementResult = await maybeHandleActionAnnouncementGuard(state.finalText)
        if (actionAnnouncementResult === 'continue') continue
        if (actionAnnouncementResult) return actionAnnouncementResult
      }
      break
    }

    if (parsed.visibleText && !shouldSuppressVisibleTextOnToolCall(parsed.visibleText)) {
      emitOutput(parsed.visibleText, 'text')
    }

    const bridgeResults: ToolBridgeResultItem[] = []
    for (const call of parsed.toolCalls) {
      const definition = definitionByName.get(call.name)
      if (!definition) {
        bridgeResults.push({
          id: `text-bridge-${bridgeTurn}-${bridgeResults.length}`,
          name: call.name,
          args: call.args,
          result: createToolExecutionOutput(`工具 ${call.name} 未在本轮授权列表中。`, {
            shape: 'json',
            data: {
              errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code,
              toolName: call.name
            }
          })
        })
        continue
      }
      const output = await host.toolExecutor.executeReadyToolDefinition(
        definition,
        call.args,
        toolBridgeRuntimeContext
      )
      if (call.name === 'document_save_tab') {
        state.lastDocumentSaveFailure = isDocumentToolFailure(output)
          ? normalizeToolExecutionOutput(output).text || 'document_save_tab failed'
          : null
      }
      bridgeResults.push({
        id: `text-bridge-${bridgeTurn}-${bridgeResults.length}`,
        name: call.name,
        args: call.args,
        result: output
      })
      if (isHandoffTakeoverToolOutput(output)) {
        return finalizeEarlyReturn({ status: 'checkpoint', terminalReason: 'manual_suspend', finalText: '' })
      }
    }
    const handledMapAmbiguity = await host.resolveMapPlaceAmbiguityIfNeeded({
      bridgeResults,
      definitionByName,
      runtimeContext: toolBridgeRuntimeContext
    })
    const criticalClose = mapToolFailureClose(bridgeResults)
    if (criticalClose) {
      state.finalText = criticalClose.message
      emitOutput(criticalClose.message, criticalClose.status === 'error' ? 'error' : 'text')
      return finalizeEarlyReturn({
        status: criticalClose.status,
        terminalReason: criticalClose.terminalReason,
        error: criticalClose.success ? undefined : criticalClose.message,
        finalText: state.finalText
      })
    }
    if (handledMapAmbiguity) {
      state.nextInput = buildTextToolResultMessage(bridgeResults)
      state.finalText = parsed.visibleText
      continue
    }
    {
      const checkpointResult = await finishBudgetCheckpointIfNeeded()
      if (checkpointResult) return checkpointResult
    }
    state.nextInput = buildTextToolResultMessage(bridgeResults)
    state.finalText = parsed.visibleText
  }

  throwIfAbortSignalAborted(abortController.signal)
  return null
}
