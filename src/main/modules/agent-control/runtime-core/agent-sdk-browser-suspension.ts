import type { AgentInputItem } from '@openai/agents'
import type { ExecutionTurnResult, TaskBudgetRuntime } from '../contracts/run-contracts'
import type { TurnTerminalReason } from './turn-frame'
import type { AgentSessionInputController } from './agent-session-input-controller'
import type { AgentSdkProviderDiagnostics, ToolBridgeRuntimeContext } from './agent-sdk-types'
import { workflowDigest } from '../../repositories/browser-workflow-codec'

type BrowserSuspensionReason = 'budget' | 'steering' | 'incomplete' | 'background' | 'provider_transfer' | 'manual'
type BrowserSuspensionTerminalReason = Extract<
  TurnTerminalReason,
  | 'checkpoint_budget'
  | 'checkpoint_steered'
  | 'checkpoint_incomplete'
  | 'checkpoint_background'
  | 'checkpoint_user_input'
  | 'blocked_tool_error'
>

interface BrowserVerifierRecoveryInput {
  rejectedCandidateDigest: string
  verdict: 'accept' | 'repair' | 'block'
  summary: string
  gaps: Array<{
    kind: 'text' | 'artifact' | 'external_action'
    description: string
    targetRefId?: string
  }>
}

export function buildBrowserVerifierRecoveryItem(
  input: BrowserVerifierRecoveryInput,
): AgentInputItem {
  const fact = {
    contract: 'ready_browser_verifier_recovery_v1',
    factId: workflowDigest(input),
    rejectedCandidateDigest: input.rejectedCandidateDigest,
    verdict: input.verdict,
    summary: input.summary,
    gaps: input.gaps,
    candidatePublished: false,
  }
  return {
    role: 'system',
    content: [
      `Browser completion verifier fact: ${JSON.stringify(fact)}`,
      'Continue the same request from the saved browser evidence and resolve these gaps before producing another final answer.',
    ].join('\n'),
    providerData: { readyBrowserVerifierRecovery: fact },
  } as AgentInputItem
}

export function withoutBrowserVerifierRecoveryItems(
  items: readonly AgentInputItem[],
): AgentInputItem[] {
  return items.filter((item) => {
    const providerData = (item as { providerData?: unknown }).providerData
    return !(
      providerData
      && typeof providerData === 'object'
      && !Array.isArray(providerData)
      && (providerData as Record<string, unknown>).readyBrowserVerifierRecovery
    )
  })
}

export function createBrowserSuspensionController(input: {
  modelInputController: AgentSessionInputController | null
  runtimeContext: Pick<ToolBridgeRuntimeContext, 'browserWorkflowRoute'>
  projectionPatches: Record<string, unknown>[]
  getTaskBudgetRuntime: () => TaskBudgetRuntime | null
  setContinuationRef: (continuation: Record<string, unknown>) => void
  setProviderDiagnostics: (diagnostics: AgentSdkProviderDiagnostics | null) => void
  setFinalText: (text: string) => void
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null,
  ) => void
  finalizeCheckpoint: (params: {
    terminalReason: BrowserSuspensionTerminalReason
    finalText: string
    continuationHandle: string
    taskBudgetRuntime: TaskBudgetRuntime | null
  }) => Promise<ExecutionTurnResult>
}) {
  const finishSuspension = async (params: {
    reason: BrowserSuspensionReason
    terminalReason: BrowserSuspensionTerminalReason
    message: string
    recoveryItems?: AgentInputItem[]
  }): Promise<ExecutionTurnResult | null> => {
    if (!input.modelInputController || !input.runtimeContext.browserWorkflowRoute) return null

    const checkpoint = await input.modelInputController.persistSuspension(
      params.reason,
      params.recoveryItems,
    )
    const continuationRef = {
      kind: 'browser_checkpoint',
      checkpointId: checkpoint.checkpointId,
      browserTaskId: checkpoint.browserTaskId,
      suspensionReason: params.reason,
    }
    input.setContinuationRef(continuationRef)
    const projectionPatch = {
      status: 'recoverable_paused',
      interactionState: 'suspended',
      waitingFor: 'none',
      blockedReason: `browser_${params.reason}_checkpoint`,
      resumableActions: ['continue', 'cancel'],
      canResume: true,
      continuationRef,
      ...(params.reason === 'budget' ? { budgetWarningLevel: 'exhausted' } : {}),
    }
    input.projectionPatches.push(projectionPatch)
    input.setFinalText(params.message)
    if (params.message) input.emitOutput(params.message, 'text', projectionPatch)
    return input.finalizeCheckpoint({
      terminalReason: params.terminalReason,
      finalText: params.message,
      continuationHandle: checkpoint.checkpointId,
      taskBudgetRuntime: input.getTaskBudgetRuntime(),
    })
  }

  const finishObservationCheckpoint = async (
    message = '页面动作已完成，但本轮还没有取得可验证的新页面状态。我已保存现场，继续时只会先观察，不会重复之前的动作。',
  ): Promise<ExecutionTurnResult> => {
    const checkpoint = await finishSuspension({
      reason: 'manual',
      terminalReason: 'checkpoint_user_input',
      message,
    })
    if (!checkpoint) throw new Error('browser_observation_checkpoint_unavailable')
    return checkpoint
  }

  const finishIncompleteCheckpoint = async (
    message = '浏览器任务仍有未完成项，我已保存当前证据和页面进度，可以继续。',
    recoveryItems: AgentInputItem[] = [],
  ): Promise<ExecutionTurnResult> => {
    const checkpoint = await finishSuspension({
      reason: 'incomplete',
      terminalReason: 'checkpoint_incomplete',
      message,
      recoveryItems,
    })
    if (!checkpoint) throw new Error('browser_incomplete_checkpoint_unavailable')
    return checkpoint
  }

  const finishProviderTransferCheckpoint = (diagnostics: AgentSdkProviderDiagnostics | null) => {
    input.setProviderDiagnostics(diagnostics)
    return finishSuspension({
      reason: 'provider_transfer',
      terminalReason: 'blocked_tool_error',
      message: '模型服务暂时不可用，浏览器现场和当前进度已保存，可以继续这项任务。',
    })
  }

  return { finishSuspension, finishObservationCheckpoint, finishIncompleteCheckpoint, finishProviderTransferCheckpoint }
}
