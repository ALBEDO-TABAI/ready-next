import { CodexBindingRepositoryError } from '../codex-binding-error'
import { browserToolSurfaceNeedsObservationReserve, isCodexBrowserObservationClosureToolName } from '../codex-browser-admission'
import { effectiveCodexFolderOutputToolNames, readCodexFolderOutputActivation } from '../codex-folder-output-activation'
import { assertReadyBoundTurnToolAuthorization, type ReadyBoundTurnToolAuthorization } from '../codex-tool-surface'
import { buildCodexDeliveredUserTail } from '../codex-turn-input-builder'
import type { CodexBindingContext } from './context'
import { assertRuntimeOperationForThread } from './continuity'
import { effectiveInstructionContractDigest, threadRequestToolsDigest } from './core'
import { CODEX_DELIVERY_LANE_TOOL_NAMES, changes, nonEmpty, parseProductBudgetLimits, parseStringArray } from './shared'
import type { CodexModelGatewayBindingRead, CodexModelGatewayBindingReadInput, TurnBindingRow } from './types'

// The binding the model gateway resolves for each request.

export function readModelGatewayBinding(context: CodexBindingContext, input: CodexModelGatewayBindingReadInput): CodexModelGatewayBindingRead {
  nonEmpty(input.codexThreadId, 'gateway_thread_id_invalid')
  nonEmpty(input.codexTurnId, 'gateway_turn_id_invalid')
  nonEmpty(input.receivedAt, 'gateway_received_at_invalid')
  if (input.kind === 'product' || input.kind === 'automatic_compaction') {
    if (!input.readyRunId) throw new CodexBindingRepositoryError('gateway_ready_run_id_missing')
    const row = context.db.prepare(`
        SELECT t.ready_run_id, t.ready_task_id, t.thread_binding_id,
               t.codex_thread_id, t.codex_turn_id,
               t.gateway_claimed_codex_turn_id, t.product_closeout_at, t.revision,
               t.turn_start_dispatch_intent_at,
               t.tool_surface_digest, t.effective_codex_model,
               t.effective_upstream_snapshot_ref, t.effective_upstream_snapshot_digest,
               t.additional_context_digest, t.turn_contract_digest, t.product_budget_seed_json,
               t.authorization_snapshot_digest, t.authorization_snapshot_json,
               t.attempt_kind, t.ingress_json, t.ingress_admitted_digest,
               th.instruction_contract_digest, th.runtime_manifest_digest AS thread_runtime_manifest_digest,
               th.tool_surface_json AS thread_tool_surface_json,
               th.codex_forked_from_id,
               th.codex_thread_id AS thread_codex_thread_id,
               f.owner_ready_run_id AS fence_owner_ready_run_id,
               f.quarantined_at AS fence_quarantined_at
          FROM codex_turn_bindings t
          JOIN codex_thread_bindings th ON th.thread_binding_id = t.thread_binding_id
          JOIN codex_thread_dispatch_fences f ON f.thread_binding_id = t.thread_binding_id
         WHERE t.ready_run_id = ? AND f.operation_kind = 'product_turn'
         LIMIT 1
      `).get<{
      ready_run_id: string
      ready_task_id: string
      thread_binding_id: string
      codex_thread_id: string | null
      codex_turn_id: string | null
      gateway_claimed_codex_turn_id: string | null
      product_closeout_at: string | null
      revision: number
      turn_start_dispatch_intent_at: string | null
      tool_surface_digest: string
      effective_codex_model: string
      effective_upstream_snapshot_ref: string
      effective_upstream_snapshot_digest: string
      additional_context_digest: string
      turn_contract_digest: string
      product_budget_seed_json: string
      authorization_snapshot_digest: string
      authorization_snapshot_json: string
      attempt_kind: TurnBindingRow['attempt_kind']
      ingress_json: string | null
      ingress_admitted_digest: string
      instruction_contract_digest: string | null
      thread_runtime_manifest_digest: string
      thread_tool_surface_json: string | null
      codex_forked_from_id: string | null
      thread_codex_thread_id: string | null
      fence_owner_ready_run_id: string | null
      fence_quarantined_at: string | null
    }>(input.readyRunId)
    if (
      !row
      || row.product_closeout_at
      || !row.turn_start_dispatch_intent_at
      || row.fence_owner_ready_run_id !== row.ready_run_id
      || row.fence_quarantined_at
      || row.thread_codex_thread_id !== input.codexThreadId
      || row.codex_forked_from_id !== input.codexForkedFromId
      || (row.codex_thread_id && row.codex_thread_id !== input.codexThreadId)
      || (row.codex_turn_id && row.codex_turn_id !== input.codexTurnId)
      || (row.gateway_claimed_codex_turn_id
        && row.gateway_claimed_codex_turn_id !== input.codexTurnId)
      || input.toolSurfaceDigest !== row.tool_surface_digest
      || input.turnContractDigest !== row.turn_contract_digest
      || input.upstreamProfileSnapshotDigest !== row.effective_upstream_snapshot_digest
      || !row.instruction_contract_digest
    ) throw new CodexBindingRepositoryError('gateway_product_binding_mismatch')
    if (input.kind === 'automatic_compaction') {
      assertRuntimeOperationForThread(context, row.thread_binding_id, 'manual_compaction')
    }
    if (!row.gateway_claimed_codex_turn_id) {
      const claimed = context.db.prepare(`
          UPDATE codex_turn_bindings
             SET gateway_claimed_codex_turn_id = ?, revision = revision + 1, updated_at = ?
           WHERE ready_run_id = ? AND revision = ?
             AND gateway_claimed_codex_turn_id IS NULL
             AND (codex_turn_id IS NULL OR codex_turn_id = ?)
        `).run(
        input.codexTurnId,
        input.receivedAt,
        row.ready_run_id,
        row.revision,
        input.codexTurnId,
      )
      if (changes(claimed) !== 1) {
        throw new CodexBindingRepositoryError('gateway_turn_identity_claim_failed')
      }
    }
    const budget = parseProductBudgetLimits(row.product_budget_seed_json)
    const admittedToolCalls = context.db.prepare(`
        SELECT COALESCE(SUM(tool_call_count), 0) AS count
          FROM codex_tool_group_admissions WHERE ready_run_id = ?
      `).get<{ count: number }>(row.ready_run_id)?.count || 0
    if (admittedToolCalls > budget.maxToolCalls) {
      throw new CodexBindingRepositoryError('gateway_product_budget_snapshot_invalid')
    }
    const folderActivation = readCodexFolderOutputActivation(context.db, row.ready_run_id)
    const admittedLaneCalls = folderActivation.kind === 'no_contract'
      ? {
          ordinary_calls: admittedToolCalls,
          delivery_calls: 0,
        }
      : context.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN tool_name IN (
            'declare_completion_criteria', 'skill_write_artifact',
            'skill_read_artifact', 'skill_export_artifact'
          ) THEN 0 ELSE 1 END), 0) AS ordinary_calls,
          COALESCE(SUM(CASE WHEN tool_name IN (
            'declare_completion_criteria', 'skill_write_artifact',
            'skill_read_artifact', 'skill_export_artifact'
          ) THEN 1 ELSE 0 END), 0) AS delivery_calls
          FROM codex_tool_call_admissions WHERE ready_run_id = ?
      `).get<{ ordinary_calls: number; delivery_calls: number }>(row.ready_run_id)
    const ordinaryExhausted = Number(admittedLaneCalls?.ordinary_calls || 0)
      >= budget.lanes.ordinary.maxToolCalls
    const deliveryExhausted = Number(admittedLaneCalls?.delivery_calls || 0)
      >= budget.lanes.delivery.maxToolCalls
    let authorization: ReadyBoundTurnToolAuthorization
    try {
      authorization = JSON.parse(row.authorization_snapshot_json) as ReadyBoundTurnToolAuthorization
      assertReadyBoundTurnToolAuthorization(authorization)
    } catch {
      throw new CodexBindingRepositoryError('gateway_tool_authorization_invalid')
    }
    if (
      authorization.authorizationSnapshotDigest !== row.authorization_snapshot_digest
      || authorization.readyRunId !== row.ready_run_id
      || authorization.readyTaskId !== row.ready_task_id
      || authorization.toolSurfaceDigest !== row.tool_surface_digest
      || authorization.turnContractDigest !== row.turn_contract_digest
    ) throw new CodexBindingRepositoryError('gateway_tool_authorization_mismatch')
    const effectiveAuthorizedNames = input.kind === 'product'
      ? effectiveCodexFolderOutputToolNames(
          authorization.allowedToolNames,
          folderActivation,
        )
      : []
    const ordinaryCalls = Number(admittedLaneCalls?.ordinary_calls || 0)
    const reserveBrowserObservation = input.kind === 'product'
      && browserToolSurfaceNeedsObservationReserve(effectiveAuthorizedNames)
      && budget.lanes.ordinary.maxToolCalls - ordinaryCalls === 1
    const effectiveNames = input.kind === 'product'
      ? effectiveAuthorizedNames.filter((name) => {
          if (folderActivation.kind !== 'no_contract' && CODEX_DELIVERY_LANE_TOOL_NAMES.has(name)) {
            return !deliveryExhausted
          }
          return !ordinaryExhausted
            && (!reserveBrowserObservation || isCodexBrowserObservationClosureToolName(name))
        })
      : null
    return {
      kind: input.kind,
      ownerId: row.ready_run_id,
      codexModel: row.effective_codex_model,
      upstreamProfileSnapshotRef: row.effective_upstream_snapshot_ref,
      upstreamProfileSnapshotDigest: row.effective_upstream_snapshot_digest,
      toolSurfaceDigest: row.tool_surface_digest,
      requestToolsDigest: threadRequestToolsDigest(context, row.thread_tool_surface_json, row.tool_surface_digest),
      turnContractDigest: row.turn_contract_digest,
      instructionContractDigest: effectiveInstructionContractDigest(
        context,
        row.instruction_contract_digest,
        row.thread_runtime_manifest_digest,
      ),
      additionalContextDigest: row.additional_context_digest,
      deliveredUserTail: input.kind === 'product'
        ? buildCodexDeliveredUserTail(context.self.readProductTurnRuntime(row.ready_run_id).prepared.ingress, row.ready_run_id)
        : [],
      providerSnapshotJson: null,
      maxIterations: budget.maxIterations,
      iterationLanes: input.kind === 'product'
        ? {
            ordinary: budget.lanes.ordinary.maxIterations,
            delivery: budget.lanes.delivery.maxIterations,
            final: 1,
          }
        : null,
      toolCallsExhausted: input.kind === 'product' && effectiveNames?.length === 0,
      allowedToolNames: effectiveNames,
    }
  }

  const rows = context.db.prepare(`
      SELECT m.manual_compaction_id, m.codex_thread_id, m.codex_compaction_turn_id,
             m.codex_model, m.revision,
             m.upstream_profile_snapshot_ref, m.upstream_profile_snapshot_digest,
             m.expected_tools_digest, m.provider_snapshot_json, m.expires_at,
             m.pre_dispatch_turn_ids_json,
             m.consumed_at, m.abandoned_at,
             th.instruction_contract_digest, th.runtime_manifest_digest AS thread_runtime_manifest_digest,
             th.codex_forked_from_id,
             f.owner_manual_compaction_id AS fence_owner_manual_compaction_id,
             f.quarantined_at AS fence_quarantined_at
        FROM codex_manual_compaction_bindings m
        JOIN codex_thread_bindings th ON th.thread_binding_id = m.thread_binding_id
        JOIN codex_thread_dispatch_fences f ON f.thread_binding_id = m.thread_binding_id
       WHERE m.codex_thread_id = ? AND f.operation_kind = 'manual_compaction'
         AND m.consumed_at IS NULL AND m.abandoned_at IS NULL
       LIMIT 2
    `).all<{
    manual_compaction_id: string
    codex_thread_id: string
    codex_compaction_turn_id: string | null
    codex_model: string
    revision: number
    upstream_profile_snapshot_ref: string
    upstream_profile_snapshot_digest: string
    expected_tools_digest: string
    provider_snapshot_json: string
    expires_at: string
    pre_dispatch_turn_ids_json: string | null
    consumed_at: string | null
    abandoned_at: string | null
    instruction_contract_digest: string | null
    thread_runtime_manifest_digest: string
    codex_forked_from_id: string | null
    fence_owner_manual_compaction_id: string | null
    fence_quarantined_at: string | null
  }>(input.codexThreadId)
  if (rows.length !== 1) throw new CodexBindingRepositoryError('gateway_manual_binding_not_unique')
  const row = rows[0]
  const preDispatchTurnIds = row.pre_dispatch_turn_ids_json
    ? parseStringArray(row.pre_dispatch_turn_ids_json, 'manual_pre_dispatch_turn_ids_invalid')
    : []
  if (
    row.codex_thread_id !== input.codexThreadId
    || row.codex_forked_from_id !== input.codexForkedFromId
    || (row.codex_compaction_turn_id && row.codex_compaction_turn_id !== input.codexTurnId)
    || row.fence_owner_manual_compaction_id !== row.manual_compaction_id
    || row.fence_quarantined_at
    || !Number.isFinite(Date.parse(row.expires_at))
    || !Number.isFinite(Date.parse(input.receivedAt))
    || Date.parse(row.expires_at) < Date.parse(input.receivedAt)
    || !row.instruction_contract_digest
    || preDispatchTurnIds.includes(input.codexTurnId)
  ) throw new CodexBindingRepositoryError('gateway_manual_binding_mismatch')
  if (!row.codex_compaction_turn_id) {
    const claimed = context.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET codex_compaction_turn_id = ?, revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND codex_compaction_turn_id IS NULL
           AND consumed_at IS NULL AND abandoned_at IS NULL
      `).run(
      input.codexTurnId,
      input.receivedAt,
      row.manual_compaction_id,
      row.revision,
    )
    if (changes(claimed) !== 1) {
      throw new CodexBindingRepositoryError('gateway_turn_identity_claim_failed')
    }
  }
  return {
    kind: 'manual_compaction',
    ownerId: row.manual_compaction_id,
    codexModel: row.codex_model,
    upstreamProfileSnapshotRef: row.upstream_profile_snapshot_ref,
    upstreamProfileSnapshotDigest: row.upstream_profile_snapshot_digest,
    toolSurfaceDigest: row.expected_tools_digest,
    requestToolsDigest: row.expected_tools_digest,
    turnContractDigest: null,
    instructionContractDigest: effectiveInstructionContractDigest(
      context,
      row.instruction_contract_digest,
      row.thread_runtime_manifest_digest,
    ),
    additionalContextDigest: null,
    deliveredUserTail: [],
    providerSnapshotJson: row.provider_snapshot_json,
    maxIterations: null,
    iterationLanes: null,
    toolCallsExhausted: false,
    allowedToolNames: null,
  }
}
