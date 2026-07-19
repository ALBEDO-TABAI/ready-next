import type { AgentInputItem, MemorySession, ModelProvider } from '@openai/agents'
import { classifyExecutionError } from '../../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../../claude-bridge/recovery-router'
import {
  buildTextToolResultMessage,
  parseTextToolBridgeResponse
} from '../../claude-bridge/tool-bridge'
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
import type { ExecutionTurnResult, RunMessage, TaskBudgetRuntime, TaskType } from '../contracts/run-contracts'
import { logAgentMetric } from '../metrics'
import {
  drainBackgroundTaskTerminalReminders,
  prependSystemReminderInput,
  registerBackgroundTaskTerminalReminder
} from '../system-reminders/background-task-terminal-reminder'
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
  throwIfAbortSignalAborted,
  waitForAbortableRetryDelay
} from './agent-sdk-execution-utils'
import {
  removeAlreadyEmittedNativeText,
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
import { createBrowserCandidateClosureController } from './agent-sdk-browser-candidate-closure'
import {
  createModelLoopBudgetController,
  createRollingBudgetCheckpointWriter,
} from './agent-sdk-model-loop-budget'
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
  turnTaskType: TaskType
  requiredCapabilityGroups: string[]
  usedTools: string[]
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitHeartbeat: (text: string) => void
  candidateOutputBuffer?: { snapshot(): string; replace(text: string): void }
  checkpointSnapshotProvider?: () => Promise<AgentInputItem[] | null>
  callModelInputFilter?: (
    items: AgentInputItem[],
    context: { sourceItems: AgentInputItem[]; compacted: boolean },
  ) => Promise<AgentInputItem[]>
  nativeTextToolBoundaryFlush: { current: (() => void) | null }
  finishBudgetCheckpointIfNeeded: () => Promise<ExecutionTurnResult | null>
  finishBrowserObservationCheckpoint: (message?: string) => Promise<ExecutionTurnResult>
  finishBrowserIncompleteCheckpoint: (message?: string) => Promise<ExecutionTurnResult>
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
    turnTaskType,
    requiredCapabilityGroups,
    usedTools,
    emitOutput,
    emitHeartbeat,
    candidateOutputBuffer,
    checkpointSnapshotProvider,
    callModelInputFilter,
    nativeTextToolBoundaryFlush,
    finishBudgetCheckpointIfNeeded,
    finishBrowserObservationCheckpoint,
    finishBrowserIncompleteCheckpoint,
    maybeHandleSkillClarificationGuard,
    maybeHandleActionAnnouncementGuard,
    finalizeEarlyReturn
  } = ctx
  const modelLoopBudget = createModelLoopBudgetController({
    providerContent,
    requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
    requiresLocalDocumentWrite,
    getRuntime: () => state.liveTaskBudgetRuntime,
    setRuntime: (runtime) => {
      state.liveTaskBudgetRuntime = runtime
      state.runMetaBudgetRuntime = runtime
      toolBridgeRuntimeContext.taskBudgetRuntime = runtime
    },
  })
  let documentTargetRepairAttempts = 0
  let documentTargetContinuationRepairAttempts = 0
  let documentTargetContentRepairAttempts = 0
  let newDocumentSaveRepairAttempts = 0
  let localDocumentExcerptRepairAttempts = 0
  let sdkMissingToolRecoveries = 0
  const bufferNativeTextUntilParsed = !useTextToolBridge && toolDefinitions.length > 0
  const holdNativeTextUntilFinal =
    bufferNativeTextUntilParsed && allowedToolNames.includes('skill_ask_user')
  const shouldHoldNativeTextUntilVerified = (): boolean =>
    holdNativeTextUntilFinal || Boolean(toolBridgeRuntimeContext.browserWorkflowRoute)
  const bridgeTurnLimit = useTextToolBridge ? modelLoopBudget.maxTurns() : 3
  const browserCandidateClosure = createBrowserCandidateClosureController({
    state,
    host,
    runtimeContext: toolBridgeRuntimeContext,
    emitHeartbeat,
    candidateOutputBuffer,
    finishObservationCheckpoint: finishBrowserObservationCheckpoint,
    finishIncompleteCheckpoint: finishBrowserIncompleteCheckpoint,
  })
  const writeRollingBudgetCheckpointIfDue = createRollingBudgetCheckpointWriter({
    state,
    host,
    agentName: name,
    sessionId,
    runId,
    taskId,
    runHandle,
    usedTools,
    requiredCapabilityGroups,
    requiredToolNames: allowedToolNames,
    lastUserMessage: pureUserTurnText,
    checkpointSnapshotProvider,
    onError: (error) => log(`rolling budget checkpoint failed: ${errorMessage(error)}`),
  })
  let bridgeTurn = 0
  while (bridgeTurn < bridgeTurnLimit || browserCandidateClosure.hasPendingTurn()) {
    const { observationClosureTurn, observationSynthesisTurn } = browserCandidateClosure.beginTurn()
    bridgeTurn += 1
    let streamedText = ''
    let nativeTextBuffer = ''
    let nativeTextAlreadyEmitted = ''
    let nativeTextFlushTimer: ReturnType<typeof setTimeout> | null = null
    if (!observationClosureTurn && !observationSynthesisTurn) {
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
        if (shouldHoldNativeTextUntilVerified()) return
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
    let successfulRunCandidateStart = candidateOutputBuffer?.snapshot() ?? ''
    while (true) {
      streamedText = ''
      nativeTextBuffer = ''
      nativeTextAlreadyEmitted = ''
      clearNativeTextFlushTimer()
      const baseItems = await modelSession.getItems()
      const candidateTextAtAttemptStart = candidateOutputBuffer?.snapshot() ?? ''
      const usedToolsAtAttemptStart = usedTools.length
      const resetRetryAttempt = async () => {
        candidateOutputBuffer?.replace(candidateTextAtAttemptStart)
        await modelSession.clearSession()
        if (baseItems.length > 0) await modelSession.addItems(baseItems)
      }
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
        await writeRollingBudgetCheckpointIfDue()
        const terminalReminderTexts = drainBackgroundTaskTerminalReminders(sessionId)
        if (state.sessionRestoreNotice) {
          terminalReminderTexts.unshift(state.sessionRestoreNotice)
          state.sessionRestoreNotice = null
        }
        const registry = createSystemReminderRegistry()
        if (terminalReminderTexts.length > 0) {
          registerBackgroundTaskTerminalReminder(registry, terminalReminderTexts)
        }
        // D2 — 结果型任务的验收标准（事中自检），与终态裁决同一模板源。
        // 每 run 只注入一次（首个模型调用）：criteria 是 run 级静态清单，
        // 重复注入既费 token 也会改变后续迭代（如 text-bridge 回喂）的
        // 输入形状。非结果型任务在 builder 内跳过。
        if (!state.criteriaSelfCheckInjected) {
          state.criteriaSelfCheckInjected = registerCriteriaSelfCheckReminder(
            registry,
            state.liveTaskBudgetRuntime?.taskType || turnTaskType
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
        nativeTextToolBoundaryFlush.current = shouldHoldNativeTextUntilVerified()
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
          tools: observationSynthesisTurn ? [] : sdkTools,
          signal: abortController.signal,
          maxTurns: observationClosureTurn
            ? (useTextToolBridge ? 1 : 2)
            : observationSynthesisTurn
              ? 1
              : modelLoopBudget.maxTurns(),
          contextWindowTokens,
          maxOutputTokens,
          callModelInputFilter,
          onTextDelta: (delta) => {
            streamedText += delta
            if (!useTextToolBridge && !bufferNativeTextUntilParsed) {
              emitOutput(delta, 'text')
            } else if (!useTextToolBridge && bufferNativeTextUntilParsed) {
              nativeTextBuffer += delta
              if (!shouldHoldNativeTextUntilVerified()) {
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
        modelLoopBudget.consumeIterations(Math.max(1, Math.round(runResult.iterationsUsed || 1)))
        await writeRollingBudgetCheckpointIfDue()
        successfulRunCandidateStart = candidateTextAtAttemptStart
        if (toolBridgeRuntimeContext.hostControl === 'handoff_takeover') {
          return finalizeEarlyReturn({ status: 'checkpoint', terminalReason: 'manual_suspend', finalText: '' })
        }
        break
      } catch (error) {
        nativeTextToolBoundaryFlush.current = null
        clearNativeTextFlushTimer()
        if (error instanceof Error && error.name === 'BrowserWorkflowSuspendedError') {
          const suspensionKind = toolBridgeRuntimeContext.browserSuspensionRequest?.kind
          return finalizeEarlyReturn({
            status: 'checkpoint',
            terminalReason: 'manual_suspend',
            finalText: '',
            initiator: suspensionKind === 'browser_power_confirmation'
              ? 'browser_power_confirmation'
              : suspensionKind === 'browser_permission'
                ? 'browser_permission'
                : 'browser_human_takeover',
          })
        }
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
        if (modelLoopBudget.consumeIterations(errorIterations) > 0) {
          const checkpointResult = await finishBudgetCheckpointIfNeeded()
          if (checkpointResult) return checkpointResult
        }
        const replayWouldDuplicateProgress = usedTools.length > usedToolsAtAttemptStart
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
            candidateOutputBuffer?.replace(candidateTextAtAttemptStart)
            if (compacted.status === 'noop') await resetRetryAttempt()
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
          await resetRetryAttempt()
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
            await resetRetryAttempt()
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
            await waitForAbortableRetryDelay(delayMs, abortController.signal)
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
        if (observationSynthesisTurn) return browserCandidateClosure.finishObservationSynthesisCheckpoint()
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
        {
          const observationClosureResult = await browserCandidateClosure.continueAfterObservationToolResults(
            bridgeResults,
            leakedToolCall.visibleText,
          )
          if (observationClosureResult === 'continue') continue
          if (observationClosureResult) return observationClosureResult
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
        if (toolBridgeRuntimeContext.browserSuspensionRequest) {
          // Feed the standard tool result through the next SDK model-input
          // filter. The filter commits the post-result clean boundary and
          // aborts before any provider request is dispatched.
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
      {
        const browserTerminalGuard = await browserCandidateClosure.guardTerminalCandidate(
          successfulRunCandidateStart,
        )
        if (browserTerminalGuard === 'continue') continue
        if (browserTerminalGuard) return browserTerminalGuard
      }
      state.finalText = ensureResearchSearchResultDelivered(
        modelText,
        toolBridgeRuntimeContext.latestResearchSearchDelivery,
      )
      if (observationSynthesisTurn && !state.finalText.trim()) {
        return browserCandidateClosure.finishObservationSynthesisCheckpoint()
      }
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
        emitOutput('正文或标签尚未完成，我会先补全再结束。', 'text')
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
      {
        const browserTerminalGuard = await browserCandidateClosure.guardTerminalCandidate(
          successfulRunCandidateStart,
        )
        if (browserTerminalGuard === 'continue') continue
        if (browserTerminalGuard) return browserTerminalGuard
      }
      state.finalText = ensureResearchSearchResultDelivered(
        parsed.visibleText || modelText,
        toolBridgeRuntimeContext.latestResearchSearchDelivery,
      )
      if (observationSynthesisTurn && !state.finalText.trim()) {
        return browserCandidateClosure.finishObservationSynthesisCheckpoint()
      }
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
        emitOutput('正文或标签尚未完成，我会先补全再结束。', 'text')
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

    if (observationSynthesisTurn) return browserCandidateClosure.finishObservationSynthesisCheckpoint()
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
    {
      const observationClosureResult = await browserCandidateClosure.continueAfterObservationToolResults(
        bridgeResults,
        parsed.visibleText,
      )
      if (observationClosureResult === 'continue') continue
      if (observationClosureResult) return observationClosureResult
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
    if (toolBridgeRuntimeContext.browserSuspensionRequest) {
      // Text-tool providers use the same clean-boundary contract as native
      // providers: the complete result enters callModelInputFilter, which
      // persists the suspension and prevents the next wire request.
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
  browserCandidateClosure.clear()
  return null
}
