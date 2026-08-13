import type { CanonicalCoreCloseoutInput } from '../../main/modules/repositories/agent-session-checkpoint-repository'
import { buildCanonicalCoreCloseoutMessage } from '../../main/modules/repositories/canonical-core-closeout-message'
import { workflowDigest } from '../../main/modules/repositories/browser-workflow-codec'

export function canonicalCoreCloseoutTestPort(
  onCommit?: (input: CanonicalCoreCloseoutInput) => void | Promise<void>,
) {
  const runMeta = new Map<string, Record<string, unknown>>()
  return {
    getRunMetaRepository() {
      return {
        get(runId: string) {
          return runMeta.get(runId) ?? null
        },
        create(input: Record<string, unknown>) {
          const runId = String(input.runId || '')
          if (!runId) throw new Error('canonical_core_closeout_test_run_id_required')
          const record = { ...input }
          runMeta.set(runId, record)
          return record
        },
        update(runId: string, patch: Record<string, unknown>) {
          const existing = runMeta.get(runId)
          if (!existing) return null
          const record = { ...existing, ...patch, runId }
          runMeta.set(runId, record)
          return record
        },
      }
    },
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
