import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexProductTurnRuntimeRead } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { resolveCodexExplicitRetryLineage } from '../main/modules/agent-control/codex-runtime/codex-explicit-retry-lineage'
import type { ProductTurnReceipt } from '../shared/ipc-contracts/agent-runtime'
import { withReceiptV3Fields } from './product-turn-action-projection-fixture'
import { digestCodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

const rootInput = [{ type: 'text' as const, text: 'original task', text_elements: [] }]
const rootIngress = {
  kind: 'user_ingress' as const,
  attemptKind: 'user_ingress' as const,
  originUserMessageId: 'message-root',
  canonicalCurrentInputRef: { messageId: 'message-root', input: rootInput },
  explicitResourceEnvelope: { input: [], resourceRefs: [] },
  resourceAdditionalContext: [],
  actionAdmissionRef: {
    headProjectionDigest: 'a'.repeat(64),
    actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 0 },
    actionHeadIdentity: {
      aliasId: 'scope-retry', aliasGeneration: 1, threadBindingId: 'binding-root', headRevision: 1,
    },
  },
  uncommittedTailAssignments: [],
  supersededUncommittedItems: [],
}
const sourceTrustedEnvironmentRef = {
  workbenchMode: 'browser' as const,
  environmentDigest: '9'.repeat(64),
}

function runtime(
  readyRunId: string,
  attemptKind: 'user_ingress' | 'explicit_retry',
  predecessorRunId?: string,
  failed = true,
): CodexProductTurnRuntimeRead {
  const retryIngress = {
    ...rootIngress,
    attemptKind: 'explicit_retry' as const,
    originUserMessageId: `control-${readyRunId}`,
    actionAdmissionRef: undefined,
    predecessorRunId: predecessorRunId as string,
    predecessorPresentationRef: {
      readyRunId: predecessorRunId as string,
      presentationDigest: predecessorRunId === 'run-root' ? 'digest-root' : 'digest-retry-1',
    },
    controlAuditMessageRef: {
      messageId: `control-${readyRunId}`,
      inputDigest: 'b'.repeat(64),
    },
    modelVisibleRootOriginRef: {
      sourceReadyRunId: 'run-root',
      sourceIngressContractDigest: digestCanonicalJson({
        ingress: rootIngress,
        sourceTrustedEnvironmentRef,
      }),
      originUserMessageId: 'message-root',
      inputDigest: digestCodexUserInput(rootInput),
    },
    selectedHistorySeedItemRef: {
      threadBindingId: `binding-${readyRunId}`,
      historySeedDigest: 'c'.repeat(64),
      originUserMessageId: 'message-root',
      inputDigest: digestCodexUserInput(rootInput),
    },
    currentTrustedEnvironmentRef: {
      requestedWorkbenchMode: 'browser' as const,
      trustedWorkbenchMode: 'browser' as const,
      modeDigest: digestCanonicalJson({
        requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
      }),
    },
    uncommittedUserTail: [{
      originUserMessageId: 'message-root', input: rootInput,
      inputDigest: digestCodexUserInput(rootInput), policy: 'untrusted_text_history' as const,
    }],
    uncommittedTailAssignments: [{
      originUserMessageId: 'message-root', inputDigest: digestCodexUserInput(rootInput),
      plan: 'replace_with_explicit_retry' as const,
    }],
    historyParityEvidenceDigest: 'parity', currentThreadReadEvidenceDigest: 'read',
    continuationContractDigest: 'continuation', taskRootInput: rootInput,
    taskRootInputDigest: digestCodexUserInput(rootInput), artifactSources: [],
  }
  return {
    readyRunId,
    readyScopeId: 'scope-retry',
    prepared: {
      sourceTrustedEnvironmentRef,
      ingress: {
        ...(attemptKind === 'user_ingress' ? rootIngress : retryIngress),
      },
    },
  } as unknown as CodexProductTurnRuntimeRead
}

function receipt(
  readyRunId: string,
  presentationDigest: string,
  failed = true,
  artifact?: {
    logicalArtifactRef: string
    version: string
    sha256: string
    state?: 'staged' | 'verified'
  },
): ProductTurnReceipt {
  return {
    ...withReceiptV3Fields({
      readyRunId,
      retryAvailability: failed ? 'ready' : 'not_applicable',
    }),
    readyRunId,
    readyScopeId: 'scope-retry',
    presentationDigest,
    failure: failed ? { code: 'failed' } : null,
    artifacts: artifact ? [{
      relativePath: 'report.md',
      state: artifact.state ?? 'staged',
      logicalArtifactRef: artifact.logicalArtifactRef,
      version: artifact.version,
      sha256: artifact.sha256,
      bytes: 10,
      destinationResourceId: null,
      evidenceRefs: [],
    }] : [],
  } as unknown as ProductTurnReceipt
}

