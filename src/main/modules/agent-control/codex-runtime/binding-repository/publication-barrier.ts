import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { codexCurrentDocumentAnchorSchema, type CodexCurrentDocumentAnchor } from '../../../../../shared/ipc-contracts/agent-runtime'
import { actionObligationEvidenceMatches, isReadyActionObligationSet, type ReadyActionObligationSetV1 } from '../codex-action-obligation'
import type { CodexBindingRepository } from '../codex-binding-repository'
import { readCodexFolderOutputActivation } from '../codex-folder-output-activation'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { buildCodexToolActionIdentity } from '../codex-tool-action-identity'
import { buildReadyToolActionAbsenceEvidenceDigest } from '../codex-tool-action-journal'
import { CodexToolBindingRepository } from '../codex-tool-binding-repository'
import { assertReadyBoundTurnToolAuthorization, assertReadyToolSurface, type ReadyBoundTurnToolAuthorization, type ReadyToolSurface } from '../codex-tool-surface'
import type { CodexBindingContext } from './context'
import { currentDocumentReadReceiptMatches, frozenOutputDestination, hashPath, isRecord, nonEmpty, readyToolResultSuccess, safeTargetPath } from './shared'
import type { CodexToolPublicationBarrierRead, NativeTerminalCandidate } from './types'

// Whether a turn may publish: tool, artifact and folder-output barriers.

