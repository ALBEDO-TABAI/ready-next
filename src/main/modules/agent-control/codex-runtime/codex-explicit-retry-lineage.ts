import type {
  CodexBindingRepository,
  CodexProductTurnRuntimeRead,
} from './codex-binding-repository'
import type { ProductTurnReceipt } from '../../../../shared/ipc-contracts/agent-runtime'
import { digestCodexUserInput } from './codex-user-input'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export function resolveCodexExplicitRetryLineage(input: {
  repository: Pick<CodexBindingRepository,
    'readProductTurnPresentation' | 'readProductTurnRuntime' | 'readProductTurnSuccessorId'>
  requestedRunId: string
  requestedPresentationDigest: string
  readyScopeId: string
}): {
  taskContext: CodexProductTurnRuntimeRead
  predecessor: CodexProductTurnRuntimeRead
  predecessorReceipt: ProductTurnReceipt
} {
  const requested = input.repository.readProductTurnRuntime(input.requestedRunId)
  const requestedReceipt = input.repository.readProductTurnPresentation(input.requestedRunId)
  if (requestedReceipt.presentationDigest !== input.requestedPresentationDigest
    || requested.readyScopeId !== input.readyScopeId
    || requestedReceipt.readyScopeId !== input.readyScopeId
    || !requestedReceipt.failure
    || requestedReceipt.actionProjection.retry_failed_task.availability !== 'ready') {
    throw new Error('codex_explicit_retry_predecessor_invalid')
  }

  let taskContext = requested
  const retryLineage: CodexProductTurnRuntimeRead[] = []
  const ancestorIds = new Set([requested.readyRunId])
  while (taskContext.prepared.ingress.attemptKind !== 'user_ingress') {
    retryLineage.push(taskContext)
    const predecessorRunId = taskContext.prepared.ingress.predecessorRunId
    if (!predecessorRunId || ancestorIds.has(predecessorRunId)) {
      throw new Error('codex_explicit_retry_lineage_invalid')
    }
    ancestorIds.add(predecessorRunId)
    taskContext = input.repository.readProductTurnRuntime(predecessorRunId)
    const receipt = input.repository.readProductTurnPresentation(predecessorRunId)
    if (taskContext.readyScopeId !== input.readyScopeId
      || receipt.readyScopeId !== input.readyScopeId
      || !receipt.failure) {
      throw new Error('codex_explicit_retry_lineage_invalid')
    }
  }

  if (input.repository.readProductTurnSuccessorId(requested.readyRunId)) {
    throw new Error('codex_explicit_retry_predecessor_stale')
  }
  const root = taskContext.prepared.ingress.canonicalCurrentInputRef
  const rootDigest = digestCodexUserInput(root.input)
  const rootIngressContractDigest = digestCanonicalJson(taskContext.prepared)
  for (const retry of retryLineage) {
    const ingress = retry.prepared.ingress
    if (ingress.attemptKind !== 'explicit_retry'
      || ingress.modelVisibleRootOriginRef?.sourceReadyRunId !== taskContext.readyRunId
      || ingress.modelVisibleRootOriginRef.originUserMessageId !== root.messageId
      || ingress.modelVisibleRootOriginRef.inputDigest !== rootDigest
      || ingress.modelVisibleRootOriginRef.sourceIngressContractDigest !== rootIngressContractDigest
      || ingress.canonicalCurrentInputRef.messageId !== root.messageId
      || ingress.controlAuditMessageRef?.messageId !== ingress.originUserMessageId
      || ingress.currentTrustedEnvironmentRef?.trustedWorkbenchMode
        !== taskContext.prepared.sourceTrustedEnvironmentRef.workbenchMode
      || ingress.predecessorPresentationRef?.readyRunId !== ingress.predecessorRunId) {
      throw new Error('codex_explicit_retry_lineage_invalid')
    }
  }

  return {
    taskContext,
    predecessor: requested,
    predecessorReceipt: requestedReceipt,
  }
}
