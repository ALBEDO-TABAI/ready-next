import type { ToolExecutionOutput } from '../../tools-runtime/tool-result-types'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { assertCodexTerminalEvidenceOwners } from '../codex-terminal-evidence-validation'
import { assertCodexTerminalFacts, type CodexTerminalFacts, type CodexTerminalNativeReadbackReceipt } from '../codex-terminal-facts'
import { CodexToolBindingRepository } from '../codex-tool-binding-repository'
import type { CodexBindingContext } from './context'
import { requireThread, requireTurn } from './core'
import { assertNativeTerminalCandidate, changes, isRecord, nonEmpty } from './shared'
import type { CodexEngineTerminalReceiptRead, CodexPublishedToolOutputRead, CodexTerminalCloseoutEvidence, CodexToolPublicationReceiptRead, NativeTerminalCandidate } from './types'

// Engine terminal candidates, tool publication receipts and tool call bindings.

export function readPublishedToolOutputs(context: CodexBindingContext, readyRunId: string): CodexPublishedToolOutputRead[] {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  return context.db.prepare(`
      SELECT admission.codex_call_id, admission.tool_name,
             action.result_json, action.result_digest, action.updated_at
        FROM codex_tool_call_admissions admission
        JOIN codex_tool_call_bindings binding
          ON binding.codex_thread_id = admission.codex_thread_id
         AND binding.codex_turn_id = admission.codex_turn_id
         AND binding.codex_call_id = admission.codex_call_id
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
       WHERE admission.ready_run_id = ?
         AND action.state = 'confirmed'
         AND EXISTS (
           SELECT 1
             FROM codex_tool_response_delivery_attempts delivery
            WHERE delivery.codex_thread_id = binding.codex_thread_id
              AND delivery.codex_turn_id = binding.codex_turn_id
              AND delivery.codex_call_id = binding.codex_call_id
              AND delivery.ready_action_id = binding.ready_action_id
              AND delivery.transport_write_confirmed_at IS NOT NULL
         )
       ORDER BY admission.admitted_at, admission.codex_call_id
    `).all<{
    codex_call_id: string
    tool_name: string
    result_json: string
    result_digest: string
    updated_at: string
  }>(readyRunId).map((row) => {
    let output: unknown
    try {
      output = JSON.parse(row.result_json)
    } catch {
      throw new CodexBindingRepositoryError('published_tool_output_invalid')
    }
    if (!isRecord(output) || digestCanonicalJson(output) !== row.result_digest) {
      throw new CodexBindingRepositoryError('published_tool_output_digest_mismatch')
    }
    return {
      itemId: row.codex_call_id,
      toolName: row.tool_name,
      output: output as unknown as ToolExecutionOutput,
      completedAt: row.updated_at,
    }
  })
}

