import type { DatabaseConnection } from '../../database/connection'
import type { CodexBindingRepository, CodexTerminalCloseoutEvidence } from './codex-binding-repository'
import { CodexModelGatewayRepository } from './codex-model-gateway-authority'
import { CodexToolActionJournal } from './codex-tool-action-journal'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import type { CodexTerminalEvidenceRef } from './codex-terminal-facts'

type OwnerReaders = Pick<CodexBindingRepository,
  'readEngineTerminalCandidate' | 'readBrowserVerifierAttempt' | 'readProductLifecycleAction'>

/** The same owner joins guard canonical writes and cold reads. No reference is authority by itself. */
export function assertCodexTerminalEvidenceOwners(
  db: DatabaseConnection,
  owners: OwnerReaders,
  evidence: CodexTerminalCloseoutEvidence,
): void {
  const { nativeReadback: readback, terminalFacts: facts } = evidence
  const engine = owners.readEngineTerminalCandidate(readback.readyRunId)
  if (!engine) throw new Error('terminal_evidence_engine_missing')
  const gateways = new CodexModelGatewayRepository(db).readTurnGatewayEvidence({
    readyRunId: readback.readyRunId, codexThreadId: readback.codexThreadId, codexTurnId: readback.codexTurnId,
  })
  const effects = new CodexToolActionJournal(db).readSettledProductEffects(readback.readyRunId)
  const match = (reference: CodexTerminalEvidenceRef): boolean => {
    if (reference.readyRunId !== readback.readyRunId || reference.readyScopeId !== readback.readyScopeId
      || reference.messageVisibilityEpoch !== readback.messageVisibilityEpoch
      || reference.aliasGeneration !== readback.aliasGeneration
      || reference.codexThreadId !== readback.codexThreadId || reference.codexTurnId !== readback.codexTurnId) return false
    if (reference.kind === 'native_turn') {
      return reference.receiptId === `engine-terminal:${readback.readyRunId}`
        && reference.revision === 1 && reference.digest === engine.candidateDigest
        && reference.ownerIdentity.nativeTurnId === engine.codexTurnId
        && reference.ownerIdentity.terminalStatus === engine.engineOutcome
    }
    if (reference.kind === 'native_readback') {
      return reference.receiptId === readback.receiptId && reference.digest === readback.digest
        && reference.revision === readback.turnRevision
        && reference.ownerIdentity.connectionEpoch === readback.connectionEpoch
        && reference.ownerIdentity.readRevision === readback.turnRevision
        && reference.ownerIdentity.verifiedThreadId === readback.codexThreadId
        && reference.ownerIdentity.verifiedTurnId === readback.codexTurnId
    }
    if (reference.kind === 'gateway') {
      const row = gateways.find((row) => row.receiptId === reference.receiptId)
      return Boolean(row && reference.ownerIdentity.gatewayRequestReceiptId === row.receiptId
        && reference.revision === reference.ownerIdentity.eventSequence
        && ((reference.revision === row.requestSequence && reference.digest === row.requestEvidenceDigest)
          || (reference.revision === row.responseSequence && reference.digest === row.responseEvidenceDigest)))
    }
    if (reference.kind === 'effect') {
      const ref = reference.effectEvidence
      const row = effects.find((row) => row.readyActionId === ref.readyActionId)
      return Boolean(row && row.actionIdentityDigest === ref.actionIdentityDigest
        && row.revision === reference.revision && row.evidenceDigest === reference.digest
        && row.state === ref.state && (ref.state === 'confirmed'
          ? row.receiptId === ref.receiptId
          : row.revision === ref.sourceRevision && row.evidenceDigest === ref.resolutionEvidenceDigest))
    }
    if (reference.kind === 'verifier') {
      const verifier = owners.readBrowserVerifierAttempt(readback.readyRunId)
      return Boolean(verifier && verifier.status === 'settled'
        && verifier.codexThreadId === readback.codexThreadId && verifier.codexTurnId === readback.codexTurnId
        && reference.receiptId === verifier.attemptId && reference.ownerIdentity.verifierAttemptId === verifier.attemptId
        && reference.revision === 1 && reference.digest === verifier.receiptDigest)
    }
    if (reference.kind === 'lifecycle') {
      const lifecycle = owners.readProductLifecycleAction(readback.readyRunId)
      return Boolean(lifecycle && reference.revision === 1
        && reference.receiptId === `lifecycle:${readback.readyRunId}:${lifecycle.lifecycleAction}`
        && reference.ownerIdentity.lifecycleActionId === `${readback.readyRunId}:${lifecycle.lifecycleAction}`
        && reference.digest === lifecycle.lifecycleActionEvidenceDigest)
    }
    // These union members have no typed-ref producer in this runtime.
    return false
  }
  for (const references of [facts.product.evidence, facts.history.evidence, facts.effect.evidence]) {
    for (const reference of references) {
      if (!match(reference)) throw new Error(`terminal_evidence_owner_mismatch:${reference.kind}`)
      const expectedRefId = reference.kind === 'effect'
        ? `effect:${reference.effectEvidence.readyActionId}:${reference.revision}`
        : reference.kind === 'lifecycle' ? reference.receiptId : `${reference.kind}:${reference.receiptId}`
      if (reference.evidenceRefId !== expectedRefId) throw new Error('terminal_evidence_ref_id_mismatch')
    }
  }
  const expectedGatewayIds = gateways.map((row) => row.receiptId).sort()
  const gatewayIds = (references: CodexTerminalEvidenceRef[]) => references.flatMap((ref) => (
    ref.kind === 'gateway' ? [ref.receiptId] : []
  )).sort()
  const nativePairPresent = (references: CodexTerminalEvidenceRef[]) => (
    references.filter((ref) => ref.kind === 'native_turn').length === 1
    && references.filter((ref) => ref.kind === 'native_readback').length === 1
  )
  if (!nativePairPresent(facts.product.evidence)
    || digestCanonicalJson(gatewayIds(facts.product.evidence)) !== digestCanonicalJson(expectedGatewayIds)
    || (facts.history.kind !== 'reset' && facts.history.kind !== 'closed'
      && (!nativePairPresent(facts.history.evidence)
        || digestCanonicalJson(gatewayIds(facts.history.evidence)) !== digestCanonicalJson(expectedGatewayIds)))
    || facts.effect.evidence.length !== effects.length) {
    throw new Error('terminal_evidence_owner_set_incomplete')
  }
}
