import type { DatabaseConnection } from '../../database'
import type {
  ProductTurnArtifactReceipt,
  ProductTurnReceipt,
  ProductTurnToolReceipt,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { CanonicalAssistantMessage } from '../../../../shared/ipc-contracts/canonical-message'
import {
  assertReadyMemorySnapshot,
  digestReadyMemoryValue,
  READY_MEMORY_READ_RECEIPT_CONTRACT,
  type ReadyMemoryReadReceipt,
} from '../ready-memory'
import { digestCanonicalJson } from './codex-model-gateway-contract'

const MAX_RESULT_JSON_BYTES = 256 * 1024
const MAX_VISIBLE_TOOLS = 100

export function codexTerminalPublicMessage(
  status: 'error' | 'cancelled' | 'interrupted',
): string {
  return status === 'error'
    ? '本轮未能完成。已经完成的内容和文件状态都已保留；再次尝试时会先核对已有结果，避免重复执行。'
    : '本轮已停止。停止前已经完成的内容和文件状态都已保留。'
}

type TurnRow = {
  ready_run_id: string
  ready_task_id: string
  ready_scope_id: string
  message_visibility_epoch: number
  revision: number
  product_terminal_digest: string | null
  host_failure_product_terminal_digest: string | null
  publication_receipt_digest: string | null
  ready_memory_snapshot_json: string | null
  ready_memory_snapshot_digest: string | null
  ready_memory_read_receipt_json: string | null
  ready_memory_read_receipt_digest: string | null
  ingress_json: string
  run_status: string
  terminal_reason: string | null
  provider_diagnostics_json: string | null
}

type ToolRow = {
  codex_call_id: string
  tool_name: string
  ready_action_id: string | null
  action_state: string | null
  receipt_id: string | null
  action_revision: number | null
  result_digest: string | null
  result_json: string | null
  resolution_evidence_digest: string | null
  attempt_id: string | null
  transport_write_confirmed_at: string | null
  tool_response_digest: string | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeJson(value: string | null): Record<string, unknown> | null {
  if (!value || Buffer.byteLength(value) > MAX_RESULT_JSON_BYTES) return null
  try {
    return record(JSON.parse(value))
  } catch {
    return null
  }
}

function resultData(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null
  return record(result.data) || record(record(result.envelope)?.data) || result
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function readMemoryReceipt(row: TurnRow): ProductTurnReceipt['memory'] {
  const snapshotPair = [row.ready_memory_snapshot_json, row.ready_memory_snapshot_digest]
  if (snapshotPair.every((value) => value === null)) return null
  if (snapshotPair.some((value) => value === null)) throw new Error('product_turn_memory_snapshot_incomplete')

  let snapshot: unknown
  try {
    snapshot = JSON.parse(row.ready_memory_snapshot_json as string)
    assertReadyMemorySnapshot(snapshot)
  } catch {
    throw new Error('product_turn_memory_snapshot_invalid')
  }
  if (snapshot.snapshotDigest !== row.ready_memory_snapshot_digest) {
    throw new Error('product_turn_memory_snapshot_digest_mismatch')
  }

  const receiptPair = [row.ready_memory_read_receipt_json, row.ready_memory_read_receipt_digest]
  if (receiptPair.every((value) => value === null)) {
    return {
      snapshotDigest: snapshot.snapshotDigest,
      stateRevision: snapshot.stateRevision,
      revocationRevision: snapshot.revocationRevision,
      summaryEntryIds: [...snapshot.summaryEntryIds],
      readEntryIds: [],
      readReceiptDigest: null,
    }
  }
  if (receiptPair.some((value) => value === null)) throw new Error('product_turn_memory_receipt_incomplete')

  let receipt: unknown
  try {
    receipt = JSON.parse(row.ready_memory_read_receipt_json as string)
  } catch {
    throw new Error('product_turn_memory_receipt_invalid')
  }
  const parsed = record(receipt)
  if (!parsed
    || parsed.contract !== READY_MEMORY_READ_RECEIPT_CONTRACT
    || parsed.snapshotDigest !== snapshot.snapshotDigest
    || parsed.stateRevision !== snapshot.stateRevision
    || parsed.revocationRevision !== snapshot.revocationRevision
    || !Array.isArray(parsed.readEntryIds)
    || parsed.readEntryIds.length > 64
    || parsed.readEntryIds.some((entryId) => typeof entryId !== 'string' || !entryId)
    || new Set(parsed.readEntryIds).size !== parsed.readEntryIds.length
    || typeof parsed.readAt !== 'string'
    || Number.isNaN(Date.parse(parsed.readAt))
    || typeof parsed.receiptDigest !== 'string') {
    throw new Error('product_turn_memory_receipt_invalid')
  }
  const typed = parsed as unknown as ReadyMemoryReadReceipt
  const { receiptDigest, ...core } = typed
  if (receiptDigest !== row.ready_memory_read_receipt_digest
    || digestReadyMemoryValue(core) !== receiptDigest
    || typed.readEntryIds.some((entryId) => !snapshot.entries.some((entry) => entry.entryId === entryId))) {
    throw new Error('product_turn_memory_receipt_digest_mismatch')
  }
  return {
    snapshotDigest: snapshot.snapshotDigest,
    stateRevision: snapshot.stateRevision,
    revocationRevision: snapshot.revocationRevision,
    summaryEntryIds: [...snapshot.summaryEntryIds],
    readEntryIds: [...typed.readEntryIds],
    readReceiptDigest: typed.receiptDigest,
  }
}

function readCanonicalMessage(db: DatabaseConnection, row: TurnRow): CanonicalAssistantMessage {
  const messageId = `assistant:${row.ready_task_id}:${row.ready_run_id}:terminal`
  const message = db.prepare(`
    SELECT id, conversation_id, role, content, timestamp, meta_json
      FROM chat_messages WHERE id = ? LIMIT 1
  `).get<{
    id: string
    conversation_id: string
    role: string
    content: string
    timestamp: string
    meta_json: string | null
  }>(messageId)
  if (!message || message.role !== 'assistant' || message.conversation_id !== row.ready_scope_id) {
    throw new Error('product_turn_canonical_message_missing')
  }
  let meta: Record<string, unknown>
  try {
    meta = record(JSON.parse(message.meta_json || '{}')) || {}
  } catch {
    throw new Error('product_turn_canonical_message_invalid')
  }
  return {
    id: message.id,
    conversationId: message.conversation_id,
    role: 'assistant',
    content: message.content,
    timestamp: message.timestamp,
    meta,
  }
}

function toolState(row: ToolRow): ProductTurnToolReceipt['state'] {
  if (!row.action_state) return 'pending'
  if (row.action_state === 'pending' || row.action_state === 'confirmed'
    || row.action_state === 'proven_absent' || row.action_state === 'indeterminate') {
    if (row.action_state === 'confirmed' && !safeJson(row.result_json)) return 'degraded'
    return row.action_state
  }
  return 'degraded'
}

function toolSummary(row: ToolRow, state: ProductTurnToolReceipt['state']): string {
  if (state === 'degraded') return `${row.tool_name}：历史结果无法完整读取`
  if (state === 'confirmed') {
    return row.transport_write_confirmed_at
      ? `${row.tool_name}：已完成并确认返回`
      : `${row.tool_name}：已完成，结果返回待确认`
  }
  if (state === 'indeterminate') return `${row.tool_name}：执行结果待核对`
  if (state === 'proven_absent') return `${row.tool_name}：确认未执行`
  return `${row.tool_name}：尚未完成`
}

function expectedArtifactPaths(rows: ToolRow[]): string[] {
  for (const row of rows) {
    if (row.tool_name !== 'declare_completion_criteria'
      || row.action_state !== 'confirmed'
      || !row.transport_write_confirmed_at) continue
    const data = resultData(safeJson(row.result_json))
    const values = data?.expectedOutputs
    if (Array.isArray(values)) {
      return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    }
  }
  return []
}

function artifactReceipts(rows: ToolRow[]): ProductTurnArtifactReceipt[] {
  const artifacts = new Map<string, ProductTurnArtifactReceipt>()
  for (const relativePath of expectedArtifactPaths(rows)) {
    artifacts.set(relativePath, {
      relativePath,
      state: 'required',
      logicalArtifactRef: null,
      version: null,
      bytes: null,
      sha256: null,
      destinationResourceId: null,
      evidenceRefs: [],
    })
  }
  for (const row of rows) {
    if (row.tool_name !== 'skill_write_artifact' && row.tool_name !== 'skill_export_artifact') continue
    const data = resultData(safeJson(row.result_json))
    const relativePath = text(data?.relativePath) || text(data?.targetRelativePath)
    if (!relativePath) continue
    const previous = artifacts.get(relativePath) || {
      relativePath,
      state: 'required' as const,
      logicalArtifactRef: null,
      version: null,
      bytes: null,
      sha256: null,
      destinationResourceId: null,
      evidenceRefs: [],
    }
    const evidenceRefs = [
      ...previous.evidenceRefs,
      ...(row.receipt_id ? [row.receipt_id] : []),
      ...(row.attempt_id ? [row.attempt_id] : []),
    ]
    let state = previous.state
    if (row.action_state === 'indeterminate') state = 'indeterminate'
    else if (row.action_state === 'proven_absent') state = 'failed'
    else if (row.action_state === 'confirmed' && row.tool_name === 'skill_write_artifact') {
      state = row.transport_write_confirmed_at ? 'staged' : 'indeterminate'
    } else if (row.action_state === 'confirmed' && row.tool_name === 'skill_export_artifact') {
      state = data?.readbackVerified === true && row.transport_write_confirmed_at
        ? 'verified'
        : 'exported'
    }
    artifacts.set(relativePath, {
      relativePath,
      state,
      logicalArtifactRef: text(data?.logicalArtifactRef) || previous.logicalArtifactRef,
      version: text(data?.version) || previous.version,
      bytes: integer(data?.bytes) ?? integer(data?.logicalBytes) ?? previous.bytes,
      sha256: text(data?.sha256) || text(data?.logicalSha256) || previous.sha256,
      destinationResourceId: text(data?.destinationResourceId) || previous.destinationResourceId,
      evidenceRefs: Array.from(new Set(evidenceRefs)),
    })
  }
  return Array.from(artifacts.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function terminalStatus(status: string): ProductTurnReceipt['terminal'] {
  if (status === 'done') return 'done'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'interrupted') return 'interrupted'
  return 'error'
}

function failureReceipt(
  row: TurnRow,
  tools: ProductTurnToolReceipt[],
  artifacts: ProductTurnArtifactReceipt[],
): ProductTurnReceipt['failure'] {
  const terminal = terminalStatus(row.run_status)
  if (terminal === 'done') return null
  const diagnostics = safeJson(row.provider_diagnostics_json)
  const evidence = record(diagnostics?.codexFailure)
  const error = text(evidence?.error) || row.terminal_reason || 'unknown'
  const kind = terminal === 'cancelled' || terminal === 'interrupted'
    ? 'cancelled'
    : /artifact|export|staging|file/i.test(error)
      ? 'artifact_delivery'
      : /unknown|indeterminate/i.test(error)
        ? 'tool_effect_unknown'
        : /protocol|event_limit|digest|identity/i.test(error)
          ? 'protocol'
          : /stream|disconnect|timeout|transport/i.test(error)
            ? 'transport'
            : /provider|quota|upstream|verifier_unavailable/i.test(error)
              ? 'provider'
              : 'persistence'
  const hasIndeterminate = tools.some((tool) => tool.state === 'indeterminate')
    || artifacts.some((artifact) => artifact.state === 'indeterminate')
  const hasConfirmed = tools.some((tool) => tool.state === 'confirmed'
    || (tool.state === 'degraded' && tool.actionReceiptId !== null && tool.deliveryConfirmed))
    || artifacts.some((artifact) => artifact.state === 'staged' || artifact.state === 'verified')
  const evidenceRefs = tools.flatMap((tool) => [
    tool.actionReceiptId,
    tool.deliveryAttemptId,
  ]).filter((value): value is string => Boolean(value))
  return {
    kind,
    effectState: hasIndeterminate ? 'indeterminate' : hasConfirmed ? 'confirmed' : 'none',
    retryPolicy: hasIndeterminate
      ? 'readback_first'
      : kind === 'cancelled'
        ? 'reconcile_then_retry'
        : kind === 'artifact_delivery' && artifacts.some((artifact) => artifact.state === 'failed')
          ? 'user_action_required'
          : 'reconcile_then_retry',
    evidenceRefs: Array.from(new Set(evidenceRefs)),
  }
}

function readInSnapshot(db: DatabaseConnection, readyRunId: string): ProductTurnReceipt {
  const row = db.prepare(`
    SELECT turn.ready_run_id, turn.ready_task_id, thread.ready_scope_id,
           turn.message_visibility_epoch, turn.revision,
           turn.product_terminal_digest, turn.host_failure_product_terminal_digest,
           turn.publication_receipt_digest,
           turn.ready_memory_snapshot_json, turn.ready_memory_snapshot_digest,
           turn.ready_memory_read_receipt_json, turn.ready_memory_read_receipt_digest,
           turn.ingress_json,
           run.status AS run_status, run.terminal_reason, run.provider_diagnostics_json
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
      JOIN run_meta run ON run.run_id = turn.ready_run_id
     WHERE turn.ready_run_id = ? LIMIT 1
  `).get<TurnRow>(readyRunId)
  if (!row) throw new Error('product_turn_binding_missing')
  if (!row.product_terminal_digest && !row.host_failure_product_terminal_digest) {
    throw new Error('product_turn_not_terminal')
  }
  const canonicalMessage = readCanonicalMessage(db, row)
  const canonicalMessageDigest = digestCanonicalJson(canonicalMessage)
  const rows = db.prepare(`
    SELECT admission.codex_call_id, admission.tool_name,
           binding.ready_action_id, action.state AS action_state,
           action.receipt_id, action.revision AS action_revision,
           action.result_digest, action.result_json, action.resolution_evidence_digest,
           delivery.attempt_id, delivery.transport_write_confirmed_at,
           delivery.tool_response_digest
      FROM codex_tool_call_admissions admission
      LEFT JOIN codex_tool_call_bindings binding
        ON binding.codex_thread_id = admission.codex_thread_id
       AND binding.codex_turn_id = admission.codex_turn_id
       AND binding.codex_call_id = admission.codex_call_id
      LEFT JOIN ready_tool_action_receipts action
        ON action.ready_action_id = binding.ready_action_id
      LEFT JOIN codex_tool_response_delivery_attempts delivery
        ON delivery.codex_thread_id = binding.codex_thread_id
       AND delivery.codex_turn_id = binding.codex_turn_id
       AND delivery.codex_call_id = binding.codex_call_id
       AND delivery.ready_action_id = binding.ready_action_id
     WHERE admission.ready_run_id = ?
     ORDER BY admission.admitted_at, admission.codex_call_id, delivery.created_at
  `).all<ToolRow>(readyRunId)
  const latestRows = Array.from(rows.reduce((byCall, current) => {
    const previous = byCall.get(current.codex_call_id)
    if (!previous || current.transport_write_confirmed_at || !previous.transport_write_confirmed_at) {
      byCall.set(current.codex_call_id, current)
    }
    return byCall
  }, new Map<string, ToolRow>()).values())
  const tools = latestRows.slice(0, MAX_VISIBLE_TOOLS).map((tool): ProductTurnToolReceipt => {
    const state = toolState(tool)
    return {
      callId: tool.codex_call_id,
      toolName: tool.tool_name,
      state,
      actionReceiptId: tool.receipt_id,
      actionRevision: tool.action_revision,
      resultDigest: tool.result_digest,
      deliveryAttemptId: tool.attempt_id,
      deliveryConfirmed: Boolean(tool.transport_write_confirmed_at),
      summary: toolSummary(tool, state),
    }
  })
  const artifacts = artifactReceipts(rows)
  const memory = readMemoryReceipt(row)
  const failure = failureReceipt(row, tools, artifacts)
  const unsigned = {
    contract: 'ready_product_turn_receipt_v1' as const,
    readyRunId: row.ready_run_id,
    readyTaskId: row.ready_task_id,
    readyScopeId: row.ready_scope_id,
    messageVisibilityEpoch: row.message_visibility_epoch,
    revision: row.revision,
    terminal: terminalStatus(row.run_status),
    canonicalMessage,
    canonicalMessageDigest,
    tools,
    artifacts,
    memory,
    failure,
    publicationSealDigest: row.publication_receipt_digest,
    evidenceDigest: digestCanonicalJson(rows.map((tool) => ({
      callId: tool.codex_call_id,
      actionReceiptId: tool.receipt_id,
      actionRevision: tool.action_revision,
      resultDigest: tool.result_digest,
      resolutionEvidenceDigest: tool.resolution_evidence_digest,
      deliveryAttemptId: tool.attempt_id,
      toolResponseDigest: tool.tool_response_digest,
      deliveryConfirmedAt: tool.transport_write_confirmed_at,
    }))),
  }
  const { evidenceDigest, ...receipt } = unsigned
  return {
    ...receipt,
    presentationDigest: digestCanonicalJson({
      ...receipt,
      evidenceDigest,
      productTerminalDigest: row.product_terminal_digest || row.host_failure_product_terminal_digest,
    }),
  }
}

export function readProductTurnPresentation(
  db: DatabaseConnection,
  readyRunId: string,
): ProductTurnReceipt {
  if (!readyRunId.trim()) throw new Error('product_turn_run_id_invalid')
  const ownsSnapshot = db.inTransaction !== true
  if (ownsSnapshot) db.exec('BEGIN')
  try {
    const receipt = readInSnapshot(db, readyRunId)
    if (ownsSnapshot) db.exec('COMMIT')
    return receipt
  } catch (error) {
    if (ownsSnapshot) {
      try { db.exec('ROLLBACK') } catch { /* preserve the read error */ }
    }
    throw error
  }
}

export function readProductTurnPresentations(
  db: DatabaseConnection,
  readyRunIds: readonly string[],
): ProductTurnReceipt[] {
  const runIds = Array.from(new Set(readyRunIds.map((value) => value.trim()).filter(Boolean)))
  const ownsSnapshot = db.inTransaction !== true
  if (ownsSnapshot) db.exec('BEGIN')
  try {
    const receipts = runIds.flatMap((readyRunId) => {
      try { return [readInSnapshot(db, readyRunId)] }
      catch { return [] }
    })
    if (ownsSnapshot) db.exec('COMMIT')
    return receipts
  } catch (error) {
    if (ownsSnapshot) {
      try { db.exec('ROLLBACK') } catch { /* preserve the read error */ }
    }
    throw error
  }
}
