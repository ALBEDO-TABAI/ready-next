import type {
  CodexHeadActionProjection,
  CodexProductTurnActionProjection,
  ProductTurnReceipt,
} from '../../../shared/ipc-contracts/agent-runtime'
import type { ScopeRunState, ToolTraceEvent } from './types'
import type { WorkbenchMode } from '../../stores/useMode'
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
    contextUsage: receipt.contextUsage || previous.contextUsage || null,
    toolTrace: toolTraceFromProductReceipt(receipt),
    updatedAt: receipt.canonicalMessage.timestamp,
    productTurnReceiptRevision: receipt.revision,
    productTurnPresentationDigest: receipt.presentationDigest,
    productTurnCanonicalMessageId: receipt.canonicalMessage.id,
  }
}

function compareCompleteProjection(
  left: Extract<CodexProductTurnActionProjection, { retryEvidenceKind: 'complete' }>,
  right: Extract<CodexProductTurnActionProjection, { retryEvidenceKind: 'complete' }>,
): number {
  const leftHead = left.headProjectionRef.version
  const rightHead = right.headProjectionRef.version
  const ordered = [
    leftHead.scopeEpoch - rightHead.scopeEpoch,
    leftHead.headGeneration - rightHead.headGeneration,
    leftHead.actionProjectionSequence - rightHead.actionProjectionSequence,
    left.ownerTurnRevision - right.ownerTurnRevision,
    left.currentReadyMemoryRef.stateRevision - right.currentReadyMemoryRef.stateRevision,
    left.currentReadyMemoryRef.revocationRevision - right.currentReadyMemoryRef.revocationRevision,
  ]
  return ordered.find((value) => value !== 0) || 0
}

function projectionMatchesHead(
  projection: CodexProductTurnActionProjection,
  head: CodexHeadActionProjection | null,
): boolean {
  return projection.retryEvidenceKind === 'unavailable_legacy'
    || (head !== null
      && projection.headProjectionRef.digest === head.evidenceDigest
      && JSON.stringify(projection.headProjectionRef.version) === JSON.stringify(head.actionProjectionVersion))
}

export function productTurnActionProjectionMatchesContext(
  projection: CodexProductTurnActionProjection,
  head: CodexHeadActionProjection | null,
  workbenchMode: WorkbenchMode,
): boolean {
  return projectionMatchesHead(projection, head) && (projection.retryEvidenceKind === 'unavailable_legacy'
    || projection.currentTrustedEnvironmentRef.requestedWorkbenchMode === workbenchMode)
}

export function mergeProductTurnActionProjections(input: {
  existing: Record<string, CodexProductTurnActionProjection>
  incoming: readonly CodexProductTurnActionProjection[]
  head: CodexHeadActionProjection | null
  workbenchMode: WorkbenchMode
}): Record<string, CodexProductTurnActionProjection> {
  const merged = Object.fromEntries(Object.entries(input.existing).filter(([, projection]) => (
    projectionMatchesHead(projection, input.head)
  )))
  for (const projection of input.incoming) {
    if (!productTurnActionProjectionMatchesContext(projection, input.head, input.workbenchMode)) continue
    const previous = merged[projection.ownerRunId]
    if (projection.retryEvidenceKind === 'unavailable_legacy') {
      if (!previous || projection.ownerTurnRevision > previous.ownerTurnRevision) {
        merged[projection.ownerRunId] = projection
      }
      continue
    }
    if (!previous || previous.retryEvidenceKind === 'unavailable_legacy'
      || compareCompleteProjection(projection, previous) > 0
      || (compareCompleteProjection(projection, previous) === 0
        && (projection.currentTrustedEnvironmentRef.requestedWorkbenchMode
          !== previous.currentTrustedEnvironmentRef.requestedWorkbenchMode
          || projection.evidenceDigest === previous.evidenceDigest))) {
      merged[projection.ownerRunId] = projection
    }
  }
  return merged
}
