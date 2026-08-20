import type { ProductTurnReceipt } from '../../../shared/ipc-contracts/agent-runtime'
import type { ScopeRunState, ToolTraceEvent } from './types'
import { resolveToolActivityPresentation } from './toolActivityPresentation'

export function toolTraceFromProductReceipt(receipt: ProductTurnReceipt): ToolTraceEvent[] {
  return receipt.tools.flatMap((tool): ToolTraceEvent[] => {
    const timestamp = new Date(receipt.canonicalMessage.timestamp)
    const callText = resolveToolActivityPresentation({ status: 'running', toolName: tool.toolName }).title
    const call: ToolTraceEvent = {
      id: `product:${receipt.readyRunId}:${tool.callId}:call`,
      kind: 'call',
      text: callText,
      timestamp,
      toolName: tool.toolName,
      hideToolName: true,
    }
    if (tool.state === 'pending') return [call]
    const resultText = resolveToolActivityPresentation({
      status: tool.state === 'confirmed' ? 'done' : 'error',
      toolName: tool.toolName,
    }).title
    return [
      call,
      {
        id: `product:${receipt.readyRunId}:${tool.callId}:result`,
        kind: 'result',
        text: resultText,
        timestamp,
        toolName: tool.toolName,
        hideToolName: true,
      },
    ]
  })
}

export function applyProductTurnReceipt(
  previous: ScopeRunState,
  receipt: ProductTurnReceipt,
): ScopeRunState {
  if (previous.requestId && previous.requestId !== receipt.readyRunId) return previous
  if ((previous.productTurnReceiptRevision || 0) > receipt.revision) return previous
  if (
    previous.productTurnReceiptRevision === receipt.revision
    && previous.productTurnPresentationDigest === receipt.presentationDigest
  ) return previous
  const phase = receipt.terminal === 'done'
    ? 'done'
    : receipt.terminal === 'cancelled' || receipt.terminal === 'interrupted'
      ? 'cancelled'
      : 'error'
  return {
    ...previous,
    requestId: receipt.readyRunId,
    taskId: receipt.readyTaskId,
    phase,
    latestText: receipt.canonicalMessage.content,
    toolTrace: toolTraceFromProductReceipt(receipt),
    updatedAt: receipt.canonicalMessage.timestamp,
    productTurnReceiptRevision: receipt.revision,
    productTurnPresentationDigest: receipt.presentationDigest,
    productTurnCanonicalMessageId: receipt.canonicalMessage.id,
  }
}
