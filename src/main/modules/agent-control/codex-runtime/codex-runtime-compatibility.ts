import { digestCanonicalJson } from './codex-model-gateway-contract'

export type RuntimeOperation =
  | 'ordinary_continuation'
  | 'fork_from_accepted_prefix'
  | 'reseed_uncommitted_tail'
  | 'manual_compaction'

export type RuntimeUnsupportedReason =
  | 'history_read_rejected'
  | 'native_resume_rejected'
  | 'native_fork_rejected'
  | 'native_reseed_rejected'
  | 'manual_compaction_rejected'

export type RuntimeContinuityTransition = Readonly<{
  sourceManifestDigest: string
  targetManifestDigest: string
  operation: RuntimeOperation
  result: 'compatible' | 'unsupported'
  proofDigest: string
  reason?: RuntimeUnsupportedReason
  /**
   * A runtime upgrade can change Codex's native base instructions, which every request on a resumed thread then
   * carries. The proof measured that a thread whose instruction contract was `sourceDigest` under the source runtime
   * sends exactly `targetDigest` under the target, with Ready's own developer instructions unchanged.
   */
  instructionContract?: Readonly<{ sourceDigest: string; targetDigest: string }>
}>

export type RuntimeContinuityCatalog = Readonly<{
  contract: 'ready_runtime_continuity_catalog_v1'
  targetManifestDigest: string
  transitions: readonly RuntimeContinuityTransition[]
}>

export type RuntimeCompatibility =
  | Readonly<{
      kind: 'compatible'
      sourceManifestDigest: string
      targetManifestDigest: string
      operation: RuntimeOperation
      basis: 'same_verified_runtime' | 'verified_transition'
      proofDigest: string
    }>
  | Readonly<{
      kind: 'unverified'
      sourceManifestDigest: string
      targetManifestDigest: string
      operation: RuntimeOperation
      reason: 'source_unknown' | 'transition_unverified'
    }>
  | Readonly<{
      kind: 'unsupported'
      sourceManifestDigest: string
      targetManifestDigest: string
      operation: RuntimeOperation
      reason: RuntimeUnsupportedReason
      proofDigest: string
    }>

export type RuntimeCompatibilitySet = Readonly<{
  kind: RuntimeCompatibility['kind']
  operation: RuntimeOperation
  targetManifestDigest: string
  sources: readonly RuntimeCompatibility[]
  evidenceDigest: string
}>

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function assertCatalog(catalog: RuntimeContinuityCatalog): void {
  if (catalog.contract !== 'ready_runtime_continuity_catalog_v1'
    || !validDigest(catalog.targetManifestDigest)) {
    throw new Error('runtime_continuity_catalog_invalid')
  }
  const identities = new Set<string>()
  const instructionMappings = new Map<string, string>()
  for (const transition of catalog.transitions) {
    if (!validDigest(transition.sourceManifestDigest)
      || !validDigest(transition.targetManifestDigest)
      || !validDigest(transition.proofDigest)
      || transition.targetManifestDigest !== catalog.targetManifestDigest
      || (transition.result === 'unsupported' && !transition.reason)
      || (transition.result === 'compatible' && transition.reason !== undefined)) {
      throw new Error('runtime_continuity_transition_invalid')
    }
    if (transition.instructionContract) {
      const { sourceDigest, targetDigest } = transition.instructionContract
      if (transition.result !== 'compatible' || !validDigest(sourceDigest) || !validDigest(targetDigest)) {
        throw new Error('runtime_continuity_instruction_contract_invalid')
      }
      const pair = [transition.sourceManifestDigest, transition.targetManifestDigest, sourceDigest].join('\0')
      const declared = instructionMappings.get(pair)
      if (declared !== undefined && declared !== targetDigest) {
        throw new Error('runtime_continuity_instruction_contract_conflict')
      }
      instructionMappings.set(pair, targetDigest)
    }
    const identity = [
      transition.sourceManifestDigest,
      transition.targetManifestDigest,
      transition.operation,
    ].join('\0')
    if (identities.has(identity)) throw new Error('runtime_continuity_transition_conflict')
    identities.add(identity)
  }
}

