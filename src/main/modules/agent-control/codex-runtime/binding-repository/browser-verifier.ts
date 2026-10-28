import { readWorkflowVerifierBundleFromDb } from '../../../repositories/agent-session-checkpoint-route'
import { workflowDigest } from '../../../repositories/browser-workflow-codec'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { codexBrowserVerifierFrozenIdentityDigest, type CodexBrowserVerifierIdentityProjection } from '../codex-browser-verifier-identity'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import type { CodexBindingContext } from './context'
import { requireThread, requireTurn } from './core'
import { assertNativeTerminalCandidate, browserVerifierAttemptFromRow, changes, nonEmpty, parseArrayOrEmptyStrict, parseNullableObjectStrict } from './shared'
import type { CodexBrowserVerifierAttemptOutcome, CodexBrowserVerifierAttemptRead, CodexBrowserVerifierAttemptRow, CodexBrowserVerifierVerdict, NativeTerminalCandidate } from './types'

// Browser verifier attempts.

export function beginBrowserVerifierAttempt(context: CodexBindingContext, input: {
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  candidateDigest: string
  frozenIdentityDigest: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  workflowCloseoutSealDigest: string
  dispatchedAt: string
}): { created: boolean; attempt: CodexBrowserVerifierAttemptRead } {
  for (const value of [
    input.readyRunId,
    input.readyTaskId,
    input.readyScopeId,
    input.readyAliasId,
    input.threadBindingId,
    input.codexThreadId,
    input.codexTurnId,
    input.upstreamProfileSnapshotRef,
    input.dispatchedAt,
  ]) nonEmpty(value, 'browser_verifier_attempt_identity_invalid')
  for (const digest of [
    input.candidateDigest,
    input.frozenIdentityDigest,
    input.upstreamProfileSnapshotDigest,
    input.workflowCloseoutSealDigest,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_digest_invalid')
    }
  }
  if (!Number.isSafeInteger(input.aliasGeneration) || input.aliasGeneration < 1) {
    throw new CodexBindingRepositoryError('browser_verifier_attempt_alias_generation_invalid')
  }
  return context.immediate(() => {
    const turn = requireTurn(context, input.readyRunId)
    const thread = requireThread(context, turn.thread_binding_id)
    if (turn.lifecycle_action) {
      throw new CodexBindingRepositoryError('browser_verifier_lifecycle_action_pending')
    }
    if (
      turn.ready_task_id !== input.readyTaskId
      || turn.thread_binding_id !== input.threadBindingId
      || turn.codex_thread_id !== input.codexThreadId
      || turn.codex_turn_id !== input.codexTurnId
      || turn.effective_upstream_snapshot_ref !== input.upstreamProfileSnapshotRef
      || turn.effective_upstream_snapshot_digest !== input.upstreamProfileSnapshotDigest
      || turn.engine_terminal_status !== 'completed'
      || !turn.engine_terminal_candidate_json
      || thread.ready_scope_id !== input.readyScopeId
      || thread.ready_conversation_alias !== input.readyAliasId
      || thread.alias_generation !== input.aliasGeneration
      || thread.thread_binding_id !== input.threadBindingId
      || turn.product_terminal_digest
      || turn.host_failure_product_terminal_digest
    ) throw new CodexBindingRepositoryError('browser_verifier_attempt_parent_mismatch')
    let candidate: NativeTerminalCandidate
    try {
      candidate = JSON.parse(turn.engine_terminal_candidate_json) as NativeTerminalCandidate
      assertNativeTerminalCandidate(candidate)
    } catch {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_candidate_invalid')
    }
    if (
      candidate.candidateSelection.kind !== 'accepted'
      || candidate.candidateDigest !== input.candidateDigest
    ) throw new CodexBindingRepositoryError('browser_verifier_attempt_candidate_mismatch')
    const workflowInspection = readWorkflowVerifierBundleFromDb(context.db, input.readyTaskId)
    if (
      workflowInspection.inspection.state !== 'sealable'
      || !workflowInspection.bundle
      || workflowDigest(workflowInspection.bundle.seal) !== input.workflowCloseoutSealDigest
    ) throw new CodexBindingRepositoryError('browser_verifier_attempt_workflow_mismatch')
    const projectionRow = context.db.prepare(`
        SELECT task_id, run_id, revision, request_anchor_json, criteria_json,
               model_criteria_json, proof_refs_json, recent_artifacts_json,
               expected_outputs_json
          FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1
      `).get<{
      task_id: string
      run_id: string
      revision: number
      request_anchor_json: string | null
      criteria_json: string | null
      model_criteria_json: string | null
      proof_refs_json: string | null
      recent_artifacts_json: string | null
      expected_outputs_json: string | null
    }>(input.readyTaskId, input.readyRunId)
    if (!projectionRow) {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_projection_missing')
    }
    const product = context.self.readProductTurnRuntime(input.readyRunId)
    const frozenIdentityDigest = codexBrowserVerifierFrozenIdentityDigest({
      product: {
        readyRunId: product.readyRunId,
        readyTaskId: product.readyTaskId,
        readyScopeId: product.readyScopeId,
        readyAliasId: product.readyAliasId,
        aliasGeneration: product.aliasGeneration,
        threadBindingId: product.threadBindingId,
        codexThreadId: product.codexThreadId,
        codexTurnId: product.codexTurnId,
        turnRequestId: product.turnRequestId,
        toolSurfaceDigest: product.toolSurfaceDigest,
        turnContractDigest: product.turnContractDigest,
        upstreamProfileSnapshotRef: product.upstreamProfileSnapshotRef,
        upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
        codexModel: product.codexModel,
      },
      workflowBundle: workflowInspection.bundle,
      projection: {
        taskId: projectionRow.task_id,
        runId: projectionRow.run_id,
        revision: projectionRow.revision,
        requestAnchor: parseNullableObjectStrict(
          projectionRow.request_anchor_json,
          'browser_verifier_attempt_request_anchor_invalid',
        ) as CodexBrowserVerifierIdentityProjection['requestAnchor'],
        criteria: parseNullableObjectStrict(
          projectionRow.criteria_json,
          'browser_verifier_attempt_criteria_invalid',
        ),
        modelCriteria: parseArrayOrEmptyStrict(
          projectionRow.model_criteria_json,
          'browser_verifier_attempt_model_criteria_invalid',
        ).filter((entry): entry is string => typeof entry === 'string'),
        proofRefs: parseArrayOrEmptyStrict(
          projectionRow.proof_refs_json,
          'browser_verifier_attempt_proof_refs_invalid',
        ),
        recentArtifacts: parseArrayOrEmptyStrict(
          projectionRow.recent_artifacts_json,
          'browser_verifier_attempt_recent_artifacts_invalid',
        ) as CodexBrowserVerifierIdentityProjection['recentArtifacts'],
        expectedOutputs: parseArrayOrEmptyStrict(
          projectionRow.expected_outputs_json,
          'browser_verifier_attempt_expected_outputs_invalid',
        ).filter((entry): entry is string => typeof entry === 'string'),
      },
    })
    if (frozenIdentityDigest !== input.frozenIdentityDigest) {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_frozen_identity_mismatch')
    }

    const attemptId = `codex-browser-verifier-${digestCanonicalJson({
        readyRunId: input.readyRunId,
        candidateDigest: input.candidateDigest,
        frozenIdentityDigest: input.frozenIdentityDigest,
      })}`
    const inserted = context.db.prepare(`
        INSERT OR IGNORE INTO codex_browser_verifier_attempts (
          attempt_id, ready_run_id, ready_task_id, ready_scope_id, ready_alias_id,
          alias_generation, thread_binding_id, codex_thread_id, codex_turn_id,
          candidate_digest, frozen_identity_digest, upstream_profile_snapshot_ref,
          upstream_profile_snapshot_digest, workflow_closeout_seal_digest,
          status, dispatched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?)
      `).run(
      attemptId,
      input.readyRunId,
      input.readyTaskId,
      input.readyScopeId,
      input.readyAliasId,
      input.aliasGeneration,
      input.threadBindingId,
      input.codexThreadId,
      input.codexTurnId,
      input.candidateDigest,
      input.frozenIdentityDigest,
      input.upstreamProfileSnapshotRef,
      input.upstreamProfileSnapshotDigest,
      input.workflowCloseoutSealDigest,
      input.dispatchedAt,
    )
    const row = context.db.prepare(`
        SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
      `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
    if (!row) throw new CodexBindingRepositoryError('browser_verifier_attempt_readback_missing')
    const attempt = browserVerifierAttemptFromRow(row)
    if (
      attempt.attemptId !== attemptId
      || attempt.readyTaskId !== input.readyTaskId
      || attempt.readyScopeId !== input.readyScopeId
      || attempt.readyAliasId !== input.readyAliasId
      || attempt.aliasGeneration !== input.aliasGeneration
      || attempt.threadBindingId !== input.threadBindingId
      || attempt.codexThreadId !== input.codexThreadId
      || attempt.codexTurnId !== input.codexTurnId
      || attempt.candidateDigest !== input.candidateDigest
      || attempt.frozenIdentityDigest !== input.frozenIdentityDigest
      || attempt.upstreamProfileSnapshotRef !== input.upstreamProfileSnapshotRef
      || attempt.upstreamProfileSnapshotDigest !== input.upstreamProfileSnapshotDigest
      || attempt.workflowCloseoutSealDigest !== input.workflowCloseoutSealDigest
    ) throw new CodexBindingRepositoryError('browser_verifier_attempt_identity_conflict')
    return { created: changes(inserted) === 1, attempt }
  })
}

export function settleBrowserVerifierAttempt(context: CodexBindingContext, input: {
  readyRunId: string
  attemptId: string
  outcome: CodexBrowserVerifierAttemptOutcome
  verdict: CodexBrowserVerifierVerdict
  sealedCandidateDigest: string | null
  verificationUsage: unknown
  verifiedAt: string
  settledAt: string
}): CodexBrowserVerifierAttemptRead {
  if (
    input.verdict.version !== 1
    || !['accept', 'repair', 'block'].includes(input.verdict.verdict)
    || (input.verdict.verdict === 'accept' && input.outcome !== 'accept')
    || (input.verdict.verdict === 'repair' && input.outcome !== 'repair')
    || (input.verdict.verdict === 'block'
      && !['block', 'invalid', 'provider_unavailable', 'result_unknown', 'identity_drift'].includes(input.outcome))
    || (input.outcome === 'accept' && !input.sealedCandidateDigest)
    || (input.sealedCandidateDigest !== null && !/^[a-f0-9]{64}$/.test(input.sealedCandidateDigest))
  ) throw new CodexBindingRepositoryError('browser_verifier_settlement_invalid')
  return context.immediate(() => {
    const turn = requireTurn(context, input.readyRunId)
    if (turn.lifecycle_action
      || turn.interrupt_requested_at || turn.interrupt_ack_at || turn.interrupt_state_unknown_at) {
      throw new CodexBindingRepositoryError('browser_verifier_settlement_interrupted')
    }
    const row = context.db.prepare(`
        SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
      `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
    if (!row || row.attempt_id !== input.attemptId) {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_not_found')
    }
    const existing = browserVerifierAttemptFromRow(row)
    if (existing.status === 'settled') return existing
    const verdictDigest = digestCanonicalJson(input.verdict)
    const receipt = {
      version: 1,
      attemptId: existing.attemptId,
      readyRunId: existing.readyRunId,
      readyTaskId: existing.readyTaskId,
      readyScopeId: existing.readyScopeId,
      readyAliasId: existing.readyAliasId,
      aliasGeneration: existing.aliasGeneration,
      threadBindingId: existing.threadBindingId,
      codexThreadId: existing.codexThreadId,
      codexTurnId: existing.codexTurnId,
      candidateDigest: existing.candidateDigest,
      frozenIdentityDigest: existing.frozenIdentityDigest,
      upstreamProfileSnapshotRef: existing.upstreamProfileSnapshotRef,
      upstreamProfileSnapshotDigest: existing.upstreamProfileSnapshotDigest,
      workflowCloseoutSealDigest: existing.workflowCloseoutSealDigest,
      outcome: input.outcome,
      verdict: input.verdict,
      verdictDigest,
      sealedCandidateDigest: input.sealedCandidateDigest,
      verificationUsage: input.verificationUsage ?? null,
      dispatchedAt: existing.dispatchedAt,
      verifiedAt: input.verifiedAt,
      settledAt: input.settledAt,
    }
    const receiptDigest = digestCanonicalJson(receipt)
    const updated = context.db.prepare(`
        UPDATE codex_browser_verifier_attempts
           SET status = 'settled', outcome = ?, verdict_json = ?, verdict_digest = ?,
               sealed_candidate_digest = ?, verification_usage_json = ?, receipt_digest = ?,
               verified_at = ?, settled_at = ?
         WHERE ready_run_id = ? AND attempt_id = ? AND status = 'dispatching'
      `).run(
      input.outcome,
      canonicalJson(input.verdict),
      verdictDigest,
      input.sealedCandidateDigest,
      canonicalJson(input.verificationUsage ?? null),
      receiptDigest,
      input.verifiedAt,
      input.settledAt,
      input.readyRunId,
      input.attemptId,
    )
    if (changes(updated) !== 1) {
      throw new CodexBindingRepositoryError('browser_verifier_settlement_conflict')
    }
    const readback = context.db.prepare(`
        SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
      `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
    if (!readback) throw new CodexBindingRepositoryError('browser_verifier_settlement_readback_missing')
    const settled = browserVerifierAttemptFromRow(readback)
    if (settled.receiptDigest !== receiptDigest) {
      throw new CodexBindingRepositoryError('browser_verifier_settlement_readback_mismatch')
    }
    return settled
  })
}

export function readBrowserVerifierAttempt(context: CodexBindingContext, readyRunId: string): CodexBrowserVerifierAttemptRead | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
    `).get<CodexBrowserVerifierAttemptRow>(readyRunId)
  return row ? browserVerifierAttemptFromRow(row) : null
}
