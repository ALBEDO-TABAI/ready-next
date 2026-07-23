import type { BrowserWorkflowCompletionVerifierReceipt } from '../../../shared/browser-workflow-control'
import type { CanonicalAssistantMessage } from '../../../shared/ipc-contracts/canonical-message'

export interface CanonicalCoreCloseoutMessageInput {
  parentTaskId: string
  ownerRunId: string
  conversationId: string
  finalText: string
  timestamp: string
  terminalReason: string
  /** 暂停通知必须带 checkpointId 占用独立 id；否则会抢占 run 唯一终态 id，
   *  同 run 后续非 checkpoint 终态将撞 canonical_assistant_message_conflict。 */
  checkpointId?: string | null
  recentArtifacts?: unknown[] | null
  completionVerifierReceipt?: BrowserWorkflowCompletionVerifierReceipt | null
}

export function buildCanonicalCoreCloseoutMessage(
  input: CanonicalCoreCloseoutMessageInput,
): CanonicalAssistantMessage {
  return {
    id: input.checkpointId
      ? `assistant:${input.parentTaskId}:${input.ownerRunId}:checkpoint:${input.checkpointId}`
      : `assistant:${input.parentTaskId}:${input.ownerRunId}:terminal`,
    conversationId: input.conversationId,
    role: 'assistant',
    content: input.finalText,
    timestamp: input.timestamp,
    meta: {
      taskId: input.parentTaskId,
      runId: input.ownerRunId,
      terminalReason: input.terminalReason,
      ...(input.recentArtifacts?.length
        ? { recentArtifacts: input.recentArtifacts }
        : {}),
      ...(input.completionVerifierReceipt
        ? { completionVerifierReceipt: input.completionVerifierReceipt }
        : {}),
    },
  }
}
