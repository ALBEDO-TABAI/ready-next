import type { CanonicalCoreCloseoutInput } from '../../main/modules/repositories/agent-session-checkpoint-repository'
import { buildCanonicalCoreCloseoutMessage } from '../../main/modules/repositories/canonical-core-closeout-message'
import { workflowDigest } from '../../main/modules/repositories/browser-workflow-codec'

export function canonicalCoreCloseoutTestPort(
  onCommit?: (input: CanonicalCoreCloseoutInput) => void | Promise<void>,
) {
  return {
    async commitCanonicalCoreCloseout(input: CanonicalCoreCloseoutInput) {
      if (!input.parentTaskId || !input.ownerRunId || !input.conversationId || !input.finalText.trim()) {
        throw new Error('canonical_core_closeout_test_input_invalid')
      }
      await onCommit?.(input)
      const canonicalMessage = buildCanonicalCoreCloseoutMessage({
        parentTaskId: input.parentTaskId,
        ownerRunId: input.ownerRunId,
        conversationId: input.conversationId,
        finalText: input.finalText,
        timestamp: input.now || '2026-01-01T00:00:00.000Z',
        terminalReason: input.terminalReason,
        completionVerifierReceipt: input.completionVerifierReceipt,
      })
      return {
        canonicalMessage,
        canonicalMessageDigest: workflowDigest(canonicalMessage),
      }
    },
  }
}