export function recordEngineTerminalCandidate(context: CodexBindingContext, input: {
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  engineOutcome: 'completed' | 'interrupted' | 'failed'
  candidate: NativeTerminalCandidate
  recordedAt: string
}): CodexEngineTerminalReceiptRead {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.codexThreadId, 'codex_thread_id_invalid')
  nonEmpty(input.codexTurnId, 'codex_turn_id_invalid')
  nonEmpty(input.recordedAt, 'engine_terminal_recorded_at_invalid')
  assertNativeTerminalCandidate(input.candidate)
  const candidateJson = canonicalJson(input.candidate)
  const candidateDigest = digestCanonicalJson(input.candidate)
  context.immediate(() => {
    const row = requireTurn(context, input.readyRunId)
    const thread = requireThread(context, row.thread_binding_id)
    if (row.codex_thread_id !== input.codexThreadId || row.codex_turn_id !== input.codexTurnId) {
      throw new CodexBindingRepositoryError('engine_terminal_identity_mismatch')
    }
    if (input.candidate.readyRunId !== row.ready_run_id
      || input.candidate.readyTaskId !== row.ready_task_id
      || input.candidate.scopeId !== thread.ready_scope_id
      || input.candidate.codexThreadId !== input.codexThreadId
      || input.candidate.codexTurnId !== input.codexTurnId
      || input.candidate.engineOutcome !== input.engineOutcome) {
      throw new CodexBindingRepositoryError('engine_terminal_identity_mismatch')
    }
    if (row.engine_terminal_recorded_at) {
      if (row.engine_terminal_status !== input.engineOutcome
        || row.engine_terminal_candidate_json !== candidateJson
        || row.engine_terminal_candidate_digest !== candidateDigest) {
        throw new CodexBindingRepositoryError('engine_terminal_immutable')
      }
      return
    }
    const result = context.db.prepare(`
        UPDATE codex_turn_bindings
           SET engine_terminal_status = ?, engine_terminal_candidate_json = ?,
               engine_terminal_candidate_digest = ?, engine_terminal_recorded_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND engine_terminal_recorded_at IS NULL
      `).run(
      input.engineOutcome,
      candidateJson,
      candidateDigest,
      input.recordedAt,
      input.recordedAt,
      input.readyRunId,
      row.revision,
    )
    if (changes(result) !== 1) {
      throw new CodexBindingRepositoryError('engine_terminal_cas_failed')
    }
  })
  return context.self.readEngineTerminalCandidate(input.readyRunId) as CodexEngineTerminalReceiptRead
}

export function readEngineTerminalCandidate(context: CodexBindingContext, readyRunId: string): CodexEngineTerminalReceiptRead | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = requireTurn(context, readyRunId)
  if (!row.engine_terminal_recorded_at) return null
  if (!row.codex_thread_id || !row.codex_turn_id || !row.engine_terminal_status
    || !row.engine_terminal_candidate_json || !row.engine_terminal_candidate_digest) {
    throw new CodexBindingRepositoryError('engine_terminal_receipt_incomplete')
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(row.engine_terminal_candidate_json)
  } catch {
    throw new CodexBindingRepositoryError('engine_terminal_candidate_invalid')
  }
  if (digestCanonicalJson(candidate) !== row.engine_terminal_candidate_digest) {
    throw new CodexBindingRepositoryError('engine_terminal_candidate_digest_mismatch')
  }
  assertNativeTerminalCandidate(candidate)
  const thread = requireThread(context, row.thread_binding_id)
  if (candidate.readyRunId !== row.ready_run_id
    || candidate.readyTaskId !== row.ready_task_id
    || candidate.scopeId !== thread.ready_scope_id
    || candidate.codexThreadId !== row.codex_thread_id
    || candidate.codexTurnId !== row.codex_turn_id
    || candidate.engineOutcome !== row.engine_terminal_status) {
    throw new CodexBindingRepositoryError('engine_terminal_identity_mismatch')
  }
  return {
    readyRunId,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    engineOutcome: row.engine_terminal_status,
    candidate,
    candidateDigest: row.engine_terminal_candidate_digest,
    recordedAt: row.engine_terminal_recorded_at,
    revision: row.revision,
  }
}

