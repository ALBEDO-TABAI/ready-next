import type { DatabaseConnection } from '../../database/connection'
import { CodexBindingRepositoryError } from './codex-binding-error'
import { canonicalJson, digestCanonicalJson } from './codex-model-gateway-contract'
import { buildCodexToolActionIdentity } from './codex-tool-action-identity'
import {
  buildCodexToolResponseDeliveryAttemptId,
  type CodexToolResponseDeliveryAttemptIdentity,
  type CodexToolResponseDeliveryAttemptRead,
} from './codex-tool-response-delivery'
import {
  assertReadyBoundTurnToolAuthorization,
  assertReadyToolSurface,
  type ReadyBoundTurnToolAuthorization,
  type ReadyToolSurface,
} from './codex-tool-surface'
import {
  effectiveCodexFolderOutputToolNames,
  readCodexFolderOutputActivation,
} from './codex-folder-output-activation'
import {
  assertReadyMemorySnapshot,
  canonicalReadyMemoryJson,
  type ReadyMemorySnapshot,
} from '../ready-memory'
import {
  browserToolSurfaceNeedsObservationReserve,
  isCodexBrowserObservationClosureToolName,
} from './codex-browser-admission'

export type CodexToolBridgeExecutionBinding = Readonly<{
  bindingId: string
  readyAliasId: string
  readyScopeId: string
  readyTaskId: string
  readyRunId: string
  codexSessionId: string
  codexThreadId: string
  codexTurnId: string
  turnContractDigest: string
  productBudgetSeed: Readonly<{
    maxIterations: number
    maxToolCalls: number
    maxParallelToolGroups: number
    lanes: Readonly<{
      ordinary: Readonly<{ maxIterations: number; maxToolCalls: number; maxParallelToolGroups: number }>
      delivery: Readonly<{ maxIterations: number; maxToolCalls: number; maxParallelToolGroups: number }>
      final: Readonly<{ maxIterations: 1 }>
    }>
  }>
  readyMemorySnapshot: ReadyMemorySnapshot
  toolSurface: ReadyToolSurface
  authorization: ReadyBoundTurnToolAuthorization
}>

export type CodexToolCallBindingRead = Readonly<{
  readyActionId: string
  receiptId: string | null
  resultDigest: string | null
  requestConnectionEpoch: string
  requestRpcId: string
  deliveredConnectionEpoch: string | null
  deliveredRpcId: string | null
  toolResponseDigest: string | null
}>

export type CodexToolResponseCallAdmission = Readonly<{
  codexCallId: string
  toolName: string
  argsDigest: string
}>

type RunResult = { changes?: number }
const DELIVERY_TOOL_NAMES = new Set([
  'declare_completion_criteria',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
])

function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}

function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new CodexBindingRepositoryError(code)
}

function parseProductBudgetSeed(value: string): CodexToolBridgeExecutionBinding['productBudgetSeed'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexBindingRepositoryError('tool_bridge_budget_snapshot_invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexBindingRepositoryError('tool_bridge_budget_snapshot_invalid')
  }
  const budget = parsed as Record<string, unknown>
  if (
    Object.keys(budget).length !== 4
    || !Number.isSafeInteger(budget.maxIterations)
    || Number(budget.maxIterations) <= 0
    || !Number.isSafeInteger(budget.maxToolCalls)
    || Number(budget.maxToolCalls) < 0
    || !Number.isSafeInteger(budget.maxParallelToolGroups)
    || Number(budget.maxParallelToolGroups) < 0
    || !budget.lanes || typeof budget.lanes !== 'object' || Array.isArray(budget.lanes)
  ) throw new CodexBindingRepositoryError('tool_bridge_budget_snapshot_invalid')
  const lanes = budget.lanes as Record<string, unknown>
  const parseLane = (value: unknown, allowZeroIterations: boolean) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CodexBindingRepositoryError('tool_bridge_budget_snapshot_invalid')
    }
    const lane = value as Record<string, unknown>
    if (Object.keys(lane).length !== 3
      || !Number.isSafeInteger(lane.maxIterations)
      || Number(lane.maxIterations) < (allowZeroIterations ? 0 : 1)
      || !Number.isSafeInteger(lane.maxToolCalls) || Number(lane.maxToolCalls) < 0
      || !Number.isSafeInteger(lane.maxParallelToolGroups)
      || Number(lane.maxParallelToolGroups) < 0) {
      throw new CodexBindingRepositoryError('tool_bridge_budget_snapshot_invalid')
    }
    return {
      maxIterations: Number(lane.maxIterations),
      maxToolCalls: Number(lane.maxToolCalls),
      maxParallelToolGroups: Number(lane.maxParallelToolGroups),
    }
  }
  const ordinary = parseLane(lanes.ordinary, false)
  const delivery = parseLane(lanes.delivery, true)
  const final = lanes.final as Record<string, unknown> | null
  if (!final || Object.keys(final).length !== 1 || final.maxIterations !== 1
    || Number(budget.maxIterations) !== ordinary.maxIterations + delivery.maxIterations + 1
    || Number(budget.maxToolCalls) !== ordinary.maxToolCalls + delivery.maxToolCalls) {
    throw new CodexBindingRepositoryError('tool_bridge_budget_snapshot_invalid')
  }
  return {
    maxIterations: Number(budget.maxIterations),
    maxToolCalls: Number(budget.maxToolCalls),
    maxParallelToolGroups: Number(budget.maxParallelToolGroups),
    lanes: { ordinary, delivery, final: { maxIterations: 1 } },
  }
}