export function resolveRuntimeOperationCompatibility(input: {
  catalog: RuntimeContinuityCatalog
  sourceManifestDigest: string
  targetManifestDigest: string
  operation: RuntimeOperation
}): RuntimeCompatibility {
  assertCatalog(input.catalog)
  if (!validDigest(input.sourceManifestDigest) || !validDigest(input.targetManifestDigest)) {
    throw new Error('runtime_compatibility_identity_invalid')
  }
  if (input.sourceManifestDigest === input.targetManifestDigest) {
    return {
      kind: 'compatible',
      sourceManifestDigest: input.sourceManifestDigest,
      targetManifestDigest: input.targetManifestDigest,
      operation: input.operation,
      basis: 'same_verified_runtime',
      proofDigest: digestCanonicalJson({
        contract: 'ready_runtime_self_compatibility_v1',
        manifestDigest: input.targetManifestDigest,
        operation: input.operation,
      }),
    }
  }
  if (input.targetManifestDigest !== input.catalog.targetManifestDigest) {
    return {
      kind: 'unverified',
      sourceManifestDigest: input.sourceManifestDigest,
      targetManifestDigest: input.targetManifestDigest,
      operation: input.operation,
      reason: 'transition_unverified',
    }
  }
  const transition = input.catalog.transitions.find((candidate) => (
    candidate.sourceManifestDigest === input.sourceManifestDigest
    && candidate.targetManifestDigest === input.targetManifestDigest
    && candidate.operation === input.operation
  ))
  if (!transition) {
    const sourceKnown = input.catalog.transitions.some((candidate) => (
      candidate.sourceManifestDigest === input.sourceManifestDigest
    ))
    return {
      kind: 'unverified',
      sourceManifestDigest: input.sourceManifestDigest,
      targetManifestDigest: input.targetManifestDigest,
      operation: input.operation,
      reason: sourceKnown ? 'transition_unverified' : 'source_unknown',
    }
  }
  return transition.result === 'compatible'
    ? {
        kind: 'compatible',
        sourceManifestDigest: transition.sourceManifestDigest,
        targetManifestDigest: transition.targetManifestDigest,
        operation: transition.operation,
        basis: 'verified_transition',
        proofDigest: transition.proofDigest,
      }
    : {
        kind: 'unsupported',
        sourceManifestDigest: transition.sourceManifestDigest,
        targetManifestDigest: transition.targetManifestDigest,
        operation: transition.operation,
        reason: transition.reason as RuntimeUnsupportedReason,
        proofDigest: transition.proofDigest,
      }
}

export function resolveRuntimeCompatibilitySet(input: {
  catalog: RuntimeContinuityCatalog
  sourceManifestDigests: readonly string[]
  targetManifestDigest: string
  operation: RuntimeOperation
}): RuntimeCompatibilitySet {
  const sources = [...new Set(input.sourceManifestDigests)].sort().map((sourceManifestDigest) => (
    resolveRuntimeOperationCompatibility({
      catalog: input.catalog,
      sourceManifestDigest,
      targetManifestDigest: input.targetManifestDigest,
      operation: input.operation,
    })
  ))
  if (sources.length === 0) throw new Error('runtime_compatibility_sources_missing')
  const kind: RuntimeCompatibilitySet['kind'] = sources.some((source) => source.kind === 'unsupported')
    ? 'unsupported'
    : sources.some((source) => source.kind === 'unverified')
      ? 'unverified'
      : 'compatible'
  const unsigned = {
    contract: 'ready_runtime_compatibility_set_v1',
    kind,
    operation: input.operation,
    targetManifestDigest: input.targetManifestDigest,
    sources,
  }
  return { ...unsigned, evidenceDigest: digestCanonicalJson(unsigned) }
}

/**
 * The instruction contract a thread created under `sourceManifestDigest` with `lineageInstructionContractDigest`
 * carries under the target runtime, as measured by the verified ordinary-continuation proof; null when undeclared.
 */
export function resolveInstructionContractTransition(input: {
  catalog: RuntimeContinuityCatalog
  sourceManifestDigest: string
  targetManifestDigest: string
  lineageInstructionContractDigest: string
}): string | null {
  assertCatalog(input.catalog)
  if (input.targetManifestDigest !== input.catalog.targetManifestDigest) return null
  const transition = input.catalog.transitions.find((candidate) => (
    candidate.sourceManifestDigest === input.sourceManifestDigest
    && candidate.targetManifestDigest === input.targetManifestDigest
    && candidate.operation === 'ordinary_continuation'
    && candidate.result === 'compatible'
  ))
  return transition?.instructionContract?.sourceDigest === input.lineageInstructionContractDigest
    ? transition.instructionContract.targetDigest
    : null
}