export function readTerminalCloseoutEvidence(context: CodexBindingContext, readyRunId: string): CodexTerminalCloseoutEvidence | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const turn = requireTurn(context, readyRunId)
  const values = [
    turn.terminal_native_readback_receipt_json,
    turn.terminal_native_readback_receipt_digest,
    turn.terminal_native_readback_revision,
    turn.terminal_facts_json,
    turn.terminal_facts_digest,
  ]
  if (values.every((value) => value === null)) return null
  if (values.some((value) => value === null)) {
    throw new CodexBindingRepositoryError('terminal_facts_incomplete')
  }
  let nativeReadback: CodexTerminalNativeReadbackReceipt
  let terminalFacts: CodexTerminalFacts
  try {
    nativeReadback = JSON.parse(
      turn.terminal_native_readback_receipt_json as string,
    ) as CodexTerminalNativeReadbackReceipt
    terminalFacts = JSON.parse(turn.terminal_facts_json as string) as CodexTerminalFacts
    assertCodexTerminalFacts(terminalFacts)
  } catch {
    throw new CodexBindingRepositoryError('terminal_facts_invalid')
  }
  const { digest: nativeDigest, ...unsignedNativeReadback } = nativeReadback
  if (nativeDigest !== turn.terminal_native_readback_receipt_digest
    || nativeDigest !== digestCanonicalJson(unsignedNativeReadback)
    || nativeReadback.turnRevision !== turn.terminal_native_readback_revision
    || nativeReadback.readyRunId !== turn.ready_run_id
    || nativeReadback.codexThreadId !== turn.codex_thread_id
    || nativeReadback.codexTurnId !== turn.codex_turn_id
    || digestCanonicalJson(terminalFacts) !== turn.terminal_facts_digest) {
    throw new CodexBindingRepositoryError('terminal_facts_digest_mismatch')
  }
  assertCodexTerminalEvidenceOwners(context.db, context.self, { nativeReadback, terminalFacts })
  return { nativeReadback, terminalFacts }
}