export class CodexToolBindingRepository {
  constructor(private readonly db: DatabaseConnection) {}

  admitToolResponseGroup(input: {
    gatewayRequestReceiptId: string
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
    calls: readonly CodexToolResponseCallAdmission[]
    admittedAt: string
  }): void {
    for (const value of [
      input.gatewayRequestReceiptId,
      input.readyRunId,
      input.codexThreadId,
      input.codexTurnId,
      input.admittedAt,
    ]) nonEmpty(value, 'tool_group_identity_invalid')
    if (input.calls.length === 0) throw new CodexBindingRepositoryError('tool_group_empty')
    const callIds = new Set<string>()
    for (const call of input.calls) {
      for (const value of [call.codexCallId, call.toolName, call.argsDigest]) {
        nonEmpty(value, 'tool_group_call_invalid')
      }
      if (callIds.has(call.codexCallId)) {
        throw new CodexBindingRepositoryError('tool_group_call_duplicate')
      }
      callIds.add(call.codexCallId)
    }
    this.immediate(() => {
      const receipt = this.db.prepare(`
        SELECT receipt_id, ready_run_id, codex_thread_id, codex_turn_id, request_kind
          FROM ready_model_gateway_request_receipts WHERE receipt_id = ? LIMIT 1
      `).get<{
        receipt_id: string
        ready_run_id: string | null
        codex_thread_id: string
        codex_turn_id: string
        request_kind: string
      }>(input.gatewayRequestReceiptId)
      if (
        !receipt
        || receipt.request_kind !== 'product'
        || receipt.ready_run_id !== input.readyRunId
        || receipt.codex_thread_id !== input.codexThreadId
        || receipt.codex_turn_id !== input.codexTurnId
      ) throw new CodexBindingRepositoryError('tool_group_gateway_receipt_mismatch')
      const binding = this.readToolBridgeExecutionBinding(input.readyRunId)
      const folderActivation = readCodexFolderOutputActivation(this.db, input.readyRunId)
      const effectiveAllowedToolNames = effectiveCodexFolderOutputToolNames(
        binding.authorization.allowedToolNames,
        folderActivation,
      )
      if (
        binding.codexThreadId !== input.codexThreadId
        || binding.codexTurnId !== input.codexTurnId
      ) throw new CodexBindingRepositoryError('tool_group_parent_identity_mismatch')
      const admitted = this.db.prepare(`
        SELECT COALESCE(SUM(tool_call_count), 0) AS calls,
               COALESCE(SUM(parallel_group_charged), 0) AS parallel_groups
          FROM codex_tool_group_admissions WHERE ready_run_id = ?
      `).get<{ calls: number; parallel_groups: number }>(input.readyRunId)
      const admittedCalls = Number(admitted?.calls || 0)
      const admittedParallelGroups = Number(admitted?.parallel_groups || 0)
      const parallelGroupCharged = input.calls.length >= 2 ? 1 : 0
      const laneKinds = new Set(input.calls.map((call) => (
        folderActivation.kind !== 'no_contract' && DELIVERY_TOOL_NAMES.has(call.toolName)
          ? 'delivery'
          : 'ordinary'
      )))
      if (laneKinds.size !== 1) throw new CodexBindingRepositoryError('tool_group_lane_mixed')
      const laneKind = laneKinds.values().next().value as 'ordinary' | 'delivery'
      const lane = binding.productBudgetSeed.lanes[laneKind]
      const admittedByLane = folderActivation.kind === 'no_contract'
        ? this.db.prepare(`
            SELECT COUNT(*) AS calls FROM codex_tool_call_admissions WHERE ready_run_id = ?
          `).get<{ calls: number }>(input.readyRunId)
        : this.db.prepare(`
            SELECT COUNT(*) AS calls
              FROM codex_tool_call_admissions
             WHERE ready_run_id = ?
               AND (tool_name IN (
                 'declare_completion_criteria', 'skill_write_artifact',
                 'skill_read_artifact', 'skill_export_artifact'
               )) = ?
          `).get<{ calls: number }>(input.readyRunId, laneKind === 'delivery' ? 1 : 0)
      const laneCalls = Number(admittedByLane?.calls || 0)
      if (
        laneKind === 'ordinary'
        && browserToolSurfaceNeedsObservationReserve(effectiveAllowedToolNames)
        && laneCalls + input.calls.length >= lane.maxToolCalls
        && input.calls.some((call) => !isCodexBrowserObservationClosureToolName(call.toolName))
      ) {
        throw new CodexBindingRepositoryError('ordinary_tool_call_reserved_for_browser_observation')
      }
      if (laneCalls + input.calls.length > lane.maxToolCalls) {
        throw new CodexBindingRepositoryError(`${laneKind}_tool_call_budget_exhausted`)
      }
      if (parallelGroupCharged
        && admittedParallelGroups + parallelGroupCharged > lane.maxParallelToolGroups) {
        throw new CodexBindingRepositoryError(`${laneKind}_parallel_tool_group_budget_exhausted`)
      }
      if (admittedCalls + input.calls.length > binding.productBudgetSeed.maxToolCalls
        || (parallelGroupCharged
          && admittedParallelGroups + parallelGroupCharged
            > binding.productBudgetSeed.maxParallelToolGroups)) {
        throw new CodexBindingRepositoryError('tool_call_budget_snapshot_inconsistent')
      }
      for (const call of input.calls) {
        if (
          !effectiveAllowedToolNames.includes(call.toolName)
          || !binding.toolSurface.entries.some((entry) => entry.name === call.toolName)
        ) throw new CodexBindingRepositoryError('tool_group_frozen_contract_mismatch')
      }
      const groupDigest = digestCanonicalJson({
        gatewayRequestReceiptId: input.gatewayRequestReceiptId,
        readyRunId: input.readyRunId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        calls: [...input.calls].map((call) => ({ ...call })),
      })
      const inserted = this.db.prepare(`
        INSERT INTO codex_tool_group_admissions (
          gateway_request_receipt_id, ready_run_id, codex_thread_id, codex_turn_id,
          tool_call_count, parallel_group_charged, group_digest, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.gatewayRequestReceiptId,
        input.readyRunId,
        input.codexThreadId,
        input.codexTurnId,
        input.calls.length,
        parallelGroupCharged,
        groupDigest,
        input.admittedAt,
      )
      if (changes(inserted) !== 1) {
        throw new CodexBindingRepositoryError('tool_group_admission_failed')
      }
      const insertCall = this.db.prepare(`
        INSERT INTO codex_tool_call_admissions (
          codex_thread_id, codex_turn_id, codex_call_id,
          gateway_request_receipt_id, ready_run_id, tool_name, args_digest, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const call of input.calls) {
        const result = insertCall.run(
          input.codexThreadId,
          input.codexTurnId,
          call.codexCallId,
          input.gatewayRequestReceiptId,
          input.readyRunId,
          call.toolName,
          call.argsDigest,
          input.admittedAt,
        )
        if (changes(result) !== 1) {
          throw new CodexBindingRepositoryError('tool_call_admission_failed')
        }
      }
    })
  }

  bindToolCall(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    readyRunId: string
    readyActionId: string
    readyAliasId: string
    codexSessionId: string
    readyTaskId: string
    toolName: string
    argsDigest: string
    turnContractDigest: string
    surfaceSnapshotDigest: string
    toolSurfaceDigest: string
    authorizationSnapshotDigest: string
    toolSchemaDigest: string
    requestConnectionEpoch: string
    requestRpcId: string
    at: string
  }): { duplicate: boolean } {
    nonEmpty(input.requestConnectionEpoch, 'tool_request_connection_epoch_invalid')
    nonEmpty(input.requestRpcId, 'tool_request_rpc_id_invalid')
    return this.immediate(() => {
      const owner = this.db.prepare(`
        SELECT ready_run_id, ready_task_id, thread_binding_id, codex_thread_id, codex_turn_id
          FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
      `).get<{
        ready_run_id: string
        ready_task_id: string
        thread_binding_id: string
        codex_thread_id: string | null
        codex_turn_id: string | null
      }>(input.readyRunId)
      if (
        !owner
        || owner.codex_thread_id !== input.codexThreadId
        || owner.codex_turn_id !== input.codexTurnId
      ) throw new CodexBindingRepositoryError('tool_call_parent_identity_mismatch')
      const fence = this.db.prepare(`
        SELECT owner_ready_run_id, quarantined_at FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND operation_kind = 'product_turn' LIMIT 1
      `).get<{ owner_ready_run_id: string | null; quarantined_at: string | null }>(
        owner.thread_binding_id,
      )
      if (!fence || fence.owner_ready_run_id !== owner.ready_run_id || fence.quarantined_at) {
        throw new CodexBindingRepositoryError('tool_call_owner_inactive')
      }
      const bridgeBinding = this.readToolBridgeExecutionBinding(input.readyRunId)
      const effectiveAllowedToolNames = effectiveCodexFolderOutputToolNames(
        bridgeBinding.authorization.allowedToolNames,
        readCodexFolderOutputActivation(this.db, input.readyRunId),
      )
      const surfaceEntry = bridgeBinding.toolSurface.entries.find(
        (entry) => entry.name === input.toolName,
      )
      if (
        bridgeBinding.readyAliasId !== input.readyAliasId
        || bridgeBinding.codexSessionId !== input.codexSessionId
        || bridgeBinding.readyTaskId !== input.readyTaskId
        || bridgeBinding.turnContractDigest !== input.turnContractDigest
        || bridgeBinding.toolSurface.surfaceSnapshotDigest !== input.surfaceSnapshotDigest
        || bridgeBinding.toolSurface.toolSurfaceDigest !== input.toolSurfaceDigest
        || bridgeBinding.authorization.authorizationSnapshotDigest
          !== input.authorizationSnapshotDigest
        || !surfaceEntry
        || surfaceEntry.schemaDigest !== input.toolSchemaDigest
        || !effectiveAllowedToolNames.includes(input.toolName)
      ) throw new CodexBindingRepositoryError('tool_call_frozen_contract_mismatch')
      const admission = this.db.prepare(`
        SELECT c.ready_run_id, c.tool_name, c.args_digest,
               g.ready_run_id AS group_ready_run_id,
               g.codex_thread_id AS group_codex_thread_id,
               g.codex_turn_id AS group_codex_turn_id,
               g.tool_call_count,
               (SELECT COUNT(*) FROM codex_tool_call_admissions sibling
                 WHERE sibling.gateway_request_receipt_id = g.gateway_request_receipt_id)
                 AS admitted_call_count
          FROM codex_tool_call_admissions c
          JOIN codex_tool_group_admissions g
            ON g.gateway_request_receipt_id = c.gateway_request_receipt_id
         WHERE c.codex_thread_id = ? AND c.codex_turn_id = ? AND c.codex_call_id = ?
         LIMIT 1
      `).get<{
        ready_run_id: string
        tool_name: string
        args_digest: string
        group_ready_run_id: string
        group_codex_thread_id: string
        group_codex_turn_id: string
        tool_call_count: number
        admitted_call_count: number
      }>(
        input.codexThreadId,
        input.codexTurnId,
        input.codexCallId,
      )
      if (
        !admission
        || admission.ready_run_id !== input.readyRunId
        || admission.group_ready_run_id !== input.readyRunId
        || admission.group_codex_thread_id !== input.codexThreadId
        || admission.group_codex_turn_id !== input.codexTurnId
        || admission.admitted_call_count !== admission.tool_call_count
        || admission.tool_name !== input.toolName
        || admission.args_digest !== input.argsDigest
      ) throw new CodexBindingRepositoryError('tool_call_not_admitted')
      const actionIdentity = buildCodexToolActionIdentity({
        readyAliasId: input.readyAliasId,
        codexSessionId: input.codexSessionId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: input.codexCallId,
        readyTaskId: input.readyTaskId,
        readyRunId: input.readyRunId,
        toolName: input.toolName,
        argsDigest: input.argsDigest,
        turnContractDigest: input.turnContractDigest,
        surfaceSnapshotDigest: input.surfaceSnapshotDigest,
        authorizationSnapshotDigest: input.authorizationSnapshotDigest,
        toolSchemaDigest: input.toolSchemaDigest,
      })
      if (input.readyActionId !== actionIdentity.readyActionId) {
        throw new CodexBindingRepositoryError('tool_call_action_identity_mismatch')
      }
      const existing = this.db.prepare(`
        SELECT * FROM codex_tool_call_bindings
         WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
      `).get<Record<string, unknown>>(input.codexThreadId, input.codexTurnId, input.codexCallId)
      if (existing) {
        if (
          existing.ready_run_id !== input.readyRunId
          || existing.ready_action_id !== input.readyActionId
          || existing.ready_alias_id !== input.readyAliasId
          || existing.codex_session_id !== input.codexSessionId
          || existing.ready_task_id !== input.readyTaskId
          || existing.tool_name !== input.toolName
          || existing.args_digest !== input.argsDigest
          || existing.turn_contract_digest !== input.turnContractDigest
          || existing.surface_snapshot_digest !== input.surfaceSnapshotDigest
          || existing.tool_surface_digest !== input.toolSurfaceDigest
          || existing.authorization_snapshot_digest !== input.authorizationSnapshotDigest
          || existing.tool_schema_digest !== input.toolSchemaDigest
        ) throw new CodexBindingRepositoryError('tool_call_identity_conflict')
        this.claimToolRequestRpc(input)
        return { duplicate: true }
      }
      const folderActivation = readCodexFolderOutputActivation(this.db, input.readyRunId)
      const laneKind = folderActivation.kind !== 'no_contract' && DELIVERY_TOOL_NAMES.has(input.toolName)
        ? 'delivery'
        : 'ordinary'
      const admittedToolCalls = (folderActivation.kind === 'no_contract'
        ? this.db.prepare(`
            SELECT COUNT(*) AS count FROM codex_tool_call_bindings WHERE ready_run_id = ?
          `).get<{ count: number }>(input.readyRunId)
        : this.db.prepare(`
            SELECT COUNT(*) AS count FROM codex_tool_call_bindings
             WHERE ready_run_id = ?
               AND (tool_name IN (
                 'declare_completion_criteria', 'skill_write_artifact',
                 'skill_read_artifact', 'skill_export_artifact'
               )) = ?
          `).get<{ count: number }>(input.readyRunId, laneKind === 'delivery' ? 1 : 0))?.count || 0
      if (admittedToolCalls >= bridgeBinding.productBudgetSeed.lanes[laneKind].maxToolCalls) {
        throw new CodexBindingRepositoryError(`${laneKind}_tool_call_budget_exhausted`)
      }
      const inserted = this.db.prepare(`
        INSERT INTO codex_tool_call_bindings (
          codex_thread_id, codex_turn_id, codex_call_id, ready_run_id,
          ready_action_id, ready_alias_id, codex_session_id, ready_task_id,
          tool_name, args_digest, turn_contract_digest, surface_snapshot_digest,
          tool_surface_digest, authorization_snapshot_digest, tool_schema_digest,
          request_connection_epoch, request_rpc_id,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.codexThreadId,
        input.codexTurnId,
        input.codexCallId,
        input.readyRunId,
        input.readyActionId,
        input.readyAliasId,
        input.codexSessionId,
        input.readyTaskId,
        input.toolName,
        input.argsDigest,
        input.turnContractDigest,
        input.surfaceSnapshotDigest,
        input.toolSurfaceDigest,
        input.authorizationSnapshotDigest,
        input.toolSchemaDigest,
        input.requestConnectionEpoch,
        input.requestRpcId,
        input.at,
        input.at,
      )
      if (changes(inserted) !== 1) {
        throw new CodexBindingRepositoryError('tool_call_binding_insert_failed')
      }
      this.claimToolRequestRpc(input)
      return { duplicate: false }
    })
  }

  private claimToolRequestRpc(input: {
    requestConnectionEpoch: string
    requestRpcId: string
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    readyActionId: string
    at: string
  }): void {
    const canonicalRpcId = input.requestRpcId.trim()
    const existing = this.db.prepare(`
      SELECT 1 FROM codex_tool_request_rpc_bindings
       WHERE connection_epoch = ? AND request_rpc_id = ? LIMIT 1
    `).get(input.requestConnectionEpoch, canonicalRpcId)
    if (existing) throw new CodexBindingRepositoryError('tool_request_rpc_reused')
    const inserted = this.db.prepare(`
      INSERT INTO codex_tool_request_rpc_bindings (
        connection_epoch, request_rpc_id, codex_thread_id, codex_turn_id,
        codex_call_id, ready_action_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestConnectionEpoch,
      canonicalRpcId,
      input.codexThreadId,
      input.codexTurnId,
      input.codexCallId,
      input.readyActionId,
      input.at,
    )
    if (changes(inserted) !== 1) {
      throw new CodexBindingRepositoryError('tool_request_rpc_claim_failed')
    }
  }

  readToolBridgeExecutionBinding(bindingId: string): CodexToolBridgeExecutionBinding {
    nonEmpty(bindingId, 'tool_bridge_binding_id_invalid')
    const row = this.db.prepare(`
      SELECT t.ready_run_id, t.ready_task_id, t.codex_thread_id, t.codex_turn_id,
             t.gateway_claimed_codex_turn_id,
             t.turn_contract_digest, t.authorization_snapshot_digest,
             t.authorization_snapshot_json, t.product_budget_seed_json, t.product_closeout_at,
             t.ready_memory_snapshot_json, t.ready_memory_snapshot_digest,
             t.ready_memory_state_revision, t.ready_memory_revocation_revision,
             t.interrupt_requested_at,
             th.ready_conversation_alias, th.ready_scope_id, th.codex_session_id,
             th.tool_surface_digest, th.tool_surface_snapshot_digest, th.tool_surface_json,
             th.retired_at, th.continuation_blocked_at,
             f.owner_ready_run_id, f.quarantined_at
        FROM codex_turn_bindings t
        JOIN codex_thread_bindings th ON th.thread_binding_id = t.thread_binding_id
        JOIN codex_thread_dispatch_fences f ON f.thread_binding_id = t.thread_binding_id
       WHERE t.ready_run_id = ? AND f.operation_kind = 'product_turn'
       LIMIT 1
    `).get<{
      ready_run_id: string
      ready_task_id: string
      codex_thread_id: string | null
      codex_turn_id: string | null
      gateway_claimed_codex_turn_id: string | null
      turn_contract_digest: string
      authorization_snapshot_digest: string
      authorization_snapshot_json: string | null
      product_budget_seed_json: string | null
      ready_memory_snapshot_json: string | null
      ready_memory_snapshot_digest: string | null
      ready_memory_state_revision: number | null
      ready_memory_revocation_revision: number | null
      product_closeout_at: string | null
      interrupt_requested_at: string | null
      ready_conversation_alias: string
      ready_scope_id: string
      codex_session_id: string | null
      tool_surface_digest: string | null
      tool_surface_snapshot_digest: string | null
      tool_surface_json: string | null
      retired_at: string | null
      continuation_blocked_at: string | null
      owner_ready_run_id: string | null
      quarantined_at: string | null
    }>(bindingId)
    if (!row) throw new CodexBindingRepositoryError('tool_bridge_binding_not_found')
    const effectiveCodexTurnId = row.codex_turn_id || row.gateway_claimed_codex_turn_id
    if (
      !row.codex_thread_id
      || !effectiveCodexTurnId
      || !row.codex_session_id
      || !row.tool_surface_digest
      || !row.tool_surface_snapshot_digest
      || !row.tool_surface_json
      || !row.authorization_snapshot_json
      || !row.product_budget_seed_json
      || !row.ready_memory_snapshot_json
      || !row.ready_memory_snapshot_digest
      || row.ready_memory_state_revision === null
      || row.ready_memory_revocation_revision === null
    ) throw new CodexBindingRepositoryError('tool_bridge_binding_incomplete')
    if (
      row.product_closeout_at
      || row.interrupt_requested_at
      || row.retired_at
      || row.continuation_blocked_at
      || row.owner_ready_run_id !== row.ready_run_id
      || row.quarantined_at
    ) throw new CodexBindingRepositoryError('tool_bridge_binding_inactive')
    let toolSurface: ReadyToolSurface
    let authorization: ReadyBoundTurnToolAuthorization
    let readyMemorySnapshot: ReadyMemorySnapshot
    try {
      toolSurface = JSON.parse(row.tool_surface_json) as ReadyToolSurface
      authorization = JSON.parse(row.authorization_snapshot_json) as ReadyBoundTurnToolAuthorization
      readyMemorySnapshot = JSON.parse(row.ready_memory_snapshot_json) as ReadyMemorySnapshot
      assertReadyToolSurface(toolSurface)
      assertReadyBoundTurnToolAuthorization(authorization)
      assertReadyMemorySnapshot(readyMemorySnapshot)
    } catch {
      throw new CodexBindingRepositoryError('tool_bridge_snapshot_invalid')
    }
    if (
      toolSurface.toolSurfaceDigest !== row.tool_surface_digest
      || toolSurface.surfaceSnapshotDigest !== row.tool_surface_snapshot_digest
      || authorization.authorizationSnapshotDigest !== row.authorization_snapshot_digest
      || authorization.readySessionKey !== row.ready_conversation_alias
      || authorization.readyTaskId !== row.ready_task_id
      || authorization.readyRunId !== row.ready_run_id
      || authorization.scopeId !== row.ready_scope_id
      || authorization.toolSurfaceDigest !== row.tool_surface_digest
      || authorization.turnContractDigest !== row.turn_contract_digest
      || !authorization.allowedToolNames.every((name) => toolSurface.toolNames.includes(name))
      || canonicalReadyMemoryJson(readyMemorySnapshot) !== row.ready_memory_snapshot_json
      || readyMemorySnapshot.snapshotDigest !== row.ready_memory_snapshot_digest
      || readyMemorySnapshot.stateRevision !== row.ready_memory_state_revision
      || readyMemorySnapshot.revocationRevision !== row.ready_memory_revocation_revision
    ) throw new CodexBindingRepositoryError('tool_bridge_snapshot_mismatch')
    return {
      bindingId,
      readyAliasId: row.ready_conversation_alias,
      readyScopeId: row.ready_scope_id,
      readyTaskId: row.ready_task_id,
      readyRunId: row.ready_run_id,
      codexSessionId: row.codex_session_id,
      codexThreadId: row.codex_thread_id,
      codexTurnId: effectiveCodexTurnId,
      turnContractDigest: row.turn_contract_digest,
      productBudgetSeed: parseProductBudgetSeed(row.product_budget_seed_json),
      readyMemorySnapshot,
      toolSurface,
      authorization,
    }
  }

  readToolCallBinding(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
  }): CodexToolCallBindingRead | null {
    const row = this.db.prepare(`
      SELECT ready_action_id, receipt_id, result_digest,
             request_connection_epoch, request_rpc_id,
             delivered_connection_epoch, delivered_rpc_id, tool_response_digest
        FROM codex_tool_call_bindings
       WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
       LIMIT 1
    `).get<{
      ready_action_id: string
      receipt_id: string | null
      result_digest: string | null
      request_connection_epoch: string
      request_rpc_id: string
      delivered_connection_epoch: string | null
      delivered_rpc_id: string | null
      tool_response_digest: string | null
    }>(input.codexThreadId, input.codexTurnId, input.codexCallId)
    return row ? {
      readyActionId: row.ready_action_id,
      receiptId: row.receipt_id,
      resultDigest: row.result_digest,
      requestConnectionEpoch: row.request_connection_epoch,
      requestRpcId: row.request_rpc_id,
      deliveredConnectionEpoch: row.delivered_connection_epoch,
      deliveredRpcId: row.delivered_rpc_id,
      toolResponseDigest: row.tool_response_digest,
    } : null
  }

  completeToolCall(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    receiptId: string
    resultDigest: string
    at: string
  }): void {
    this.immediate(() => {
      const existing = this.readToolCallBinding(input)
      if (!existing) throw new CodexBindingRepositoryError('tool_call_binding_not_found')
      const journal = this.db.prepare(`
        SELECT receipt_id, result_digest
          FROM ready_tool_action_receipts
         WHERE ready_action_id = ? AND state = 'confirmed'
         LIMIT 1
      `).get<{ receipt_id: string; result_digest: string }>(
        existing.readyActionId,
      )
      if (
        !journal
        || journal.receipt_id !== input.receiptId
        || journal.result_digest !== input.resultDigest
      ) throw new CodexBindingRepositoryError('tool_action_receipt_mismatch')
      if (existing.receiptId) {
        if (
          existing.receiptId !== input.receiptId
          || existing.resultDigest !== input.resultDigest
        ) throw new CodexBindingRepositoryError('tool_result_identity_conflict')
        return
      }
      const updated = this.db.prepare(`
        UPDATE codex_tool_call_bindings
           SET receipt_id = ?, result_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
           AND receipt_id IS NULL AND result_digest IS NULL
      `).run(
        input.receiptId,
        input.resultDigest,
        input.at,
        input.codexThreadId,
        input.codexTurnId,
        input.codexCallId,
      )
      if (changes(updated) !== 1) throw new CodexBindingRepositoryError('tool_result_cas_failed')
    })
  }

  markToolCallDeliveryIntent(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    connectionEpoch: string
    requestRpcId: string
    toolResponseDigest: string
    at: string
  }): void {
    if (!/^[0-9a-f]{64}$/.test(input.toolResponseDigest)) {
      throw new CodexBindingRepositoryError('tool_response_digest_invalid')
    }
    this.immediate(() => {
      const existing = this.readToolCallBinding(input)
      if (!existing?.receiptId || !existing.resultDigest) {
        throw new CodexBindingRepositoryError('tool_result_not_complete')
      }
      if (
        existing.requestConnectionEpoch !== input.connectionEpoch
        || existing.requestRpcId !== input.requestRpcId
      ) throw new CodexBindingRepositoryError('tool_result_replay_forbidden')
      if (existing.deliveredConnectionEpoch) {
        if (
          existing.deliveredConnectionEpoch === input.connectionEpoch
          && existing.deliveredRpcId === input.requestRpcId
          && existing.toolResponseDigest === input.toolResponseDigest
        ) return
        throw new CodexBindingRepositoryError('tool_result_replay_forbidden')
      }
      const updated = this.db.prepare(`
        UPDATE codex_tool_call_bindings
           SET delivered_connection_epoch = ?, delivered_rpc_id = ?, tool_response_digest = ?,
               delivery_intent_at = ?, revision = revision + 1, updated_at = ?
         WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
           AND receipt_id IS NOT NULL AND result_digest IS NOT NULL
           AND delivered_connection_epoch IS NULL
      `).run(
        input.connectionEpoch,
        input.requestRpcId,
        input.toolResponseDigest,
        input.at,
        input.at,
        input.codexThreadId,
        input.codexTurnId,
        input.codexCallId,
      )
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('tool_delivery_cas_failed')
      }
    })
  }

  beginToolCallDeliveryAttempt(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    connectionEpoch: string
    requestRpcId: string
    toolResponse: unknown
    toolResponseDigest: string
    at: string
  }): { attempt: CodexToolResponseDeliveryAttemptIdentity; duplicate: boolean } {
    if (!/^[0-9a-f]{64}$/.test(input.toolResponseDigest)) {
      throw new CodexBindingRepositoryError('tool_response_digest_invalid')
    }
    const toolResponseJson = canonicalJson(input.toolResponse)
    if (digestCanonicalJson(input.toolResponse) !== input.toolResponseDigest) {
      throw new CodexBindingRepositoryError('tool_response_digest_mismatch')
    }
    return this.immediate(() => {
      const existing = this.readToolCallBinding(input)
      if (!existing?.receiptId || !existing.resultDigest) {
        throw new CodexBindingRepositoryError('tool_result_not_complete')
      }
      const identity = {
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: input.codexCallId,
        readyActionId: existing.readyActionId,
        connectionEpoch: input.connectionEpoch,
        requestRpcId: input.requestRpcId,
        toolResponseDigest: input.toolResponseDigest,
      }
      const attempt: CodexToolResponseDeliveryAttemptIdentity = {
        attemptId: buildCodexToolResponseDeliveryAttemptId(identity),
        ...identity,
      }
      const prior = this.db.prepare(`
        SELECT attempt_id, codex_thread_id, codex_turn_id, codex_call_id,
               ready_action_id, connection_epoch, request_rpc_id,
               tool_response_json, tool_response_digest
          FROM codex_tool_response_delivery_attempts
         WHERE connection_epoch = ? AND request_rpc_id = ?
         LIMIT 1
      `).get<{
        attempt_id: string
        codex_thread_id: string
        codex_turn_id: string
        codex_call_id: string
        ready_action_id: string
        connection_epoch: string
        request_rpc_id: string
        tool_response_json: string
        tool_response_digest: string
      }>(input.connectionEpoch, input.requestRpcId)
      if (prior) {
        if (
          prior.attempt_id !== attempt.attemptId
          || prior.codex_thread_id !== attempt.codexThreadId
          || prior.codex_turn_id !== attempt.codexTurnId
          || prior.codex_call_id !== attempt.codexCallId
          || prior.ready_action_id !== attempt.readyActionId
          || prior.connection_epoch !== attempt.connectionEpoch
          || prior.request_rpc_id !== attempt.requestRpcId
          || prior.tool_response_json !== toolResponseJson
          || prior.tool_response_digest !== attempt.toolResponseDigest
        ) throw new CodexBindingRepositoryError('tool_delivery_attempt_identity_conflict')
        return { attempt, duplicate: true }
      }
      const inserted = this.db.prepare(`
        INSERT INTO codex_tool_response_delivery_attempts (
          attempt_id, codex_thread_id, codex_turn_id, codex_call_id,
          ready_action_id, connection_epoch, request_rpc_id,
          tool_response_json, tool_response_digest,
          transport_write_confirmed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        attempt.attemptId,
        attempt.codexThreadId,
        attempt.codexTurnId,
        attempt.codexCallId,
        attempt.readyActionId,
        attempt.connectionEpoch,
        attempt.requestRpcId,
        toolResponseJson,
        attempt.toolResponseDigest,
        input.at,
      )
      if (changes(inserted) !== 1) {
        throw new CodexBindingRepositoryError('tool_delivery_attempt_insert_failed')
      }
      if (!existing.deliveredConnectionEpoch) {
        const updated = this.db.prepare(`
          UPDATE codex_tool_call_bindings
             SET delivered_connection_epoch = ?, delivered_rpc_id = ?, tool_response_digest = ?,
                 delivery_intent_at = ?, revision = revision + 1, updated_at = ?
           WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
             AND receipt_id IS NOT NULL AND result_digest IS NOT NULL
             AND delivered_connection_epoch IS NULL
        `).run(
          input.connectionEpoch,
          input.requestRpcId,
          input.toolResponseDigest,
          input.at,
          input.at,
          input.codexThreadId,
          input.codexTurnId,
          input.codexCallId,
        )
        if (changes(updated) !== 1) {
          throw new CodexBindingRepositoryError('tool_delivery_cas_failed')
        }
      }
      return { attempt, duplicate: false }
    })
  }

  readToolCallDeliveryAttempts(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
  }): CodexToolResponseDeliveryAttemptRead[] {
    return this.db.prepare(`
      SELECT attempt_id, codex_thread_id, codex_turn_id, codex_call_id,
             ready_action_id, connection_epoch, request_rpc_id,
             tool_response_json, tool_response_digest,
             transport_write_confirmed_at, created_at
        FROM codex_tool_response_delivery_attempts
       WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
       ORDER BY created_at ASC, attempt_id ASC
    `).all<{
      attempt_id: string
      codex_thread_id: string
      codex_turn_id: string
      codex_call_id: string
      ready_action_id: string
      connection_epoch: string
      request_rpc_id: string
      tool_response_json: string
      tool_response_digest: string
      transport_write_confirmed_at: string | null
      created_at: string
    }>(input.codexThreadId, input.codexTurnId, input.codexCallId).map((row) => {
      let toolResponse: unknown
      try {
        toolResponse = JSON.parse(row.tool_response_json)
      } catch {
        throw new CodexBindingRepositoryError('tool_delivery_attempt_response_invalid')
      }
      if (digestCanonicalJson(toolResponse) !== row.tool_response_digest) {
        throw new CodexBindingRepositoryError('tool_delivery_attempt_response_invalid')
      }
      const expectedAttemptId = buildCodexToolResponseDeliveryAttemptId({
        codexThreadId: row.codex_thread_id,
        codexTurnId: row.codex_turn_id,
        codexCallId: row.codex_call_id,
        readyActionId: row.ready_action_id,
        connectionEpoch: row.connection_epoch,
        requestRpcId: row.request_rpc_id,
        toolResponseDigest: row.tool_response_digest,
      })
      if (row.attempt_id !== expectedAttemptId) {
        throw new CodexBindingRepositoryError('tool_delivery_attempt_identity_conflict')
      }
      return {
        attemptId: row.attempt_id,
        codexThreadId: row.codex_thread_id,
        codexTurnId: row.codex_turn_id,
        codexCallId: row.codex_call_id,
        readyActionId: row.ready_action_id,
        connectionEpoch: row.connection_epoch,
        requestRpcId: row.request_rpc_id,
        toolResponse,
        toolResponseDigest: row.tool_response_digest,
        transportWriteConfirmedAt: row.transport_write_confirmed_at,
        createdAt: row.created_at,
      }
    })
  }

  confirmToolCallDeliveryTransportWrite(input: CodexToolResponseDeliveryAttemptIdentity & {
    at: string
  }): void {
    this.immediate(() => {
      const existing = this.db.prepare(`
        SELECT attempt_id, codex_thread_id, codex_turn_id, codex_call_id,
               ready_action_id, connection_epoch, request_rpc_id, tool_response_digest,
               transport_write_confirmed_at
          FROM codex_tool_response_delivery_attempts
         WHERE attempt_id = ? LIMIT 1
      `).get<{
        attempt_id: string
        codex_thread_id: string
        codex_turn_id: string
        codex_call_id: string
        ready_action_id: string
        connection_epoch: string
        request_rpc_id: string
        tool_response_digest: string
        transport_write_confirmed_at: string | null
      }>(input.attemptId)
      if (!existing) throw new CodexBindingRepositoryError('tool_delivery_attempt_not_found')
      if (
        existing.codex_thread_id !== input.codexThreadId
        || existing.codex_turn_id !== input.codexTurnId
        || existing.codex_call_id !== input.codexCallId
        || existing.ready_action_id !== input.readyActionId
        || existing.connection_epoch !== input.connectionEpoch
        || existing.request_rpc_id !== input.requestRpcId
        || existing.tool_response_digest !== input.toolResponseDigest
        || existing.attempt_id !== buildCodexToolResponseDeliveryAttemptId({
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          codexCallId: input.codexCallId,
          readyActionId: input.readyActionId,
          connectionEpoch: input.connectionEpoch,
          requestRpcId: input.requestRpcId,
          toolResponseDigest: input.toolResponseDigest,
        })
      ) throw new CodexBindingRepositoryError('tool_delivery_attempt_identity_conflict')
      if (existing.transport_write_confirmed_at) return
      const updated = this.db.prepare(`
        UPDATE codex_tool_response_delivery_attempts
           SET transport_write_confirmed_at = ?
         WHERE attempt_id = ? AND transport_write_confirmed_at IS NULL
      `).run(input.at, input.attemptId)
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('tool_delivery_attempt_ack_cas_failed')
      }
    })
  }

  private immediate<T>(action: () => T): T {
    if (this.db.inTransaction) return action()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
