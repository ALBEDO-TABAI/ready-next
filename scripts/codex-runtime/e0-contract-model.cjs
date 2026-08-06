function validateTurnIngress(value) {
  if (!value || typeof value !== 'object') return { ok: false, code: 'invalid_ingress' }
  if (value.kind === 'user_ingress') {
    const required = [
      'originUserMessageId',
      'canonicalCurrentInputRef',
      'explicitResourceEnvelope',
      'resourceAdditionalContext'
    ]
    const forbidden = [
      'predecessorRunId',
      'signedContinuationContextRef',
      'historyParityEvidenceDigest',
      'currentThreadReadEvidenceDigest',
      'continuationContractDigest'
    ]
    if (value.attemptKind !== 'user_ingress') return { ok: false, code: 'attempt_kind_mismatch' }
    if (required.some((key) => value[key] === undefined || value[key] === null)) {
      return { ok: false, code: 'missing_user_ingress_field' }
    }
    if (forbidden.some((key) => key in value)) return { ok: false, code: 'mixed_ingress_union' }
    return { ok: true, turnStartInput: [value.canonicalCurrentInputRef] }
  }
  if (value.kind === 'non_user_successor') {
    const allowedAttempts = new Set([
      'recovery_successor',
      'checkpoint_successor',
      'explicit_retry'
    ])
    const required = [
      'originUserMessageId',
      'predecessorRunId',
      'signedContinuationContextRef',
      'historyParityEvidenceDigest',
      'currentThreadReadEvidenceDigest',
      'continuationContractDigest'
    ]
    if (!allowedAttempts.has(value.attemptKind)) return { ok: false, code: 'attempt_kind_mismatch' }
    if (required.some((key) => value[key] === undefined || value[key] === null)) {
      return { ok: false, code: 'missing_successor_field' }
    }
    if ('canonicalCurrentInputRef' in value || 'explicitResourceEnvelope' in value) {
      return { ok: false, code: 'mixed_ingress_union' }
    }
    if (!Array.isArray(value.turnStartInput) || value.turnStartInput.length !== 0) {
      return { ok: false, code: 'successor_input_must_be_empty' }
    }
    return { ok: true, turnStartInput: [] }
  }
  return { ok: false, code: 'unknown_ingress_kind' }
}

function selectAgentMessageCandidate(fixture) {
  if (fixture.terminalStatus !== 'completed') {
    return { kind: 'no_candidate', code: 'terminal_not_completed' }
  }
  let lastToolIndex = -1
  const explicitFinals = []
  for (let index = 0; index < fixture.items.length; index += 1) {
    const item = fixture.items[index]
    if (item.type !== 'agentMessage') {
      if (item.type === 'dynamicToolCall') lastToolIndex = index
      continue
    }
    if (!['commentary', 'final_answer', null].includes(item.phase)) {
      return { kind: 'protocol_failure', code: 'unknown_message_phase' }
    }
    if (item.deltas.length > 0 && item.deltas.join('') !== item.completedText) {
      return { kind: 'protocol_failure', code: 'delta_completed_mismatch' }
    }
    if (item.phase === 'final_answer') explicitFinals.push({ item, index })
  }
  if (explicitFinals.length > 1) {
    return { kind: 'protocol_failure', code: 'multiple_explicit_finals' }
  }
  if (explicitFinals.length === 1) {
    const selected = explicitFinals[0]
    const nullAfterFinal = fixture.items
      .slice(selected.index + 1)
      .some((item) => item.type === 'agentMessage' && item.phase === null)
    if (nullAfterFinal) return { kind: 'protocol_failure', code: 'null_after_explicit_final' }
    return {
      kind: 'candidate',
      itemId: selected.item.id,
      body: selected.item.completedText
    }
  }
  const fallback = fixture.items
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => item.type === 'agentMessage' && item.phase === null && index > lastToolIndex)
    .at(-1)
  return fallback
    ? { kind: 'candidate', itemId: fallback.item.id, body: fallback.item.completedText }
    : { kind: 'protocol_failure', code: 'no_legal_candidate' }
}

function resolveStartDelivery(evidence) {
  if (evidence.nativeMatches === 1 && evidence.metadataExact) return 'accepted'
  if (
    evidence.nativeMatches === 0 &&
    evidence.stableZeroReadback &&
    evidence.ownerEvidence &&
    (evidence.typedRpcRejection || evidence.oldProcessStableZero)
  ) {
    return 'proven_absent'
  }
  return 'unknown'
}

function reserveStartIdentitySet({ capacity, used, kind }) {
  const required = kind === 'lazy_root' ? 2 : kind === 'existing_thread' ? 1 : 0
  if (!required) return { accepted: false, reserved: 0, code: 'unknown_reservation_kind' }
  if (capacity - used < required) {
    return { accepted: false, reserved: 0, code: 'start_identity_capacity_exhausted' }
  }
  return { accepted: true, reserved: required }
}

function stableZeroSatisfied({ spawnVisibilityDeadlinePassed, samples }, contract) {
  if (!spawnVisibilityDeadlinePassed) return false
  if (samples.length !== contract.sampleCount) return false
  return samples.every((count) => count === 0)
}

function buildChildEnv(input, contract) {
  const values = {
    PATH: contract.fixedPath,
    LANG: contract.locale,
    LC_ALL: contract.locale,
    TMPDIR: input.tmpDir,
    HOME: input.home,
    CODEX_HOME: input.codexHome,
    READY_CODEX_GATEWAY_URL: input.gatewayUrl,
    READY_CODEX_GATEWAY_TOKEN: input.gatewayToken,
    READY_CODEX_PROCESS_LEASE_ID: input.processLeaseId,
    READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: input.sidecarSpawnInstanceId,
    READY_CODEX_CONNECTION_EPOCH: input.connectionEpoch,
    READY_CODEX_STATE_DIR: input.stateDir
  }
  return Object.fromEntries(contract.allowedKeys.map((key) => [key, values[key]]))
}

function assertExactKeys(value, allowedKeys) {
  const actual = Object.keys(value).sort()
  const allowed = [...allowedKeys].sort()
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    return { ok: false, code: 'outbound_params_not_exact', childBytes: 0 }
  }
  return { ok: true }
}

module.exports = {
  assertExactKeys,
  buildChildEnv,
  reserveStartIdentitySet,
  resolveStartDelivery,
  selectAgentMessageCandidate,
  stableZeroSatisfied,
  validateTurnIngress
}
