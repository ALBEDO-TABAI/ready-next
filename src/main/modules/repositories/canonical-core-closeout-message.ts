import type { BrowserWorkflowCompletionVerifierReceipt } from '../../../shared/browser-workflow-control'
import type { CanonicalAssistantMessage } from '../../../shared/ipc-contracts/canonical-message'

export interface CanonicalCoreCloseoutMessageInput {
  parentTaskId: string
  ownerRunId: string
  conversationId: string
  finalText: string
  timestamp: string
  terminalReason: string
  completionVerifierReceipt?: BrowserWorkflowCompletionVerifierReceipt | null
}

export function buildCanonicalCoreCloseoutMessage(
  input: CanonicalCoreCloseoutMessageInput,
): CanonicalAssistantMessage {
  return {
    id: `assistant:${input.parentTaskId}:${input.ownerRunId}:terminal`,
    conversationId: input.conversationId,
    role: 'assistant',
    content: input.finalText,
    timestamp: input.timestamp,
    meta: {
      taskId: input.parentTaskId,
      runId: input.ownerRunId,
      terminalReason: input.terminalReason,
      ...(input.completionVerifierReceipt
        ? { completionVerifierReceipt: input.completionVerifierReceipt }
        : {}),
    },
  }
}
