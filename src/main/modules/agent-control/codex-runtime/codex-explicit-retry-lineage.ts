import type {
  CodexBindingRepository,
  CodexProductTurnRuntimeRead,
} from './codex-binding-repository'
import type { CodexRetryArtifactSource } from './codex-product-run-preparer'
import type { ProductTurnReceipt } from '../../../../shared/ipc-contracts/agent-runtime'

type RetryLineageNode = {
  runtime: CodexProductTurnRuntimeRead
  receipt: ProductTurnReceipt
}

function retryArtifactSources(nodes: readonly RetryLineageNode[]): CodexRetryArtifactSource[] {
  const sources = new Map<string, CodexRetryArtifactSource>()
  for (const node of nodes) {
    if (node.runtime.prepared.ingress.attemptKind === 'explicit_retry') {
      for (const source of node.runtime.prepared.ingress.artifactSources ?? []) {
        sources.set(source.relativePath, source)
      }
    }
    for (const artifact of node.receipt.artifacts) {
      if (!artifact.logicalArtifactRef || !artifact.version || !artifact.sha256
        || !['staged', 'exported', 'verified', 'indeterminate'].includes(artifact.state)) continue
      const inherited = sources.get(artifact.relativePath)
      const sameSource = inherited
        && inherited.logicalArtifactRef === artifact.logicalArtifactRef
        && inherited.version === artifact.version
        && inherited.sha256 === artifact.sha256
      sources.set(artifact.relativePath, {
        sourceReadyRunId: sameSource ? inherited.sourceReadyRunId : node.runtime.readyRunId,
        relativePath: artifact.relativePath,
        logicalArtifactRef: artifact.logicalArtifactRef,
        version: artifact.version,
        sha256: artifact.sha256,
        state: artifact.state as CodexRetryArtifactSource['state'],
      })
    }
  }
  return Array.from(sources.values())
}

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
  artifactSources: CodexRetryArtifactSource[]
} {
  const requested = input.repository.readProductTurnRuntime(input.requestedRunId)
  const requestedReceipt = input.repository.readProductTurnPresentation(input.requestedRunId)
  if (requestedReceipt.presentationDigest !== input.requestedPresentationDigest
    || requested.readyScopeId !== input.readyScopeId
    || requestedReceipt.readyScopeId !== input.readyScopeId
    || !requestedReceipt.failure) {
    throw new Error('codex_explicit_retry_predecessor_invalid')
  }

  const nodes: RetryLineageNode[] = [{ runtime: requested, receipt: requestedReceipt }]
  let taskContext = requested
  const ancestorIds = new Set([requested.readyRunId])
  while (taskContext.prepared.ingress.attemptKind !== 'user_ingress') {
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
    nodes.unshift({ runtime: taskContext, receipt })
  }

  let predecessor = requested
  let predecessorReceipt = requestedReceipt
  const successorIds = new Set(ancestorIds)
  while (true) {
    const successorRunId = input.repository.readProductTurnSuccessorId(predecessor.readyRunId)
    if (!successorRunId) break
    if (successorIds.has(successorRunId)) throw new Error('codex_explicit_retry_lineage_invalid')
    successorIds.add(successorRunId)
    predecessor = input.repository.readProductTurnRuntime(successorRunId)
    predecessorReceipt = input.repository.readProductTurnPresentation(successorRunId)
    if (predecessor.readyScopeId !== input.readyScopeId
      || predecessorReceipt.readyScopeId !== input.readyScopeId
      || !predecessorReceipt.failure) {
      throw new Error('codex_explicit_retry_predecessor_invalid')
    }
    nodes.push({ runtime: predecessor, receipt: predecessorReceipt })
  }

  return {
    taskContext,
    predecessor,
    predecessorReceipt,
    artifactSources: retryArtifactSources(nodes),
  }
}
