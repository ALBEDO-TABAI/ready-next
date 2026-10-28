/** Durable model routes and request/response receipts. This module never opens a provider connection. */
import type { DatabaseConnection } from '../../database/connection'
import type { CodexModelGatewayBindingRead, CodexModelGatewayBindingReadInput } from './codex-binding-repository'
import { CodexModelGatewayAuthorityError } from './codex-model-gateway-common'
import {
  classifyCodexModelGatewayRequest,
  type CodexModelGatewayFailureEvidence,
  type CodexModelGatewayRequestEvidence,
  type CodexModelGatewayRequestKind,
  type CodexModelGatewayResponseEvidence,
  type CodexUpstreamProfileSnapshot,
  digestCanonicalJson,
} from './codex-model-gateway-contract'
import type {
  CodexModelGatewayBinding,
  CodexModelGatewayMetadata,
  CodexModelGatewayToolResponseCall,
} from './codex-model-gateway-types'

type RunResult = { changes?: number }

const DELIVERY_LANE_TOOL_NAMES = new Set([
  'declare_completion_criteria',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
])

function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}

function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new CodexModelGatewayAuthorityError(code)
}

function assertFailureEvidence(value: CodexModelGatewayFailureEvidence): void {
  const keys = Object.keys(value).sort().join(',')
  if (keys !== [
    'causeCode', 'elapsedMs', 'eventCount', 'failureClass', 'failureStage',
    'partialAssistantItemSeen', 'responseIdentitySeen', 'toolCallItemSeen', 'wireByteCount',
  ].sort().join(',')
    || !['provider', 'transport', 'protocol', 'context'].includes(value.failureClass)
    || !['connect', 'headers', 'stream-before-item', 'stream-after-item', 'terminal-validation', 'post-terminal']
      .includes(value.failureStage)
    || !/^[a-z][a-z0-9_]{2,95}$/.test(value.causeCode)
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
    || !Number.isSafeInteger(value.wireByteCount) || value.wireByteCount < 0
    || typeof value.responseIdentitySeen !== 'boolean'
    || typeof value.partialAssistantItemSeen !== 'boolean'
    || typeof value.toolCallItemSeen !== 'boolean') {
    throw new CodexModelGatewayAuthorityError('gateway_failure_evidence_invalid')
  }
}

function parseSnapshot(value: string): CodexUpstreamProfileSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexModelGatewayAuthorityError('gateway_snapshot_json_invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexModelGatewayAuthorityError('gateway_snapshot_json_invalid')
  }
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    Object.freeze(candidate)
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child)
  }
  freeze(parsed)
  return parsed as CodexUpstreamProfileSnapshot
}