test('Retry keeps the original task root but only accepts the direct failed predecessor', () => {
  const root = runtime('run-root', 'user_ingress')
  const firstRetry = runtime('run-retry-1', 'explicit_retry', root.readyRunId)
  const runtimes = new Map([
    [root.readyRunId, root],
    [firstRetry.readyRunId, firstRetry],
  ])
  const receipts = new Map([
    [root.readyRunId, receipt(root.readyRunId, 'digest-root')],
    [firstRetry.readyRunId, receipt(firstRetry.readyRunId, 'digest-retry-1')],
  ])
  const repository = {
    readProductTurnRuntime: (readyRunId: string) => runtimes.get(readyRunId)!,
    readProductTurnPresentation: (readyRunId: string) => receipts.get(readyRunId)!,
    readProductTurnSuccessorId: (readyRunId: string) => (
      readyRunId === root.readyRunId ? firstRetry.readyRunId : null
    ),
  }

  assert.throws(() => resolveCodexExplicitRetryLineage({
    repository,
    requestedRunId: root.readyRunId,
    requestedPresentationDigest: 'digest-root',
    readyScopeId: 'scope-retry',
  }), /codex_explicit_retry_predecessor_stale/)

  const fromLatestButton = resolveCodexExplicitRetryLineage({
    repository,
    requestedRunId: firstRetry.readyRunId,
    requestedPresentationDigest: 'digest-retry-1',
    readyScopeId: 'scope-retry',
  })
  assert.equal(fromLatestButton.taskContext.readyRunId, root.readyRunId)
  assert.equal(fromLatestButton.predecessor.readyRunId, firstRetry.readyRunId)
})

test('Retry lineage has no channel for inheriting staged artifacts', () => {
  const originalArtifact = {
    logicalArtifactRef: 'artifact:root:report',
    version: `sha256:${'a'.repeat(64)}`,
    sha256: 'b'.repeat(64),
  }
  const root = runtime('run-root', 'user_ingress')
  const firstRetry = runtime('run-retry-1', 'explicit_retry', root.readyRunId)
  const runtimes = new Map([
    [root.readyRunId, root],
    [firstRetry.readyRunId, firstRetry],
  ])
  const receipts = new Map([
    [root.readyRunId, receipt(root.readyRunId, 'digest-root', true, originalArtifact)],
    [firstRetry.readyRunId, receipt(firstRetry.readyRunId, 'digest-retry-1')],
  ])
  const repository = {
    readProductTurnRuntime: (readyRunId: string) => runtimes.get(readyRunId)!,
    readProductTurnPresentation: (readyRunId: string) => receipts.get(readyRunId)!,
    readProductTurnSuccessorId: (readyRunId: string) => (
      readyRunId === root.readyRunId ? firstRetry.readyRunId : null
    ),
  }

  const resolved = resolveCodexExplicitRetryLineage({
    repository,
    requestedRunId: firstRetry.readyRunId,
    requestedPresentationDigest: 'digest-retry-1',
    readyScopeId: 'scope-retry',
  })
  assert.equal('artifactSources' in resolved, false)
  assert.deepEqual(resolved.predecessor.prepared.ingress.artifactSources, [])
})

test('Retry refuses to branch from a lineage that already ended successfully', () => {
  const root = runtime('run-root', 'user_ingress')
  const succeeded = runtime('run-retry-done', 'explicit_retry', root.readyRunId)
  const repository = {
    readProductTurnRuntime: (readyRunId: string) => (
      readyRunId === root.readyRunId ? root : succeeded
    ),
    readProductTurnPresentation: (readyRunId: string) => (
      readyRunId === root.readyRunId
        ? receipt(root.readyRunId, 'digest-root')
        : receipt(succeeded.readyRunId, 'digest-done', false)
    ),
    readProductTurnSuccessorId: (readyRunId: string) => (
      readyRunId === root.readyRunId ? succeeded.readyRunId : null
    ),
  }
  assert.throws(
    () => resolveCodexExplicitRetryLineage({
      repository,
      requestedRunId: root.readyRunId,
      requestedPresentationDigest: 'digest-root',
      readyScopeId: 'scope-retry',
    }),
    /codex_explicit_retry_predecessor_stale/,
  )
})
