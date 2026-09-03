import type { ProductTurnReceipt, SendScopedRequest } from '../../../shared/ipc-contracts/agent-runtime'
import { matchesResumeIntent } from '../../../shared/resume-lexicon'

export type RetryRouteMessage = {
  type: string
  meta?: Record<string, unknown>
}

type ReceiptReadResult = {
  success: boolean
  data?: ProductTurnReceipt | null
}

export type NaturalExplicitRetryRoute =
  | { kind: 'not_applicable' }
  | { kind: 'unavailable' }
  | { kind: 'resolved'; explicitRetry: NonNullable<SendScopedRequest['explicitRetry']> }

function latestTerminalRun(messages: readonly RetryRouteMessage[]): {
  runId: string
  terminalReason: string
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== 'agent') continue
    const runId = typeof message.meta?.runId === 'string' ? message.meta.runId : ''
    const terminalReason = typeof message.meta?.terminalReason === 'string'
      ? message.meta.terminalReason
      : ''
    if (runId && terminalReason) return { runId, terminalReason }
  }
  return null
}

export async function resolveNaturalExplicitRetry(input: {
  content: string
  attachmentCount: number
  currentDocumentAnchorPresent?: boolean
  workbenchResourceCount?: number
  externalReadSlicePresent?: boolean
  messages: readonly RetryRouteMessage[]
  scopeId: string
  messageVisibilityEpoch?: number
  readProductTurnPresentation?: ((readyRunId: string) => Promise<ReceiptReadResult>) | null
}): Promise<NaturalExplicitRetryRoute> {
  if (
    input.attachmentCount > 0
    || input.currentDocumentAnchorPresent === true
    || (input.workbenchResourceCount || 0) > 0
    || input.externalReadSlicePresent === true
    || !matchesResumeIntent(input.content, 'strict')
  ) return { kind: 'not_applicable' }

  const terminal = latestTerminalRun(input.messages)
  if (!terminal || terminal.terminalReason === 'done') return { kind: 'not_applicable' }
  if (!input.readProductTurnPresentation) return { kind: 'unavailable' }

  const result = await input.readProductTurnPresentation(terminal.runId).catch(() => null)
  const receipt = result?.success ? result.data : null
  if (
    !receipt?.failure
    || receipt.actionProjection?.retry_failed_task.availability !== 'ready'
    || receipt.readyRunId !== terminal.runId
    || receipt.readyScopeId !== input.scopeId
    || (
      typeof input.messageVisibilityEpoch === 'number'
      && receipt.messageVisibilityEpoch !== input.messageVisibilityEpoch
    )
  ) return { kind: 'unavailable' }

  return {
    kind: 'resolved',
    explicitRetry: {
      predecessorRunId: receipt.readyRunId,
      predecessorPresentationDigest: receipt.presentationDigest,
    },
  }
}
