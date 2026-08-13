import type { DatabaseConnection } from '../../database'
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type {
  CodexModelGatewayBindingRead,
  CodexModelGatewayBindingReadInput,
} from './codex-binding-repository'
import {
  classifyCodexModelGatewayRequest,
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  type CodexModelGatewayRequestEvidence,
  type CodexModelGatewayResponseEvidence,
  type CodexUpstreamProfileSnapshot,
} from './codex-model-gateway-contract'
import type {
  CodexModelGatewayAuthority,
  CodexModelGatewayBinding,
  CodexModelGatewayCredentialStore,
  CodexModelGatewayMetadata,
  CodexModelGatewayRequestKind,
  CodexModelGatewayToolResponseCall,
} from './codex-model-gateway'
import { CodexModelGatewayError } from './codex-model-gateway'

type RunResult = { changes?: number }

export class CodexModelGatewayAuthorityError extends CodexModelGatewayError {
  constructor(code: string, status = 409) {
    super(code, status)
    this.name = 'CodexModelGatewayAuthorityError'
  }
}

function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}

function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new CodexModelGatewayAuthorityError(code)
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
    requestEvidenceDigest: string
    responseId: string | null
    responseTerminalDigest: string | null
    responseOutputDigest: string | null
    responseUsageDigest: string | null
    responseEvidenceDigest: string | null
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
             request_event.evidence_digest AS requestEvidenceDigest,
             response_event.response_id AS responseId,
             response_event.terminal_digest AS responseTerminalDigest,
             response_event.output_digest AS responseOutputDigest,
             response_event.usage_digest AS responseUsageDigest,
             response_event.evidence_digest AS responseEvidenceDigest
        FROM ready_model_gateway_request_receipts receipt
        LEFT JOIN ready_model_gateway_exchange_events request_event
          ON request_event.gateway_request_receipt_id = receipt.receipt_id
         AND request_event.event_kind = 'request_admitted'
        LEFT JOIN ready_model_gateway_exchange_events response_event
          ON response_event.gateway_request_receipt_id = receipt.receipt_id
         AND response_event.event_kind = 'response_completed'
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
      requestEvidenceDigest: string | null
      responseId: string | null
      responseTerminalDigest: string | null
      responseOutputDigest: string | null
      responseUsageDigest: string | null
      responseEvidenceDigest: string | null
    }>(input.readyRunId, input.codexThreadId, input.codexTurnId)
    return rows.map(({ inputItemsJson, ...row }) => {
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
        requestEvidenceDigest: row.requestEvidenceDigest,
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
    requestEvidenceDigest: string
    responseEvidenceDigest: string
  } {
    const rows = this.db.prepare(`
      SELECT receipt.receipt_id AS receiptId,
             receipt.upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest,
             request_event.tools_digest AS toolsDigest,
             request_event.tool_count AS toolCount,
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
        SELECT evidence_digest FROM ready_model_gateway_exchange_events
         WHERE gateway_request_receipt_id = ? AND event_kind = 'response_completed'
      `).get<{ evidence_digest: string }>(receiptId)
      if (existing) {
        if (existing.evidence_digest === evidenceDigest) return
        throw new CodexModelGatewayAuthorityError('gateway_response_receipt_conflict')
      }
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
          SELECT COUNT(*) AS count
            FROM ready_model_gateway_request_receipts
           WHERE request_kind = 'product' AND ready_run_id = ?
        `).get<{ count: number }>(row.ownerId)?.count || 0
      : null
    const binding: CodexModelGatewayBinding = {
      kind,
      codexModel: row.codexModel,
      snapshot,
      snapshotDigest: row.upstreamProfileSnapshotDigest,
      toolSurfaceDigest: kind === 'product' ? row.toolSurfaceDigest : digestCanonicalJson([]),
      turnContractDigest: row.turnContractDigest,
      instructionContractDigest: row.instructionContractDigest,
      additionalContextDigest: row.additionalContextDigest,
      forceToolFreeFinalization: kind === 'product'
        && (row.toolCallsExhausted
          || admittedIterations === Number(row.maxIterations) - 1),
      allowedToolNames: kind === 'product' ? row.allowedToolNames : null,
    }
    input.validate(binding)
    if (kind === 'product') {
      if (!row.maxIterations) {
        throw new CodexModelGatewayAuthorityError('gateway_iteration_budget_invalid')
      }
      if (Number(admittedIterations) >= row.maxIterations) {
        throw new CodexModelGatewayAuthorityError('gateway_iteration_budget_exhausted')
      }
    }
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
    })
    return binding
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
      turnContractDigest: null,
      instructionContractDigest: binding.instructionContractDigest,
      additionalContextDigest: null,
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
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        body_bytes, evidence_digest, recorded_at
      ) VALUES (?, 'request_admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export class CodexDatabaseModelGatewayAuthority implements CodexModelGatewayAuthority {
  constructor(private readonly repository: CodexModelGatewayRepository) {}

  async resolve(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    requestEvidence: CodexModelGatewayRequestEvidence
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
  }): Promise<CodexModelGatewayBinding> {
    return this.repository.resolveBinding(input)
  }

  async admitToolResponse(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    calls: readonly CodexModelGatewayToolResponseCall[]
    admittedAt: string
  }): Promise<void> {
    this.repository.admitToolResponse(input)
  }

  async recordResponseEvidence(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    responseEvidence: CodexModelGatewayResponseEvidence
    completedAt: string
  }): Promise<void> {
    this.repository.recordResponseEvidence(input)
  }
}

export class ReadySettingsModelGatewayCredentialStore implements CodexModelGatewayCredentialStore {
  constructor(private readonly settings: Pick<AppSettingsRepository, 'getAIWorkspace'>) {}

  resolve(input: {
    credentialReferenceId: string
    snapshot: CodexUpstreamProfileSnapshot
  }): string {
    const expectedReference = `ai-profile:${input.snapshot.profileId}`
    if (
      input.credentialReferenceId !== expectedReference
      || input.snapshot.credentialReferenceId !== expectedReference
    ) throw new CodexModelGatewayAuthorityError('gateway_credential_reference_mismatch')
    const workspace = this.settings.getAIWorkspace()
    const profile = workspace.profiles.find((candidate) => candidate.id === input.snapshot.profileId)
    if (!profile) throw new CodexModelGatewayAuthorityError('gateway_credential_not_found')
    const credential = profile.config.apiKey || ''
    if (!credential) throw new CodexModelGatewayAuthorityError('gateway_credential_not_found')
    let current: ReturnType<typeof createCodexUpstreamProfileSnapshot>
    try {
      current = createCodexUpstreamProfileSnapshot({
        profileId: input.snapshot.profileId,
        config: profile.config,
        maxRetries: input.snapshot.retryPolicy.maxRetries,
      })
    } catch {
      throw new CodexModelGatewayAuthorityError('gateway_credential_route_drift')
    }
    if (digestCanonicalJson(current.snapshot) !== digestCanonicalJson(input.snapshot)) {
      throw new CodexModelGatewayAuthorityError('gateway_credential_route_drift')
    }
    return credential
  }
}