export function recordToolPublicationReceipt(context: CodexBindingContext, input: {
  readyRunId: string
  recordedAt: string
}): CodexToolPublicationReceiptRead {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.recordedAt, 'publication_recorded_at_invalid')
  const terminal = context.self.readEngineTerminalCandidate(input.readyRunId)
  if (!terminal) throw new CodexBindingRepositoryError('engine_terminal_receipt_missing')
  const candidate = terminal.candidate as NativeTerminalCandidate
  const publication = context.self.readToolPublicationBarrier({
    readyRunId: input.readyRunId,
    codexThreadId: terminal.codexThreadId,
    codexTurnId: terminal.codexTurnId,
    candidateCalls: candidate.usedToolCalls,
  })
  if (publication.kind !== 'accepted') {
    throw new CodexBindingRepositoryError(`tool_publication_${publication.kind}`)
  }
  const refsJson = canonicalJson(publication.verifiedReceiptRefs)
  const receiptDigest = digestCanonicalJson({
    readyRunId: input.readyRunId,
    engineTerminalCandidateDigest: terminal.candidateDigest,
    verifiedReceiptRefs: publication.verifiedReceiptRefs,
  })
  context.immediate(() => {
    const row = requireTurn(context, input.readyRunId)
    if (row.publication_recorded_at) {
      if (row.publication_receipt_refs_json !== refsJson
        || row.publication_receipt_digest !== receiptDigest) {
        throw new CodexBindingRepositoryError('publication_receipt_immutable')
      }
      return
    }
    const updated = context.db.prepare(`
        UPDATE codex_turn_bindings
           SET publication_receipt_refs_json = ?, publication_receipt_digest = ?,
               publication_recorded_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND engine_terminal_recorded_at IS NOT NULL
           AND publication_recorded_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(
      refsJson,
      receiptDigest,
      input.recordedAt,
      input.recordedAt,
      input.readyRunId,
      row.revision,
    )
    if (changes(updated) !== 1) {
      throw new CodexBindingRepositoryError('publication_receipt_cas_failed')
    }
  })
  return context.self.readToolPublicationReceipt(input.readyRunId) as CodexToolPublicationReceiptRead
}

export function readToolPublicationReceipt(context: CodexBindingContext, readyRunId: string): CodexToolPublicationReceiptRead | null {
  const row = requireTurn(context, readyRunId)
  if (!row.publication_recorded_at) return null
  if (!row.publication_receipt_refs_json || !row.publication_receipt_digest
    || !row.engine_terminal_candidate_digest) {
    throw new CodexBindingRepositoryError('publication_receipt_incomplete')
  }
  let refs: unknown
  try {
    refs = JSON.parse(row.publication_receipt_refs_json)
  } catch {
    throw new CodexBindingRepositoryError('publication_receipt_invalid')
  }
  if (!Array.isArray(refs)
    || !refs.every((entry) => typeof entry === 'string' && entry.length > 0)
    || new Set(refs).size !== refs.length
    || digestCanonicalJson({
      readyRunId,
      engineTerminalCandidateDigest: row.engine_terminal_candidate_digest,
      verifiedReceiptRefs: refs,
    }) !== row.publication_receipt_digest) {
    throw new CodexBindingRepositoryError('publication_receipt_invalid')
  }
  const terminal = context.self.readEngineTerminalCandidate(readyRunId)
  if (!terminal) throw new CodexBindingRepositoryError('engine_terminal_receipt_missing')
  const publication = context.self.readToolPublicationBarrier({
    readyRunId,
    codexThreadId: terminal.codexThreadId,
    codexTurnId: terminal.codexTurnId,
    candidateCalls: (terminal.candidate as NativeTerminalCandidate).usedToolCalls,
  })
  if (publication.kind !== 'accepted'
    || canonicalJson(publication.verifiedReceiptRefs) !== canonicalJson(refs)) {
    throw new CodexBindingRepositoryError('publication_receipt_readback_mismatch')
  }
  return {
    readyRunId,
    verifiedReceiptRefs: refs,
    receiptDigest: row.publication_receipt_digest,
    recordedAt: row.publication_recorded_at,
  }
}

export function readArtifactWriteHead(context: CodexBindingContext, readyRunId: string, relativePath: string): {
  logicalArtifactRef: string
  version: string
  logicalSha256: string
  receiptRefs: string[]
} | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  nonEmpty(relativePath, 'artifact_relative_path_invalid')
  const prepared = context.self.readProductTurnRuntime(readyRunId).prepared
  const frozenRetrySources = prepared.ingress.attemptKind === 'explicit_retry'
    ? prepared.ingress.artifactSources ?? []
    : []
  const rows = context.db.prepare(`
      SELECT binding.ready_action_id, action.receipt_id, action.result_json
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
         AND action.state = 'confirmed'
       WHERE binding.ready_run_id = ?
         AND binding.tool_name = 'skill_write_artifact'
         AND EXISTS (
           SELECT 1 FROM codex_tool_response_delivery_attempts delivery
            WHERE delivery.ready_action_id = binding.ready_action_id
              AND delivery.transport_write_confirmed_at IS NOT NULL
         )
       ORDER BY binding.created_at, binding.ready_action_id
    `).all<{
    ready_action_id: string
    receipt_id: string
    result_json: string
  }>(readyRunId)
  let head: {
    logicalArtifactRef: string
    version: string
    logicalSha256: string
  } | null = null
  const receiptRefs: string[] = []
  for (const row of rows) {
    let result: unknown
    try { result = JSON.parse(row.result_json) } catch {
      throw new CodexBindingRepositoryError('artifact_write_receipt_invalid')
    }
    const outer = isRecord(result) ? result : null
    const envelope = outer && isRecord(outer.envelope) ? outer.envelope : null
    const data = outer && isRecord(outer.data)
      ? outer.data
      : envelope && isRecord(envelope.data) ? envelope.data : null
    if (!data || data.relativePath !== relativePath) continue
    const expectedVersion = data.expectedVersion === null || data.expectedVersion === 'empty'
      ? null
      : typeof data.expectedVersion === 'string' ? data.expectedVersion : undefined
    let expectedHeadVersion = head?.version ?? null
    let retryReceiptRefs: string[] = []
    if (!head && isRecord(data.retrySeed)
      && isRecord(data.retrySeed.source)
      && isRecord(data.retrySeed.copyReceipt)) {
      const source = data.retrySeed.source
      const copy = data.retrySeed.copyReceipt
      const frozen = frozenRetrySources.find((candidate) => (
        candidate.sourceReadyRunId === source.sourceReadyRunId
        && candidate.relativePath === relativePath
      ))
      if (!frozen
        || source.sourceReadyRunId === readyRunId
        || source.version !== frozen.version
        || source.sha256 !== frozen.sha256
        || source.logicalArtifactRef !== frozen.logicalArtifactRef
        || copy.actionId !== `${row.ready_action_id}:cow`
        || copy.expectedVersion !== null
        || copy.mode !== 'replace'
        || typeof copy.version !== 'string'
        || copy.logicalSha256 !== frozen.sha256) {
        throw new CodexBindingRepositoryError('artifact_retry_seed_invalid')
      }
      const sourceHead = context.self.readArtifactWriteHead(frozen.sourceReadyRunId, relativePath)
      if (!sourceHead
        || sourceHead.logicalArtifactRef !== frozen.logicalArtifactRef
        || sourceHead.version !== frozen.version
        || sourceHead.logicalSha256 !== frozen.sha256) {
        throw new CodexBindingRepositoryError('artifact_retry_source_readback_mismatch')
      }
      expectedHeadVersion = copy.version
      retryReceiptRefs = sourceHead.receiptRefs
    }
    if (expectedVersion === undefined
      || expectedVersion !== expectedHeadVersion
      || data.actionId !== row.ready_action_id
      || !['replace', 'append'].includes(String(data.mode))
      || typeof data.logicalArtifactRef !== 'string'
      || typeof data.version !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(data.version)
      || typeof data.logicalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.logicalSha256)) {
      throw new CodexBindingRepositoryError('artifact_write_receipt_chain_invalid')
    }
    head = {
      logicalArtifactRef: data.logicalArtifactRef,
      version: data.version,
      logicalSha256: data.logicalSha256,
    }
    receiptRefs.push(...retryReceiptRefs, row.receipt_id)
  }
  return head ? { ...head, receiptRefs } : null
}

export function bindToolCall(context: CodexBindingContext, input: Parameters<CodexToolBindingRepository['bindToolCall']>[0]): { duplicate: boolean } {
  return context.toolBindings.bindToolCall(input)
}

export function admitToolResponseGroup(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['admitToolResponseGroup']>[0],
): void {
  context.toolBindings.admitToolResponseGroup(input)
}

export function readToolBridgeExecutionBinding(
  context: CodexBindingContext,
  bindingId: string,
): ReturnType<CodexToolBindingRepository['readToolBridgeExecutionBinding']> {
  return context.toolBindings.readToolBridgeExecutionBinding(bindingId)
}

export function readToolCallBinding(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['readToolCallBinding']>[0],
): ReturnType<CodexToolBindingRepository['readToolCallBinding']> {
  return context.toolBindings.readToolCallBinding(input)
}

export function completeToolCall(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['completeToolCall']>[0],
): void {
  context.toolBindings.completeToolCall(input)
}

export function markToolCallDeliveryIntent(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['markToolCallDeliveryIntent']>[0],
): void {
  context.toolBindings.markToolCallDeliveryIntent(input)
}

export function beginToolCallDeliveryAttempt(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['beginToolCallDeliveryAttempt']>[0],
): ReturnType<CodexToolBindingRepository['beginToolCallDeliveryAttempt']> {
  return context.toolBindings.beginToolCallDeliveryAttempt(input)
}

export function readToolCallDeliveryAttempts(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['readToolCallDeliveryAttempts']>[0],
): ReturnType<CodexToolBindingRepository['readToolCallDeliveryAttempts']> {
  return context.toolBindings.readToolCallDeliveryAttempts(input)
}

export function confirmToolCallDeliveryTransportWrite(
  context: CodexBindingContext,
  input: Parameters<CodexToolBindingRepository['confirmToolCallDeliveryTransportWrite']>[0],
): void {
  context.toolBindings.confirmToolCallDeliveryTransportWrite(input)
}
