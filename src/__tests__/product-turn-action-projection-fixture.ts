import { projectCodexHeadActionProjection, type CodexHeadActionFacts } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import type {
  CodexProductTurnActionProjection,
  ProductTurnReceipt,
} from '../shared/ipc-contracts/agent-runtime'

export function makeProductTurnActionProjection(input: {
  readyRunId: string
  ownerAliasGeneration?: number
  ownerTurnRevision?: number
  retryAvailability?: 'ready' | 'blocked' | 'not_applicable'
}): CodexProductTurnActionProjection {
  const ownerAliasGeneration = input.ownerAliasGeneration ?? 1
  const ownerTurnRevision = input.ownerTurnRevision ?? 1
  const version = {
    scopeEpoch: 0,
    headGeneration: ownerAliasGeneration,
    actionProjectionSequence: 1,
  }
  const retryAvailability = input.retryAvailability ?? 'not_applicable'
  return {
    kind: 'product_turn',
    retryEvidenceKind: 'complete',
    ownerRunId: input.readyRunId,
    ownerAliasGeneration,
    ownerTurnRevision,
    headProjectionRef: { version, digest: '1'.repeat(64) },
    currentReadyMemoryRef: {
      scopeEpoch: 0,
      stateRevision: 1,
      revocationRevision: 0,
      semanticIngressDigest: '2'.repeat(64),
      modelVisiblePayloadEmpty: true,
      eligibilityDigest: '3'.repeat(64),
    },
    currentTrustedEnvironmentRef: {
      requestedWorkbenchMode: 'browser',
      trustedWorkbenchMode: 'browser',
      modeDigest: '4'.repeat(64),
    },
    productTurnActionProjectionVersion: {
      ownerTurnRevision,
      headProjectionVersion: version,
      readyMemoryStateRevision: 1,
      readyMemoryRevocationRevision: 0,
      trustedModeDigest: '4'.repeat(64),
      evidenceDigest: '5'.repeat(64),
    },
    retry_failed_task: {
      availability: retryAvailability,
      blockers: retryAvailability === 'ready' ? [] : ['history_materializing'],
      consequence: null,
    },
    evidenceDigest: '6'.repeat(64),
  }
}

export function withReceiptV3Fields(input: {
  readyRunId: string
  ownerAliasGeneration?: number
  ownerTurnRevision?: number
  retryAvailability?: 'ready' | 'blocked' | 'not_applicable'
}): Pick<ProductTurnReceipt, 'contract' | 'ownerAliasGeneration' | 'actionProjection'> {
  const ownerAliasGeneration = input.ownerAliasGeneration ?? 1
  return {
    contract: 'ready_product_turn_receipt_v3',
    ownerAliasGeneration,
    actionProjection: makeProductTurnActionProjection({
      ...input,
      ownerAliasGeneration,
    }),
  }
}


// Supplies a real Main projection at the IPC boundary, without changing store defaults.
export function makeScopeHeadActionProjection(
  scopeId: string,
  overrides: Partial<CodexHeadActionFacts> = {},
) {
  return projectCodexHeadActionProjection({
    scopeId, scopeEpoch: 0, aliasId: scopeId, aliasGeneration: 1,
    threadBindingId: `binding-${scopeId}`, headRevision: 1, actionProjectionSequence: 1,
    materializationKind: 'fresh_start', materializationState: 'confirmed', codexThreadId: 'native-thread',
    continuationBlocked: false, activeProductFence: false, manualCompactionState: 'none',
    hasLegacyPreparedRun: false, headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol', ...overrides,
  })
}