export function readArtifactPublicationBarrier(context: CodexBindingContext, input: {
  readyRunId: string
  ingressJson: string | null
}): CodexToolPublicationBarrierRead {
  const destination = frozenOutputDestination(input.ingressJson)
  if (!destination) {
    return { kind: 'accepted', verifiedReceiptRefs: [], code: null, callId: null }
  }
  const activation = readCodexFolderOutputActivation(context.db, input.readyRunId)
  // A destination offers file delivery; it does not make every reply a file task.
  if (activation.kind === 'pending' && !context.db.prepare(`
      SELECT 1 FROM codex_tool_call_bindings
       WHERE ready_run_id = ? AND tool_name = 'declare_completion_criteria' LIMIT 1
    `).get(input.readyRunId)) {
    return { kind: 'accepted', verifiedReceiptRefs: [], code: null, callId: null }
  }
  if (activation.kind === 'pending'
    || activation.kind === 'no_contract'
    || activation.kind === 'selection_required') {
    return {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'folder_output_intent_receipt_missing', callId: null,
    }
  }
  if (!('destinationResourceId' in activation)) {
    return {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'folder_output_intent_receipt_missing', callId: null,
    }
  }
  if (activation.destinationResourceId !== destination.logicalResourceId) {
    return {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'folder_output_destination_mismatch', callId: null,
    }
  }
  const declarationRefs = [
    activation.declarationReceiptId,
    activation.deliveryAttemptId,
  ]
  if (activation.kind === 'no_write') {
    return {
      kind: 'accepted', verifiedReceiptRefs: declarationRefs.sort(), code: null, callId: null,
    }
  }
  try {
    context.self.readProductTurnRuntime(input.readyRunId)
  } catch {
    // silent-catch: an unreadable product turn runtime row is returned as a fabricated tool_publication_ingress_invalid verdict
    return {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'tool_publication_ingress_invalid', callId: null,
    }
  }
  const rows = context.db.prepare(`
      SELECT binding.codex_call_id, binding.tool_name, action.receipt_id,
             action.result_digest, action.result_json, delivery.attempt_id
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
         AND action.state = 'confirmed'
        JOIN codex_tool_response_delivery_attempts delivery
          ON delivery.ready_action_id = binding.ready_action_id
         AND delivery.codex_thread_id = binding.codex_thread_id
         AND delivery.codex_turn_id = binding.codex_turn_id
         AND delivery.codex_call_id = binding.codex_call_id
         AND delivery.transport_write_confirmed_at IS NOT NULL
       WHERE binding.ready_run_id = ?
         AND binding.tool_name IN ('skill_write_artifact', 'skill_export_artifact')
       ORDER BY binding.created_at, binding.codex_call_id, delivery.created_at
    `).all<{
    codex_call_id: string
    tool_name: string
    receipt_id: string
    result_digest: string
    result_json: string
    attempt_id: string
  }>(input.readyRunId)
  const staged = new Map<string, {
    logicalArtifactRef: string
    version: string
    sha256: string
    receiptId: string
    attemptId: string
  }>()
  const exported = new Map<string, {
    logicalArtifactRef: string
    version: string
    sha256: string
    bytes: number
    targetDevice: string
    targetInode: string
    receiptId: string
    attemptId: string
  }>()
  for (const row of rows) {
    let result: unknown
    try {
      result = JSON.parse(row.result_json)
    } catch {
      // silent-catch: unparseable stored action result JSON is returned as a fabricated artifact_action_result_invalid verdict
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'artifact_action_result_invalid', callId: row.codex_call_id,
      }
    }
    if (digestCanonicalJson(result) !== row.result_digest || !isRecord(result) || !isRecord(result.data)) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'artifact_action_result_digest_mismatch', callId: row.codex_call_id,
      }
    }
    const data = result.data
    if (row.tool_name === 'skill_write_artifact') {
      if (typeof data.relativePath !== 'string'
        || typeof data.logicalArtifactRef !== 'string'
        || typeof data.version !== 'string'
        || typeof data.logicalSha256 !== 'string') continue
      staged.set(data.relativePath, {
        logicalArtifactRef: data.logicalArtifactRef,
        version: data.version,
        sha256: data.logicalSha256,
        receiptId: row.receipt_id,
        attemptId: row.attempt_id,
      })
    } else {
      if (typeof data.targetRelativePath !== 'string'
        || typeof data.logicalArtifactRef !== 'string'
        || typeof data.version !== 'string'
        || typeof data.sha256 !== 'string'
        || !Number.isSafeInteger(data.bytes)
        || typeof data.targetDevice !== 'string'
        || typeof data.targetInode !== 'string'
        || data.destinationResourceId !== destination.logicalResourceId
        || data.readbackVerified !== true) continue
      exported.set(data.targetRelativePath, {
        logicalArtifactRef: data.logicalArtifactRef,
        version: data.version,
        sha256: data.sha256,
        bytes: Number(data.bytes),
        targetDevice: data.targetDevice,
        targetInode: data.targetInode,
        receiptId: row.receipt_id,
        attemptId: row.attempt_id,
      })
    }
  }
  let rootStat: ReturnType<typeof statSync>
  try {
    if (realpathSync(destination.path) !== destination.path) throw new Error('root_realpath_drift')
    rootStat = statSync(destination.path)
  } catch {
    // silent-catch: a missing, unreadable or realpath-drifted destination root is returned as an indeterminate readback verdict
    return {
      kind: 'indeterminate', verifiedReceiptRefs: [],
      code: 'artifact_destination_readback_failed', callId: null,
    }
  }
  if (!rootStat.isDirectory()
    || String(rootStat.dev) !== destination.directoryIdentity.device
    || String(rootStat.ino) !== destination.directoryIdentity.inode
    || rootStat.mode !== destination.directoryIdentity.mode) {
    return {
      kind: 'indeterminate', verifiedReceiptRefs: [],
      code: 'artifact_destination_identity_drift', callId: null,
    }
  }
  const refs = [...declarationRefs]
  for (const expected of activation.expectedOutputs) {
    const write = staged.get(expected)
    const output = exported.get(expected)
    const source = write
    if (!source || !output) {
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: !source ? 'artifact_staged_receipt_missing' : 'artifact_export_receipt_missing',
        callId: null,
      }
    }
    if (source.logicalArtifactRef !== output.logicalArtifactRef
      || source.version !== output.version || source.sha256 !== output.sha256) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'artifact_staged_exported_version_mismatch', callId: null,
      }
    }
    let durableHead: ReturnType<CodexBindingRepository['readArtifactWriteHead']>
    try {
      durableHead = context.self.readArtifactWriteHead(input.readyRunId, expected)
    } catch {
      // silent-catch: an unreadable or broken artifact write receipt chain is returned as a fabricated receipt-chain verdict
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'artifact_write_receipt_chain_invalid', callId: null,
      }
    }
    if (!durableHead
      || durableHead.logicalArtifactRef !== source.logicalArtifactRef
      || durableHead.version !== source.version
      || durableHead.logicalSha256 !== source.sha256) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'artifact_write_head_mismatch', callId: null,
      }
    }
    const target = safeTargetPath(destination.path, expected)
    if (!target) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'artifact_target_path_invalid', callId: null,
      }
    }
    try {
      const parentRealpath = realpathSync(dirname(target))
      const parentRelative = relative(destination.path, parentRealpath)
      if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`) || isAbsolute(parentRelative)) {
        throw new Error('parent_escape')
      }
      const targetStat = lstatSync(target)
      if (!targetStat.isFile() || targetStat.isSymbolicLink()
        || String(targetStat.dev) !== output.targetDevice
        || String(targetStat.ino) !== output.targetInode) throw new Error('target_identity_drift')
      const fresh = hashPath(target)
      if (fresh.bytes !== output.bytes || fresh.sha256 !== output.sha256) {
        throw new Error('target_hash_drift')
      }
    } catch {
      // silent-catch: parent escape, identity/hash drift or an unreadable target is returned as an indeterminate readback mismatch
      return {
        kind: 'indeterminate', verifiedReceiptRefs: [],
        code: 'artifact_target_readback_mismatch', callId: null,
      }
    }
    refs.push(
      ...durableHead.receiptRefs,
      ...(write ? [write.receiptId, write.attemptId] : []),
      output.receiptId,
      output.attemptId,
    )
  }
  return {
    kind: 'accepted',
    verifiedReceiptRefs: Array.from(new Set(refs)).sort(),
    code: null,
    callId: null,
  }
}

export function readToolPublicationBarrier(context: CodexBindingContext, input: {
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  candidateCalls: NativeTerminalCandidate['usedToolCalls']
  effectSettlementOnly?: boolean
}): CodexToolPublicationBarrierRead {
  for (const value of [input.readyRunId, input.codexThreadId, input.codexTurnId]) {
    nonEmpty(value, 'tool_publication_identity_invalid')
  }
  const owner = context.db.prepare(`
      SELECT turn.codex_thread_id, turn.codex_turn_id, turn.ingress_json,
             turn.ready_task_id, turn.turn_contract_digest,
             turn.authorization_snapshot_digest, turn.authorization_snapshot_json,
             thread.ready_conversation_alias, thread.codex_session_id,
             thread.tool_surface_digest, thread.tool_surface_snapshot_digest,
             thread.tool_surface_json
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ? LIMIT 1
    `).get<{
    codex_thread_id: string | null
    codex_turn_id: string | null
    ingress_json: string | null
    ready_task_id: string
    turn_contract_digest: string
    authorization_snapshot_digest: string
    authorization_snapshot_json: string
    ready_conversation_alias: string
    codex_session_id: string | null
    tool_surface_digest: string | null
    tool_surface_snapshot_digest: string | null
    tool_surface_json: string | null
  }>(input.readyRunId)
  if (!owner
    || owner.codex_thread_id !== input.codexThreadId
    || owner.codex_turn_id !== input.codexTurnId) {
    return {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'tool_publication_turn_identity_mismatch', callId: null,
    }
  }
  let frozenToolSurface: ReadyToolSurface
  let frozenAuthorization: ReadyBoundTurnToolAuthorization
  try {
    frozenToolSurface = JSON.parse(owner.tool_surface_json || '') as ReadyToolSurface
    assertReadyToolSurface(frozenToolSurface)
    frozenAuthorization = JSON.parse(owner.authorization_snapshot_json) as ReadyBoundTurnToolAuthorization
    assertReadyBoundTurnToolAuthorization(frozenAuthorization)
    if (frozenToolSurface.toolSurfaceDigest !== owner.tool_surface_digest
      || frozenToolSurface.surfaceSnapshotDigest !== owner.tool_surface_snapshot_digest
      || frozenAuthorization.authorizationSnapshotDigest !== owner.authorization_snapshot_digest
      || frozenAuthorization.toolSurfaceDigest !== owner.tool_surface_digest) {
      throw new Error('frozen_tool_surface_digest_mismatch')
    }
  } catch {
    // silent-catch: an unparseable or digest-mismatched frozen tool surface/authorization snapshot is returned as a fabricated verdict
    return {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'tool_publication_frozen_snapshot_invalid', callId: null,
    }
  }
  const currentDocumentReadRequired = frozenAuthorization.allowedToolNames.includes(
    'document_read_section',
  )
  const effectSettlementOnly = input.effectSettlementOnly === true
  let publicationDivergedCallId: string | null = null
  const recordedTerminal = context.self.readEngineTerminalCandidate(input.readyRunId)
  if (recordedTerminal) {
    const recordedCandidate = recordedTerminal.candidate as NativeTerminalCandidate
    if (canonicalJson(recordedCandidate.usedToolCalls) !== canonicalJson(input.candidateCalls)) {
      if (!effectSettlementOnly) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'candidate_tool_calls_terminal_mismatch', callId: null,
        }
      }
      publicationDivergedCallId = input.candidateCalls[0]?.itemId || 'candidate'
    }
  }
  const terminalAllowsPreHostAbandonment = recordedTerminal !== null
    && recordedTerminal.engineOutcome !== 'completed'
  let currentDocumentAnchor: CodexCurrentDocumentAnchor | null = null
  let currentDocumentAmbient = false
  let actionObligations: ReadyActionObligationSetV1 | null = null
  try {
    const ingressReceipt = JSON.parse(owner.ingress_json || '') as {
      prepared?: {
        ingress?: { currentDocumentAnchor?: unknown }
        currentDocumentAmbient?: unknown
        actionObligations?: unknown
      }
    }
    currentDocumentAmbient = ingressReceipt.prepared?.currentDocumentAmbient === true
    const rawAnchor = ingressReceipt.prepared?.ingress?.currentDocumentAnchor
    if (rawAnchor !== undefined && rawAnchor !== null) {
      const parsedAnchor = codexCurrentDocumentAnchorSchema.safeParse(rawAnchor)
      if (!parsedAnchor.success) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'current_document_anchor_invalid', callId: null,
        }
      }
      currentDocumentAnchor = parsedAnchor.data
    }
    const rawObligations = ingressReceipt.prepared?.actionObligations
    if (rawObligations !== undefined) {
      if (!isReadyActionObligationSet(rawObligations)) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'action_obligation_contract_invalid', callId: null,
        }
      }
      actionObligations = rawObligations
    }
  } catch {
    // silent-catch: unparseable ingress receipt JSON is returned as a fabricated tool_publication_ingress_invalid verdict
    return {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'tool_publication_ingress_invalid', callId: null,
    }
  }
  const candidateById = new Map<string, NativeTerminalCandidate['usedToolCalls'][number]>()
  for (const call of input.candidateCalls) {
    if (candidateById.has(call.itemId)) {
      if (!effectSettlementOnly) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'candidate_tool_call_duplicate', callId: call.itemId,
        }
      }
      publicationDivergedCallId ||= call.itemId
      continue
    }
    candidateById.set(call.itemId, call)
  }
  const rows = context.db.prepare(`
      SELECT admission.codex_call_id, admission.tool_name,
             admission.args_digest AS admission_args_digest,
             gateway.receipt_id AS gateway_receipt_id,
             binding.codex_call_id AS bound_call_id,
             binding.tool_name AS bound_tool_name,
             binding.args_digest AS bound_args_digest,
             binding.ready_action_id, binding.ready_alias_id, binding.codex_session_id,
             binding.ready_task_id, binding.turn_contract_digest,
             binding.surface_snapshot_digest, binding.authorization_snapshot_digest,
             binding.tool_surface_digest, binding.tool_schema_digest,
             binding.receipt_id AS binding_receipt_id,
             binding.result_digest AS binding_result_digest,
             binding.request_connection_epoch, binding.request_rpc_id,
             binding.delivered_connection_epoch, binding.delivered_rpc_id,
             binding.delivery_intent_at,
             binding.tool_response_digest,
             binding.legacy_delivery_evidence_unverifiable,
             action.state AS action_state, action.receipt_id AS action_receipt_id,
             action.result_digest AS action_result_digest,
             action.action_identity_digest AS action_identity_digest,
             action.result_json AS action_result_json,
             action.resolution_reason AS action_resolution_reason,
             action.resolution_evidence_digest AS action_resolution_evidence_digest
        FROM codex_tool_call_admissions admission
        JOIN codex_tool_group_admissions group_admission
          ON group_admission.gateway_request_receipt_id = admission.gateway_request_receipt_id
         AND group_admission.ready_run_id = admission.ready_run_id
         AND group_admission.codex_thread_id = admission.codex_thread_id
         AND group_admission.codex_turn_id = admission.codex_turn_id
        LEFT JOIN ready_model_gateway_request_receipts gateway
          ON gateway.receipt_id = admission.gateway_request_receipt_id
         AND gateway.request_kind = 'product'
         AND gateway.ready_run_id = admission.ready_run_id
         AND gateway.codex_thread_id = admission.codex_thread_id
         AND gateway.codex_turn_id = admission.codex_turn_id
        LEFT JOIN codex_tool_call_bindings binding
          ON binding.ready_run_id = admission.ready_run_id
         AND binding.codex_thread_id = admission.codex_thread_id
         AND binding.codex_turn_id = admission.codex_turn_id
         AND binding.codex_call_id = admission.codex_call_id
        LEFT JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
       WHERE admission.ready_run_id = ?
         AND admission.codex_thread_id = ?
         AND admission.codex_turn_id = ?
       ORDER BY admission.codex_call_id ASC
    `).all<{
    codex_call_id: string
    tool_name: string
    admission_args_digest: string
    gateway_receipt_id: string | null
    bound_call_id: string | null
    bound_tool_name: string | null
    bound_args_digest: string | null
    ready_action_id: string | null
    ready_alias_id: string | null
    codex_session_id: string | null
    ready_task_id: string | null
    turn_contract_digest: string | null
    surface_snapshot_digest: string | null
    authorization_snapshot_digest: string | null
    tool_surface_digest: string | null
    tool_schema_digest: string | null
    binding_receipt_id: string | null
    binding_result_digest: string | null
    request_connection_epoch: string | null
    request_rpc_id: string | null
    delivered_connection_epoch: string | null
    delivered_rpc_id: string | null
    delivery_intent_at: string | null
    tool_response_digest: string | null
    legacy_delivery_evidence_unverifiable: number
    action_state: 'pending' | 'confirmed' | 'proven_absent' | 'indeterminate' | null
    action_receipt_id: string | null
    action_result_digest: string | null
    action_identity_digest: string | null
    action_result_json: string | null
    action_resolution_reason: string | null
    action_resolution_evidence_digest: string | null
  }>(input.readyRunId, input.codexThreadId, input.codexTurnId)
  const admissionIds = new Set(rows.map((row) => row.codex_call_id))
  for (const call of input.candidateCalls) {
    if (!admissionIds.has(call.itemId)) {
      if (!effectSettlementOnly) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'candidate_tool_call_not_admitted', callId: call.itemId,
        }
      }
      publicationDivergedCallId ||= call.itemId
    }
  }
  const receipts: string[] = []
  const obligationEvidence: Array<{
    callId: string
    toolName: string
    result: unknown
  }> = []
  let exactCurrentDocumentReadCallId: string | null = null
  for (const row of rows) {
    if (row.bound_call_id && row.bound_tool_name !== row.tool_name) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'bound_tool_name_mismatch', callId: row.codex_call_id,
      }
    }
    if (row.bound_call_id && row.bound_args_digest !== row.admission_args_digest) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'bound_args_digest_mismatch', callId: row.codex_call_id,
      }
    }
    if (row.bound_call_id) {
      const frozenEntry = frozenToolSurface.entries.find((entry) => entry.name === row.tool_name)
      if (row.ready_alias_id !== owner.ready_conversation_alias
        || row.codex_session_id !== owner.codex_session_id
        || row.ready_task_id !== owner.ready_task_id
        || row.turn_contract_digest !== owner.turn_contract_digest
        || row.surface_snapshot_digest !== owner.tool_surface_snapshot_digest
        || row.tool_surface_digest !== owner.tool_surface_digest
        || row.authorization_snapshot_digest !== owner.authorization_snapshot_digest
        || !frozenEntry
        || row.tool_schema_digest !== frozenEntry.schemaDigest) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'bound_frozen_identity_mismatch', callId: row.codex_call_id,
        }
      }
      const expectedActionIdentity = buildCodexToolActionIdentity({
        readyAliasId: owner.ready_conversation_alias,
        codexSessionId: owner.codex_session_id || '',
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: row.codex_call_id,
        readyTaskId: owner.ready_task_id,
        readyRunId: input.readyRunId,
        toolName: row.tool_name,
        argsDigest: row.admission_args_digest,
        turnContractDigest: owner.turn_contract_digest,
        surfaceSnapshotDigest: owner.tool_surface_snapshot_digest || '',
        authorizationSnapshotDigest: owner.authorization_snapshot_digest,
        toolSchemaDigest: frozenEntry.schemaDigest,
      })
      if (row.ready_action_id !== expectedActionIdentity.readyActionId) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'bound_action_identity_mismatch', callId: row.codex_call_id,
        }
      }
      if (row.action_identity_digest !== null
        && row.action_identity_digest !== expectedActionIdentity.actionIdentityDigest) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'action_receipt_identity_mismatch', callId: row.codex_call_id,
        }
      }
    }
    let deliveryAttempts: ReturnType<CodexToolBindingRepository['readToolCallDeliveryAttempts']>
    try {
      deliveryAttempts = row.bound_call_id
        ? context.toolBindings.readToolCallDeliveryAttempts({
            codexThreadId: input.codexThreadId,
            codexTurnId: input.codexTurnId,
            codexCallId: row.codex_call_id,
          })
        : []
    } catch {
      // silent-catch: unreadable or invalid delivery attempt rows are returned as a fabricated tool_delivery_attempt_invalid verdict
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_delivery_attempt_invalid', callId: row.codex_call_id,
      }
    }
    if (deliveryAttempts.some((attempt) => (
      attempt.codexThreadId !== input.codexThreadId
      || attempt.codexTurnId !== input.codexTurnId
      || attempt.codexCallId !== row.codex_call_id
      || attempt.readyActionId !== row.ready_action_id
    ))) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_delivery_attempt_identity_mismatch', callId: row.codex_call_id,
      }
    }
    if (effectSettlementOnly && row.gateway_receipt_id && !row.bound_call_id) {
      if (row.ready_action_id !== null
        || row.binding_receipt_id !== null
        || row.binding_result_digest !== null
        || row.action_state !== null
        || row.action_receipt_id !== null
        || row.action_result_digest !== null
        || row.action_result_json !== null
        || deliveryAttempts.length !== 0) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'unbound_tool_action_evidence_invalid', callId: row.codex_call_id,
        }
      }
      publicationDivergedCallId ||= row.codex_call_id
      continue
    }
    if (effectSettlementOnly && row.action_state === 'proven_absent') {
      const expectedEvidenceDigest = row.action_identity_digest
        && row.action_resolution_reason
        && row.request_connection_epoch
        ? buildReadyToolActionAbsenceEvidenceDigest({
            readyActionId: row.ready_action_id || '',
            actionIdentityDigest: row.action_identity_digest,
            connectionEpoch: row.request_connection_epoch,
            reason: row.action_resolution_reason,
          })
        : null
      if (!row.gateway_receipt_id
        || !row.bound_call_id
        || !row.ready_action_id
        || !expectedEvidenceDigest
        || expectedEvidenceDigest !== row.action_resolution_evidence_digest
        || row.binding_receipt_id !== null
        || row.binding_result_digest !== null
        || row.action_receipt_id !== null
        || row.action_result_digest !== null
        || row.action_result_json !== null
        || row.delivered_connection_epoch !== null
        || row.delivered_rpc_id !== null
        || row.tool_response_digest !== null
        || deliveryAttempts.length !== 0) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_action_absence_evidence_invalid', callId: row.codex_call_id,
        }
      }
      publicationDivergedCallId ||= row.codex_call_id
      continue
    }
    const candidate = candidateById.get(row.codex_call_id)
    if (!candidate) {
      if (!effectSettlementOnly
        && terminalAllowsPreHostAbandonment
        && row.gateway_receipt_id
        && row.bound_call_id === null) {
        continue
      }
      if (!terminalAllowsPreHostAbandonment
        || !row.gateway_receipt_id
        || !row.ready_action_id) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'admitted_tool_call_missing_from_terminal', callId: row.codex_call_id,
        }
      }
      if (row.action_state === 'pending' || row.action_state === 'indeterminate') {
        return {
          kind: 'indeterminate', verifiedReceiptRefs: [],
          code: `tool_action_${row.action_state}`, callId: row.codex_call_id,
        }
      }
      if (row.action_state === 'proven_absent') {
        const expectedEvidenceDigest = row.action_identity_digest
          && row.action_resolution_reason
          && row.request_connection_epoch
          ? buildReadyToolActionAbsenceEvidenceDigest({
              readyActionId: row.ready_action_id,
              actionIdentityDigest: row.action_identity_digest,
              connectionEpoch: row.request_connection_epoch,
              reason: row.action_resolution_reason,
            })
          : null
        if (!expectedEvidenceDigest
          || expectedEvidenceDigest !== row.action_resolution_evidence_digest
          || row.binding_receipt_id !== null
          || row.binding_result_digest !== null
          || row.action_receipt_id !== null
          || row.action_result_digest !== null
          || row.action_result_json !== null
          || row.delivered_connection_epoch !== null
          || row.delivered_rpc_id !== null
          || row.tool_response_digest !== null
          || deliveryAttempts.length !== 0) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'tool_action_absence_evidence_invalid', callId: row.codex_call_id,
          }
        }
        publicationDivergedCallId ||= row.codex_call_id
        continue
      }
      if (row.action_state !== 'confirmed') {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'admitted_tool_call_missing_from_terminal', callId: row.codex_call_id,
        }
      }
    }
    if (candidate && candidate.tool !== row.tool_name) {
      if (!effectSettlementOnly) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'candidate_tool_name_mismatch', callId: row.codex_call_id,
        }
      }
      publicationDivergedCallId ||= row.codex_call_id
    }
    if (candidate && candidate.status !== 'completed' && candidate.status !== 'failed') {
      if (!effectSettlementOnly) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'candidate_tool_call_nonterminal', callId: row.codex_call_id,
        }
      }
      publicationDivergedCallId ||= row.codex_call_id
    }
    if (!row.gateway_receipt_id || !row.ready_action_id) {
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: 'tool_binding_or_gateway_receipt_missing', callId: row.codex_call_id,
      }
    }
    if (row.action_state === 'pending' || row.action_state === 'indeterminate') {
      return {
        kind: 'indeterminate', verifiedReceiptRefs: [],
        code: `tool_action_${row.action_state}`, callId: row.codex_call_id,
      }
    }
    if (row.action_state !== 'confirmed'
      || !row.binding_receipt_id || !row.binding_result_digest
      || row.binding_receipt_id !== row.action_receipt_id
      || row.binding_result_digest !== row.action_result_digest
      || !row.request_connection_epoch || !row.request_rpc_id) {
      return {
        kind: effectSettlementOnly ? 'fabricated' : 'incomplete', verifiedReceiptRefs: [],
        code: 'tool_result_evidence_incomplete', callId: row.codex_call_id,
      }
    }
    const candidateResponseDigest = candidate?.responseDigest ?? null
    const candidateDeliveryAttempt = candidateResponseDigest
      ? deliveryAttempts.find((attempt) => (
          attempt.toolResponseDigest === candidateResponseDigest
          && digestCanonicalJson(attempt.toolResponse) === candidateResponseDigest
        )) || null
      : null
    if (!effectSettlementOnly && candidate && !candidateDeliveryAttempt) {
      if (row.legacy_delivery_evidence_unverifiable === 1
        && row.tool_response_digest === null) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'legacy_failed_tool_delivery_unverifiable', callId: row.codex_call_id,
        }
      }
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: 'candidate_tool_result_not_delivered', callId: row.codex_call_id,
      }
    }
    let authoritativeSuccess: boolean | null = null
    let authoritativeResult: unknown = null
    try {
      authoritativeResult = JSON.parse(row.action_result_json || '')
      if (digestCanonicalJson(authoritativeResult) !== row.action_result_digest) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_action_result_digest_mismatch', callId: row.codex_call_id,
        }
      }
      const expectedReceiptId = `ready-tool-receipt-${digestCanonicalJson({
          readyActionId: row.ready_action_id,
          resultDigest: row.action_result_digest,
        })}`
      if (row.action_receipt_id !== expectedReceiptId) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_action_receipt_identity_mismatch', callId: row.codex_call_id,
        }
      }
      authoritativeSuccess = readyToolResultSuccess(authoritativeResult)
    } catch {
      // silent-catch: an unparseable action result is fabricated for effect settlement, else success stays null and is rejected below
      if (effectSettlementOnly) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_action_result_invalid', callId: row.codex_call_id,
        }
      }
      authoritativeSuccess = null
    }
    if (!effectSettlementOnly && authoritativeSuccess === null) {
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: 'tool_result_success_unknown', callId: row.codex_call_id,
      }
    }
    if (candidate && candidate.success !== authoritativeSuccess) {
      if (!effectSettlementOnly) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'candidate_tool_success_mismatch', callId: row.codex_call_id,
        }
      }
      publicationDivergedCallId ||= row.codex_call_id
    }
    if (!effectSettlementOnly && candidateDeliveryAttempt
      && (!isRecord(candidateDeliveryAttempt.toolResponse)
        || candidateDeliveryAttempt.toolResponse.success !== authoritativeSuccess)) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_delivery_attempt_result_mismatch', callId: row.codex_call_id,
      }
    }
    if (!effectSettlementOnly
      && currentDocumentAnchor
      && currentDocumentReadRequired
      && row.tool_name === 'document_read_section'
      && authoritativeSuccess) {
      const resultData = isRecord(authoritativeResult) && isRecord(authoritativeResult.data)
        ? authoritativeResult.data
        : null
      const receipt = resultData && isRecord(resultData.resourceReadReceipt)
        ? resultData.resourceReadReceipt
        : null
      if (!receipt) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'current_document_read_receipt_missing', callId: row.codex_call_id,
        }
      }
      const expectedReceipt = {
        readyRunId: input.readyRunId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: row.codex_call_id,
        readyActionId: row.ready_action_id,
        actionIdentityDigest: row.action_identity_digest,
        logicalResourceId: currentDocumentAnchor.logicalResourceId,
        currentVersion: currentDocumentAnchor.currentVersion,
        currentDigest: currentDocumentAnchor.currentDigest,
        policyEpoch: currentDocumentAnchor.policyEpoch,
        tabId: currentDocumentAnchor.tabId,
        pane: currentDocumentAnchor.pane,
        pathDigest: currentDocumentAnchor.pathDigest,
        incarnationKey: currentDocumentAnchor.incarnationKey,
        modelVisibleText: isRecord(authoritativeResult)
          && typeof authoritativeResult.text === 'string'
          ? authoritativeResult.text
          : '',
      }
      if (!currentDocumentReadReceiptMatches(receipt, expectedReceipt)) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'current_document_read_receipt_mismatch', callId: row.codex_call_id,
        }
      }
      exactCurrentDocumentReadCallId = row.codex_call_id
    }
    receipts.push(row.binding_receipt_id)
    obligationEvidence.push({
      callId: row.codex_call_id,
      toolName: row.tool_name,
      result: authoritativeResult,
    })
    if (!candidate) publicationDivergedCallId ||= row.codex_call_id
  }
  // A document that was only available (not pointed at) owes no read: the reply may be about something else.
  if (!effectSettlementOnly
    && currentDocumentAnchor
    && currentDocumentReadRequired
    && !currentDocumentAmbient
    && !exactCurrentDocumentReadCallId
    && (!recordedTerminal || recordedTerminal.engineOutcome === 'completed')) {
    return {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'current_document_read_required', callId: null,
    }
  }
  if (publicationDivergedCallId) {
    return {
      kind: 'diverged', verifiedReceiptRefs: [],
      code: 'settled_tool_call_missing_from_failed_terminal',
      callId: publicationDivergedCallId,
    }
  }
  if (!effectSettlementOnly
    && actionObligations
    && (!recordedTerminal || recordedTerminal.engineOutcome === 'completed')) {
    for (const obligation of actionObligations.requirements) {
      const matchingToolCalls = obligationEvidence.filter((evidence) => (
        obligation.allowedToolNames.includes(evidence.toolName)
      ))
      if (matchingToolCalls.length === 0) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'action_obligation_missing', callId: null,
        }
      }
      const matchingEvidence = matchingToolCalls.find((evidence) => (
        actionObligationEvidenceMatches(obligation, evidence.toolName, evidence.result)
      ))
      if (!matchingEvidence) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'action_obligation_evidence_mismatch',
          callId: matchingToolCalls[0]?.callId || null,
        }
      }
    }
  }
  if (!effectSettlementOnly
    && (!recordedTerminal || recordedTerminal.engineOutcome === 'completed')) {
    const artifactPublication = readArtifactPublicationBarrier(context, {
      readyRunId: input.readyRunId,
      ingressJson: owner.ingress_json,
    })
    if (artifactPublication.kind !== 'accepted') return artifactPublication
    receipts.push(...artifactPublication.verifiedReceiptRefs)
  }
  return {
    kind: 'accepted',
    verifiedReceiptRefs: Array.from(new Set(receipts)).sort(),
    code: null,
    callId: null,
  }
}