export class CodexModelGatewayRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly bindingReader?: {
      readModelGatewayBinding(input: CodexModelGatewayBindingReadInput): CodexModelGatewayBindingRead
      admitToolResponseGroup(input: {
        gatewayRequestReceiptId: string
        readyRunId: string
        codexThreadId: string
        codexTurnId: string
        calls: readonly CodexModelGatewayToolResponseCall[]
        admittedAt: string
      }): void
    },
  ) {}

  storeSnapshot(input: {
    snapshotRef: string
    snapshotDigest: string
    snapshot: CodexUpstreamProfileSnapshot
    createdAt: string
  }): void {
    for (const value of [input.snapshotRef, input.snapshotDigest, input.createdAt]) {
      nonEmpty(value, 'gateway_snapshot_identity_invalid')
    }
    if (digestCanonicalJson(input.snapshot) !== input.snapshotDigest) {
      throw new CodexModelGatewayAuthorityError('gateway_snapshot_digest_mismatch')
    }
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO ready_model_gateway_profile_snapshots (
        snapshot_ref, snapshot_digest, profile_id, snapshot_json,
        credential_reference_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.snapshotRef,
      input.snapshotDigest,
      input.snapshot.profileId,
      JSON.stringify(input.snapshot),
      input.snapshot.credentialReferenceId,
      input.createdAt,
    )
    const row = this.db.prepare(`
      SELECT snapshot_digest, snapshot_json, credential_reference_id
        FROM ready_model_gateway_profile_snapshots WHERE snapshot_ref = ?
    `).get<{
      snapshot_digest: string
      snapshot_json: string
      credential_reference_id: string
    }>(input.snapshotRef)
    if (
      !row
      || row.snapshot_digest !== input.snapshotDigest
      || row.snapshot_json !== JSON.stringify(input.snapshot)
      || row.credential_reference_id !== input.snapshot.credentialReferenceId
      || (changes(inserted) !== 0 && changes(inserted) !== 1)
    ) throw new CodexModelGatewayAuthorityError('gateway_snapshot_readback_mismatch')
  }

  readSnapshot(snapshotRef: string, snapshotDigest: string): CodexUpstreamProfileSnapshot {
    const row = this.db.prepare(`
      SELECT snapshot_digest, snapshot_json, credential_reference_id
        FROM ready_model_gateway_profile_snapshots WHERE snapshot_ref = ?
    `).get<{
      snapshot_digest: string
      snapshot_json: string
      credential_reference_id: string
    }>(snapshotRef)
    if (!row || row.snapshot_digest !== snapshotDigest) {
      throw new CodexModelGatewayAuthorityError('gateway_snapshot_not_found')
    }
    const snapshot = parseSnapshot(row.snapshot_json)
    if (
      digestCanonicalJson(snapshot) !== snapshotDigest
      || snapshot.credentialReferenceId !== row.credential_reference_id
    ) throw new CodexModelGatewayAuthorityError('gateway_snapshot_readback_mismatch')
    return snapshot
  }

  readTurnGatewayEvidence(input: {
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
  }): Array<{
    requestSequence: number
    responseSequence: number | null
    receiptId: string
    requestKind: CodexModelGatewayRequestKind
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
    upstreamProfileSnapshotDigest: string
    requestDigest: string
    instructionDigest: string
    inputDigest: string
    inputItems: Array<{
      digest: string
      totalStringCharacters: number
      maxStringCharacters: number
    }>
    inputTotalStringCharacters: number
    inputMaxStringCharacters: number
    toolsDigest: string
    toolCount: number
    bodyBytes: number
    memoryHistoryRedactionDigest: string | null
    memoryHistoryRedactedItemCount: number | null
    requestEvidenceDigest: string
    responseId: string | null
    responseTerminalDigest: string | null
    responseOutputDigest: string | null
    responseUsageDigest: string | null
    responseEvidenceDigest: string | null
    failure: CodexModelGatewayFailureEvidence | null
    failureEvidenceDigest: string | null
  }> {
    const rows = this.db.prepare(`
      SELECT request_event.event_sequence AS requestSequence,
             response_event.event_sequence AS responseSequence,
             receipt.receipt_id AS receiptId,
             receipt.request_kind AS requestKind,
             receipt.ready_run_id AS readyRunId,
             receipt.codex_thread_id AS codexThreadId,
             receipt.codex_turn_id AS codexTurnId,
             receipt.upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest,
             receipt.request_digest AS requestDigest,
             request_event.instruction_digest AS instructionDigest,
             request_event.input_digest AS inputDigest,
             request_event.input_items_json AS inputItemsJson,
             request_event.input_total_string_characters AS inputTotalStringCharacters,
             request_event.input_max_string_characters AS inputMaxStringCharacters,
             request_event.tools_digest AS toolsDigest,
             request_event.tool_count AS toolCount,
             request_event.body_bytes AS bodyBytes,
             request_event.memory_history_redaction_digest AS memoryHistoryRedactionDigest,
             request_event.memory_history_redacted_item_count AS memoryHistoryRedactedItemCount,
             request_event.evidence_digest AS requestEvidenceDigest,
             response_event.response_id AS responseId,
             response_event.terminal_digest AS responseTerminalDigest,
             response_event.output_digest AS responseOutputDigest,
             response_event.usage_digest AS responseUsageDigest,
             response_event.evidence_digest AS responseEvidenceDigest,
             response_event.failure_json AS failureJson,
             response_event.failure_digest AS failureEvidenceDigest
        FROM ready_model_gateway_request_receipts receipt
        LEFT JOIN ready_model_gateway_exchange_events request_event
          ON request_event.gateway_request_receipt_id = receipt.receipt_id
         AND request_event.event_kind = 'request_admitted'
        LEFT JOIN ready_model_gateway_exchange_events response_event
          ON response_event.gateway_request_receipt_id = receipt.receipt_id
         AND response_event.event_kind IN ('response_completed', 'response_failed')
       WHERE receipt.ready_run_id = ?
         AND receipt.codex_thread_id = ?
         AND receipt.codex_turn_id = ?
         AND receipt.manual_compaction_id IS NULL
       ORDER BY COALESCE(request_event.event_sequence, 9223372036854775807),
                receipt.accepted_at,
                receipt.receipt_id
    `).all<{
      requestSequence: number | null
      responseSequence: number | null
      receiptId: string
      requestKind: CodexModelGatewayRequestKind
      readyRunId: string
      codexThreadId: string
      codexTurnId: string
      upstreamProfileSnapshotDigest: string
      requestDigest: string
      instructionDigest: string | null
      inputDigest: string | null
      inputItemsJson: string | null
      inputTotalStringCharacters: number | null
      inputMaxStringCharacters: number | null
      toolsDigest: string | null
      toolCount: number | null
      bodyBytes: number | null
      memoryHistoryRedactionDigest: string | null
      memoryHistoryRedactedItemCount: number | null
      requestEvidenceDigest: string | null
      responseId: string | null
      responseTerminalDigest: string | null
      responseOutputDigest: string | null
      responseUsageDigest: string | null
      responseEvidenceDigest: string | null
      failureJson: string | null
      failureEvidenceDigest: string | null
    }>(input.readyRunId, input.codexThreadId, input.codexTurnId)
    return rows.map(({ inputItemsJson, failureJson, ...row }) => {
      if (
        row.requestSequence === null
        || row.requestSequence < 1
        || row.instructionDigest === null
        || row.inputDigest === null
        || inputItemsJson === null
        || row.inputTotalStringCharacters === null
        || row.inputMaxStringCharacters === null
        || row.toolsDigest === null
        || row.toolCount === null
        || row.bodyBytes === null
        || row.requestEvidenceDigest === null
      ) {
        throw new CodexModelGatewayAuthorityError('gateway_request_transcript_missing')
      }
      let inputItems: unknown
      try {
        inputItems = JSON.parse(inputItemsJson)
      } catch {
        throw new CodexModelGatewayAuthorityError('gateway_request_transcript_json_invalid')
      }
      if (!Array.isArray(inputItems) || inputItems.some((value) => (
        !value || typeof value !== 'object' || Array.isArray(value)
        || typeof (value as { digest?: unknown }).digest !== 'string'
        || !Number.isSafeInteger((value as { totalStringCharacters?: unknown }).totalStringCharacters)
        || !Number.isSafeInteger((value as { maxStringCharacters?: unknown }).maxStringCharacters)
      ))) {
        throw new CodexModelGatewayAuthorityError('gateway_request_transcript_json_invalid')
      }
      let failure: CodexModelGatewayFailureEvidence | null = null
      if (failureJson !== null) {
        try {
          failure = JSON.parse(failureJson) as CodexModelGatewayFailureEvidence
        } catch {
          throw new CodexModelGatewayAuthorityError('gateway_failure_evidence_json_invalid')
        }
        assertFailureEvidence(failure)
        if (digestCanonicalJson(failure) !== row.failureEvidenceDigest) {
          throw new CodexModelGatewayAuthorityError('gateway_failure_evidence_digest_mismatch')
        }
      } else if (row.failureEvidenceDigest !== null) {
        throw new CodexModelGatewayAuthorityError('gateway_failure_evidence_pair_invalid')
      }
      if (row.responseSequence !== null && (failure !== null) === (row.responseId !== null)) {
        throw new CodexModelGatewayAuthorityError('gateway_terminal_evidence_kind_invalid')
      }
      return {
        ...row,
        requestSequence: row.requestSequence,
        instructionDigest: row.instructionDigest,
        inputDigest: row.inputDigest,
        inputTotalStringCharacters: row.inputTotalStringCharacters,
        inputMaxStringCharacters: row.inputMaxStringCharacters,
        toolsDigest: row.toolsDigest,
        toolCount: row.toolCount,
        bodyBytes: row.bodyBytes,
        memoryHistoryRedactionDigest: row.memoryHistoryRedactionDigest,
        memoryHistoryRedactedItemCount: row.memoryHistoryRedactedItemCount,
        requestEvidenceDigest: row.requestEvidenceDigest,
        failure,
        inputItems: inputItems as Array<{
          digest: string
          totalStringCharacters: number
          maxStringCharacters: number
        }>,
      }
    })
  }

  readManualCompactionGatewayEvidence(input: {
    manualCompactionId: string
    codexThreadId: string
    codexTurnId: string
  }): null | {
    receiptId: string
    upstreamProfileSnapshotDigest: string
    toolsDigest: string
    toolCount: number
    memoryHistoryRedactionDigest: string | null
    memoryHistoryRedactedItemCount: number | null
    requestEvidenceDigest: string
    responseEvidenceDigest: string
  } {
    const rows = this.db.prepare(`
      SELECT receipt.receipt_id AS receiptId,
             receipt.upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest,
             request_event.tools_digest AS toolsDigest,
             request_event.tool_count AS toolCount,
             request_event.memory_history_redaction_digest AS memoryHistoryRedactionDigest,
             request_event.memory_history_redacted_item_count AS memoryHistoryRedactedItemCount,
             request_event.evidence_digest AS requestEvidenceDigest,
             response_event.evidence_digest AS responseEvidenceDigest
        FROM ready_model_gateway_request_receipts receipt
        JOIN ready_model_gateway_exchange_events request_event
          ON request_event.gateway_request_receipt_id = receipt.receipt_id
         AND request_event.event_kind = 'request_admitted'
        JOIN ready_model_gateway_exchange_events response_event
          ON response_event.gateway_request_receipt_id = receipt.receipt_id
         AND response_event.event_kind = 'response_completed'
       WHERE receipt.request_kind = 'manual_compaction'
         AND receipt.manual_compaction_id = ?
         AND receipt.ready_run_id IS NULL
         AND receipt.codex_thread_id = ?
         AND receipt.codex_turn_id = ?
       LIMIT 2
    `).all<{
      receiptId: string
      upstreamProfileSnapshotDigest: string
      toolsDigest: string
      toolCount: number
      memoryHistoryRedactionDigest: string | null
      memoryHistoryRedactedItemCount: number | null
      requestEvidenceDigest: string
      responseEvidenceDigest: string
    }>(input.manualCompactionId, input.codexThreadId, input.codexTurnId)
    if (rows.length === 0) return null
    if (rows.length !== 1) {
      throw new CodexModelGatewayAuthorityError('manual_gateway_evidence_ambiguous')
    }
    return rows[0]
  }

  resolveBinding(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    requestEvidence: CodexModelGatewayRequestEvidence
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
  }): CodexModelGatewayBinding {
    return this.immediate(() => {
      const kind = this.classify(input.metadata)
      return kind === 'manual_compaction'
        ? this.resolveManual(input)
        : this.resolveProduct(input, kind)
    })
  }

  admitToolResponse(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    calls: readonly CodexModelGatewayToolResponseCall[]
    admittedAt: string
  }): void {
    this.immediate(() => {
      if (!this.bindingReader) {
        throw new CodexModelGatewayAuthorityError('gateway_binding_reader_unavailable')
      }
      const kind = this.classify(input.metadata)
      if (kind !== 'product' || !input.metadata.readyRunId) {
        throw new CodexModelGatewayAuthorityError('gateway_tool_response_kind_invalid')
      }
      const receiptId = this.receiptId({
        kind,
        codexThreadId: input.metadata.threadId,
        codexTurnId: input.metadata.turnId,
        readyRunId: input.metadata.readyRunId,
        manualCompactionId: null,
        requestDigest: input.requestDigest,
      })
      this.bindingReader.admitToolResponseGroup({
        gatewayRequestReceiptId: receiptId,
        readyRunId: input.metadata.readyRunId,
        codexThreadId: input.metadata.threadId,
        codexTurnId: input.metadata.turnId,
        calls: input.calls,
        admittedAt: input.admittedAt,
      })
    })
  }

  recordResponseEvidence(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    responseEvidence: CodexModelGatewayResponseEvidence
    completedAt: string
  }): void {
    this.immediate(() => {
      const kind = this.classify(input.metadata)
      const receiptId = this.receiptId({
        kind,
        codexThreadId: input.metadata.threadId,
        codexTurnId: input.metadata.turnId,
        readyRunId: input.metadata.readyRunId,
        manualCompactionId: kind === 'manual_compaction'
          ? this.db.prepare(`
              SELECT manual_compaction_id FROM ready_model_gateway_request_receipts
               WHERE request_kind = 'manual_compaction'
                 AND codex_thread_id = ? AND codex_turn_id = ? AND request_digest = ?
            `).get<{ manual_compaction_id: string }>(
              input.metadata.threadId,
              input.metadata.turnId,
              input.requestDigest,
            )?.manual_compaction_id || null
          : null,
        requestDigest: input.requestDigest,
      })
      for (const [value, code] of [
        [input.responseEvidence.responseId, 'gateway_response_id_invalid'],
        [input.responseEvidence.terminalDigest, 'gateway_response_terminal_digest_invalid'],
        [input.responseEvidence.outputDigest, 'gateway_response_output_digest_invalid'],
        [input.responseEvidence.usageDigest, 'gateway_response_usage_digest_invalid'],
      ] as const) nonEmpty(value, code)
      if ([
        input.responseEvidence.terminalDigest,
        input.responseEvidence.outputDigest,
        input.responseEvidence.usageDigest,
      ].some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
        throw new CodexModelGatewayAuthorityError('gateway_response_digest_invalid')
      }
      const evidenceDigest = digestCanonicalJson({
        gatewayRequestReceiptId: receiptId,
        ...input.responseEvidence,
      })
      const existing = this.db.prepare(`
        SELECT event_kind, evidence_digest FROM ready_model_gateway_exchange_events
         WHERE gateway_request_receipt_id = ?
           AND event_kind IN ('response_completed', 'response_failed')
      `).get<{ event_kind: string; evidence_digest: string }>(receiptId)
      if (existing) {
        if (existing.event_kind === 'response_completed' && existing.evidence_digest === evidenceDigest) return
        throw new CodexModelGatewayAuthorityError('gateway_response_receipt_conflict')
      }
      this.assertResponseOwnerOpen(receiptId)
      const inserted = this.db.prepare(`
        INSERT INTO ready_model_gateway_exchange_events (
          gateway_request_receipt_id, event_kind, response_id,
          terminal_digest, output_digest, usage_digest, evidence_digest, recorded_at
        ) VALUES (?, 'response_completed', ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        input.responseEvidence.responseId,
        input.responseEvidence.terminalDigest,
        input.responseEvidence.outputDigest,
        input.responseEvidence.usageDigest,
        evidenceDigest,
        input.completedAt,
      )
      if (changes(inserted) !== 1) {
        throw new CodexModelGatewayAuthorityError('gateway_response_receipt_insert_failed')
      }
    })
  }

  recordResponseFailureEvidence(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    failureEvidence: CodexModelGatewayFailureEvidence
    failedAt: string
  }): void {
    this.immediate(() => {
      assertFailureEvidence(input.failureEvidence)
      const kind = this.classify(input.metadata)
      const receiptId = this.receiptId({
        kind,
        codexThreadId: input.metadata.threadId,
        codexTurnId: input.metadata.turnId,
        readyRunId: input.metadata.readyRunId,
        manualCompactionId: kind === 'manual_compaction'
          ? this.db.prepare(`
              SELECT manual_compaction_id FROM ready_model_gateway_request_receipts
               WHERE request_kind = 'manual_compaction'
                 AND codex_thread_id = ? AND codex_turn_id = ? AND request_digest = ?
            `).get<{ manual_compaction_id: string }>(
              input.metadata.threadId,
              input.metadata.turnId,
              input.requestDigest,
            )?.manual_compaction_id || null
          : null,
        requestDigest: input.requestDigest,
      })
      const failureDigest = digestCanonicalJson(input.failureEvidence)
      const evidenceDigest = digestCanonicalJson({
        gatewayRequestReceiptId: receiptId,
        failureDigest,
        failedAt: input.failedAt,
      })
      const existing = this.db.prepare(`
        SELECT event_kind, failure_digest, evidence_digest
          FROM ready_model_gateway_exchange_events
         WHERE gateway_request_receipt_id = ?
           AND event_kind IN ('response_completed', 'response_failed')
      `).get<{ event_kind: string; failure_digest: string | null; evidence_digest: string }>(receiptId)
      if (existing) {
        if (existing.event_kind === 'response_failed'
          && existing.failure_digest === failureDigest
          && existing.evidence_digest === evidenceDigest) return
        throw new CodexModelGatewayAuthorityError('gateway_response_receipt_conflict')
      }
      this.assertResponseOwnerOpen(receiptId)
      const inserted = this.db.prepare(`
        INSERT INTO ready_model_gateway_exchange_events (
          gateway_request_receipt_id, event_kind, failure_json,
          failure_digest, evidence_digest, recorded_at
        ) VALUES (?, 'response_failed', ?, ?, ?, ?)
      `).run(
        receiptId,
        JSON.stringify(input.failureEvidence),
        failureDigest,
        evidenceDigest,
        input.failedAt,
      )
      if (changes(inserted) !== 1) {
        throw new CodexModelGatewayAuthorityError('gateway_failure_receipt_insert_failed')
      }
    })
  }

  private assertResponseOwnerOpen(receiptId: string): void {
    const owner = this.db.prepare(`
      SELECT request.request_kind, turn.ready_run_id,
             turn.product_terminal_digest, turn.host_failure_product_terminal_digest
        FROM ready_model_gateway_request_receipts request
        LEFT JOIN codex_turn_bindings turn ON turn.ready_run_id = request.ready_run_id
       WHERE request.receipt_id = ?
    `).get<{
      request_kind: CodexModelGatewayRequestKind
      ready_run_id: string | null
      product_terminal_digest: string | null
      host_failure_product_terminal_digest: string | null
    }>(receiptId)
    if (!owner || (owner.request_kind !== 'manual_compaction'
      && (!owner.ready_run_id || owner.product_terminal_digest || owner.host_failure_product_terminal_digest))) {
      throw new CodexModelGatewayAuthorityError('gateway_response_owner_closed')
    }
  }

  private classify(metadata: CodexModelGatewayMetadata): CodexModelGatewayRequestKind {
    try {
      return classifyCodexModelGatewayRequest(metadata.raw)
    } catch {
      throw new CodexModelGatewayAuthorityError('gateway_request_unclassified')
    }
  }

  private resolveProduct(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    requestEvidence: CodexModelGatewayRequestEvidence
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
  }, kind: 'product' | 'automatic_compaction'): CodexModelGatewayBinding {
    const row = this.readBinding({
      kind,
      codexThreadId: input.metadata.threadId,
      codexForkedFromId: (input.metadata.raw.forked_from_thread_id as string | undefined) ?? null,
      codexTurnId: input.metadata.turnId,
      readyRunId: input.metadata.readyRunId,
      toolSurfaceDigest: input.metadata.toolSurfaceDigest,
      turnContractDigest: input.metadata.turnContractDigest,
      upstreamProfileSnapshotDigest: input.metadata.upstreamProfileSnapshotDigest,
      receivedAt: input.receivedAt,
    })
    const snapshot = this.readSnapshot(
      row.upstreamProfileSnapshotRef,
      row.upstreamProfileSnapshotDigest,
    )
    const admittedIterations = kind === 'product'
      ? this.db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN COALESCE(budget_lane, 'ordinary') = 'ordinary' THEN 1 ELSE 0 END), 0)
              AS ordinary,
            COALESCE(SUM(CASE WHEN budget_lane = 'delivery' THEN 1 ELSE 0 END), 0)
              AS delivery,
            COALESCE(SUM(CASE WHEN budget_lane = 'final' THEN 1 ELSE 0 END), 0)
              AS final
            FROM ready_model_gateway_request_receipts
           WHERE request_kind = 'product' AND ready_run_id = ?
        `).get<{ ordinary: number; delivery: number; final: number }>(row.ownerId)
      : null
    let budgetLane: 'ordinary' | 'delivery' | 'final' | null = null
    if (kind === 'product') {
      if (!row.maxIterations || !row.iterationLanes || !admittedIterations) {
        throw new CodexModelGatewayAuthorityError('gateway_iteration_budget_invalid')
      }
      const names = row.allowedToolNames ?? []
      const hasOrdinary = names.some((name) => !DELIVERY_LANE_TOOL_NAMES.has(name))
      const hasDelivery = names.some((name) => DELIVERY_LANE_TOOL_NAMES.has(name))
      budgetLane = hasOrdinary && admittedIterations.ordinary < row.iterationLanes.ordinary
        ? 'ordinary'
        : hasDelivery && admittedIterations.delivery < row.iterationLanes.delivery
          ? 'delivery'
          : admittedIterations.final < row.iterationLanes.final
            ? 'final'
            : null
      if (!budgetLane) throw new CodexModelGatewayAuthorityError('gateway_iteration_budget_exhausted')
    }
    const binding: CodexModelGatewayBinding = {
      kind,
      codexModel: row.codexModel,
      snapshot,
      snapshotDigest: row.upstreamProfileSnapshotDigest,
      toolSurfaceDigest: kind === 'product' ? row.toolSurfaceDigest : digestCanonicalJson([]),
      requestToolsDigest: kind === 'product' ? row.requestToolsDigest : digestCanonicalJson([]),
      turnContractDigest: row.turnContractDigest,
      instructionContractDigest: row.instructionContractDigest,
      additionalContextDigest: row.additionalContextDigest,
      deliveredUserTail: row.deliveredUserTail,
      forceToolFreeFinalization: budgetLane === 'final',
      allowedToolNames: kind === 'product' ? row.allowedToolNames : null,
      ...(kind === 'product' && this.turnCompactedAutomatically(row.ownerId, input.metadata.threadId, input.metadata.turnId)
        ? { compactedEarlierInTurn: true }
        : {}),
    }
    input.validate(binding)
    this.writeReceipt({
      kind,
      codexThreadId: input.metadata.threadId,
      codexTurnId: input.metadata.turnId,
      readyRunId: row.ownerId,
      manualCompactionId: null,
      snapshotRef: row.upstreamProfileSnapshotRef,
      snapshotDigest: row.upstreamProfileSnapshotDigest,
      requestDigest: input.requestDigest,
      requestEvidence: input.requestEvidence,
      acceptedAt: input.receivedAt,
      budgetLane,
    })
    return binding
  }

  private turnCompactedAutomatically(readyRunId: string, codexThreadId: string, codexTurnId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM ready_model_gateway_request_receipts receipt
        JOIN ready_model_gateway_exchange_events response
          ON response.gateway_request_receipt_id = receipt.receipt_id
         AND response.event_kind = 'response_completed'
       WHERE receipt.ready_run_id = ? AND receipt.codex_thread_id = ? AND receipt.codex_turn_id = ?
         AND receipt.request_kind = 'automatic_compaction'
       LIMIT 1
    `).get(readyRunId, codexThreadId, codexTurnId))
  }

  private resolveManual(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    requestEvidence: CodexModelGatewayRequestEvidence
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
  }): CodexModelGatewayBinding {
    const binding = this.readBinding({
      kind: 'manual_compaction',
      codexThreadId: input.metadata.threadId,
      codexForkedFromId: (input.metadata.raw.forked_from_thread_id as string | undefined) ?? null,
      codexTurnId: input.metadata.turnId,
      readyRunId: null,
      toolSurfaceDigest: null,
      turnContractDigest: null,
      upstreamProfileSnapshotDigest: null,
      receivedAt: input.receivedAt,
    })
    if (binding.toolSurfaceDigest !== digestCanonicalJson([])) {
      throw new CodexModelGatewayAuthorityError('gateway_manual_binding_mismatch')
    }
    const snapshot = this.readSnapshot(
      binding.upstreamProfileSnapshotRef,
      binding.upstreamProfileSnapshotDigest,
    )
    let manualSnapshot: unknown
    try {
      manualSnapshot = JSON.parse(binding.providerSnapshotJson || '')
    } catch {
      throw new CodexModelGatewayAuthorityError('gateway_manual_snapshot_invalid')
    }
    if (digestCanonicalJson(manualSnapshot) !== binding.upstreamProfileSnapshotDigest) {
      throw new CodexModelGatewayAuthorityError('gateway_manual_snapshot_mismatch')
    }
    const resolved: CodexModelGatewayBinding = {
      kind: 'manual_compaction',
      codexModel: binding.codexModel,
      snapshot,
      snapshotDigest: binding.upstreamProfileSnapshotDigest,
      toolSurfaceDigest: binding.toolSurfaceDigest,
      requestToolsDigest: digestCanonicalJson([]),
      turnContractDigest: null,
      instructionContractDigest: binding.instructionContractDigest,
      additionalContextDigest: null,
      deliveredUserTail: [],
      forceToolFreeFinalization: false,
      allowedToolNames: null,
    }
    input.validate(resolved)
    this.writeReceipt({
      kind: 'manual_compaction',
      codexThreadId: input.metadata.threadId,
      codexTurnId: input.metadata.turnId,
      readyRunId: null,
      manualCompactionId: binding.ownerId,
      snapshotRef: binding.upstreamProfileSnapshotRef,
      snapshotDigest: binding.upstreamProfileSnapshotDigest,
      requestDigest: input.requestDigest,
      requestEvidence: input.requestEvidence,
      acceptedAt: input.receivedAt,
      budgetLane: null,
    })
    return resolved
  }

  private readBinding(input: CodexModelGatewayBindingReadInput): CodexModelGatewayBindingRead {
    if (!this.bindingReader) {
      throw new CodexModelGatewayAuthorityError('gateway_binding_reader_unavailable')
    }
    return this.bindingReader.readModelGatewayBinding(input)
  }

  private writeReceipt(input: {
    kind: CodexModelGatewayRequestKind
    codexThreadId: string
    codexTurnId: string
    readyRunId: string | null
    manualCompactionId: string | null
    snapshotRef: string
    snapshotDigest: string
    requestDigest: string
    requestEvidence: CodexModelGatewayRequestEvidence
    acceptedAt: string
    budgetLane: 'ordinary' | 'delivery' | 'final' | null
  }): string {
    const receiptId = this.receiptId(input)
    const existing = this.db.prepare(`
      SELECT receipt_id FROM ready_model_gateway_request_receipts WHERE receipt_id = ?
    `).get<{ receipt_id: string }>(receiptId)
    if (existing) throw new CodexModelGatewayAuthorityError('gateway_request_replayed')
    const inserted = this.db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id,
        ready_run_id, manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at, budget_lane
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      input.kind,
      input.codexThreadId,
      input.codexTurnId,
      input.readyRunId,
      input.manualCompactionId,
      input.snapshotRef,
      input.snapshotDigest,
      input.requestDigest,
      input.acceptedAt,
      input.budgetLane,
    )
    if (changes(inserted) !== 1) {
      throw new CodexModelGatewayAuthorityError('gateway_request_receipt_insert_failed')
    }
    const readback = this.db.prepare(`
      SELECT receipt_id FROM ready_model_gateway_request_receipts WHERE receipt_id = ?
    `).get<{ receipt_id: string }>(receiptId)
    if (readback?.receipt_id !== receiptId) {
      throw new CodexModelGatewayAuthorityError('gateway_request_receipt_readback_failed')
    }
    this.writeRequestTranscript(receiptId, input.requestEvidence, input.acceptedAt)
    return receiptId
  }

  private writeRequestTranscript(
    receiptId: string,
    evidence: CodexModelGatewayRequestEvidence,
    recordedAt: string,
  ): void {
    const digests = [
      evidence.instructionDigest,
      evidence.inputDigest,
      evidence.toolsDigest,
      evidence.memoryHistoryRedactionDigest,
      ...evidence.inputItems.map((item) => item.digest),
    ]
    if (digests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
      throw new CodexModelGatewayAuthorityError('gateway_request_transcript_digest_invalid')
    }
    if (
      !Number.isSafeInteger(evidence.inputTotalStringCharacters)
      || !Number.isSafeInteger(evidence.inputMaxStringCharacters)
      || !Number.isSafeInteger(evidence.toolCount)
      || !Number.isSafeInteger(evidence.bodyBytes)
      || !Number.isSafeInteger(evidence.memoryHistoryRedactedItemCount)
      || evidence.inputItems.some((item) => (
        !Number.isSafeInteger(item.totalStringCharacters)
        || !Number.isSafeInteger(item.maxStringCharacters)
        || item.totalStringCharacters < item.maxStringCharacters
        || item.maxStringCharacters < 0
      ))
      || evidence.inputTotalStringCharacters < evidence.inputMaxStringCharacters
      || evidence.inputMaxStringCharacters < 0
      || evidence.toolCount < 0
      || evidence.bodyBytes <= 0
      || evidence.memoryHistoryRedactedItemCount < 0
    ) throw new CodexModelGatewayAuthorityError('gateway_request_transcript_metrics_invalid')
    const inputItemsJson = JSON.stringify(evidence.inputItems)
    const evidenceDigest = digestCanonicalJson({
      gatewayRequestReceiptId: receiptId,
      ...evidence,
      recordedAt,
    })
    const inserted = this.db.prepare(`
      INSERT INTO ready_model_gateway_exchange_events (
        gateway_request_receipt_id, event_kind, instruction_digest, input_digest,
        input_items_json, input_total_string_characters,
        input_max_string_characters, tools_digest, tool_count,
        body_bytes, memory_history_redaction_digest,
        memory_history_redacted_item_count, evidence_digest, recorded_at
      ) VALUES (?, 'request_admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      evidence.instructionDigest,
      evidence.inputDigest,
      inputItemsJson,
      evidence.inputTotalStringCharacters,
      evidence.inputMaxStringCharacters,
      evidence.toolsDigest,
      evidence.toolCount,
      evidence.bodyBytes,
      evidence.memoryHistoryRedactionDigest,
      evidence.memoryHistoryRedactedItemCount,
      evidenceDigest,
      recordedAt,
    )
    if (changes(inserted) !== 1) {
      throw new CodexModelGatewayAuthorityError('gateway_request_transcript_insert_failed')
    }
  }

  private receiptId(input: {
    kind: CodexModelGatewayRequestKind
    codexThreadId: string
    codexTurnId: string
    readyRunId: string | null
    manualCompactionId: string | null
    requestDigest: string
    snapshotRef?: string
    snapshotDigest?: string
  }): string {
    const storedSnapshot = input.snapshotRef && input.snapshotDigest
      ? { snapshotRef: input.snapshotRef, snapshotDigest: input.snapshotDigest }
      : null
    const receiptSnapshot = storedSnapshot || (() => {
      const row = this.db.prepare(`
          SELECT upstream_profile_snapshot_ref AS snapshot_ref,
                 upstream_profile_snapshot_digest AS snapshot_digest
            FROM ready_model_gateway_request_receipts
           WHERE request_kind = ? AND codex_thread_id = ? AND codex_turn_id = ?
             AND ready_run_id IS ? AND manual_compaction_id IS ? AND request_digest = ?
           LIMIT 1
        `).get<{ snapshot_ref: string; snapshot_digest: string }>(
          input.kind,
          input.codexThreadId,
          input.codexTurnId,
          input.readyRunId,
          input.manualCompactionId,
          input.requestDigest,
        )
      return row ? { snapshotRef: row.snapshot_ref, snapshotDigest: row.snapshot_digest } : null
    })()
    if (!receiptSnapshot) {
      throw new CodexModelGatewayAuthorityError('gateway_request_receipt_not_found')
    }
    return `gateway-request-${digestCanonicalJson({
      kind: input.kind,
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      readyRunId: input.readyRunId,
      manualCompactionId: input.manualCompactionId,
      snapshotRef: receiptSnapshot.snapshotRef,
      snapshotDigest: receiptSnapshot.snapshotDigest,
      requestDigest: input.requestDigest,
    })}`
  }

  private immediate<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
