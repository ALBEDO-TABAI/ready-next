import { randomUUID } from 'node:crypto'
import type { AgentInputItem } from '@openai/agents'
import type {
  AgentCheckpointRefs,
  BrowserCheckpointSuspensionReason,
  BrowserCheckpointWakeKind,
  BrowserConfirmationSuspensionRequest,
  BrowserHumanTakeoverPhysicalTarget,
  BrowserOwnerCrashRecoveryReceipt,
  BrowserPowerConfirmationSuspensionRequest,
  HumanTakeoverRef,
} from '../../../shared/browser-workflow-control'
import { browserWakeKindForSuspensionReason } from '../../../shared/browser-workflow-control'
import type { TaskExecutionBinding } from '../../../shared/agent-execution-profile'
import { assertDeliveryState, type DeliveryStateV1 } from '../../../shared/dynamic-delivery'
import { assertAgentInputToolPairIntegrity } from '../agent-control/compaction/compact-agent-input'
import {
  digestSerializedJson,
  parseObjectStrict,
  serializeWorkflowJson,
  workflowDigest,
} from './browser-workflow-codec'
import type {
  WorkflowDatabaseAccessor,
  WorkflowRawDatabase,
} from './browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork } from './browser-workflow-unit-of-work'
import {
  mapWorkflowCheckpointRow,
  readWorkflowParent,
  type AgentSessionCheckpoint,
  type WorkflowCheckpointRow,
} from './browser-workflow-row-mapping'
import type {
  BrowserCheckpointWakeReceiptInput,
  HumanTakeoverResumeBinding,
} from './agent-session-checkpoint-types'
import {
  confirmationRequestFromContinuation,
  ownerCrashReceiptFromContinuation,
  permissionConfirmationRequestFromContinuation,
  powerConfirmationRequestFromContinuation,
} from './agent-session-checkpoint-confirmations'

const readParent = readWorkflowParent

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export class AgentSessionCheckpointResumeRepository {
  constructor(
    private readonly accessor: WorkflowDatabaseAccessor,
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
  ) {}

  async createHumanTakeoverIntent(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId?: string | null
    physicalTarget?: BrowserHumanTakeoverPhysicalTarget | null
    now?: string
  }): Promise<HumanTakeoverRef> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.parentTaskId)
      if (parent.runId !== input.ownerRunId) throw new Error('takeover_owner_mismatch')
      const browserTaskId = input.browserTaskId ?? null
      const physicalTarget = input.physicalTarget ?? null
      if (physicalTarget) {
        if (
          !browserTaskId
          || !physicalTarget.tabId.trim()
          || !physicalTarget.physicalTargetToken.trim()
          || (physicalTarget.scopeId !== null && physicalTarget.scopeId !== parent.scopeId)
        ) throw new Error('takeover_physical_binding_invalid')
        const child = db.prepare(
          `SELECT parent_task_id, kind, active_execution_binding_json
             FROM browser_tasks WHERE id = ? LIMIT 1`,
        ).get<{
          parent_task_id: string | null
          kind: string
          active_execution_binding_json: string | null
        }>(browserTaskId)
        const childBinding = child?.active_execution_binding_json
          ? parseObjectStrict<TaskExecutionBinding>(
              child.active_execution_binding_json,
              'takeover_browser_execution_binding_json',
            )
          : null
        if (
          !child
          || child.parent_task_id !== parent.taskId
          || child.kind !== 'browser_workflow'
          || childBinding?.runId !== input.ownerRunId
        ) throw new Error('takeover_browser_binding_mismatch')
      }
      if (parent.humanTakeoverRef?.state === 'pending') {
        const pending = parent.humanTakeoverRef
        if (
          pending.ownerRunId !== input.ownerRunId
          || pending.browserTaskId !== browserTaskId
          || workflowDigest(pending.physicalTarget ?? null) !== workflowDigest(physicalTarget)
        ) throw new Error('takeover_pending_intent_conflict')
        return pending
      }
      const ref: HumanTakeoverRef = {
        taskId: parent.taskId,
        takeoverId: `takeover-${randomUUID()}`,
        ownerRunId: input.ownerRunId,
        browserTaskId,
        basisRevision: parent.revision,
        state: 'pending',
        claimedByRunId: null,
        physicalTarget,
        createdAt: input.now || new Date().toISOString(),
      }
      const update = db.prepare(
        `UPDATE task_projections
            SET human_takeover_ref_json = ?, interaction_state = 'human_takeover',
                revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND revision = ? AND run_id = ?`,
      ).run(
        serializeWorkflowJson(ref, 'human_takeover_ref_json'),
        ref.createdAt,
        parent.taskId,
        parent.revision,
        input.ownerRunId,
      )
      if (changed(update) !== 1) throw new Error('takeover_parent_revision_conflict')
      return ref
    })
  }

  async completeHumanTakeover(input: {
    taskId: string
    takeoverId: string
    newOwnerRunId: string
    executionBinding: TaskExecutionBinding
    now?: string
  }): Promise<HumanTakeoverResumeBinding> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.taskId)
      const takeover = parent.humanTakeoverRef
      if (
        !takeover
        || takeover.takeoverId !== input.takeoverId
        || takeover.state !== 'pending'
        || takeover.ownerRunId !== parent.runId
      ) {
        throw new Error('takeover_receipt_not_pending')
      }
      if (input.executionBinding.runId !== input.newOwnerRunId) {
        throw new Error('takeover_execution_binding_run_mismatch')
      }
      const suspensionCheckpointId = parent.checkpointRefs.suspensionCheckpointId
      const recoveredPendingIntent = !suspensionCheckpointId
      const sourceCheckpointId = suspensionCheckpointId
        || (recoveredPendingIntent ? parent.checkpointRefs.cleanBaseCheckpointId : null)
      if (!sourceCheckpointId) throw new Error('takeover_suspension_checkpoint_required')
      const source = this.readCheckpointFromDb(db, sourceCheckpointId)
      if (
        !source
        || (recoveredPendingIntent ? source.role !== 'clean_base' : source.role !== 'suspension')
        || source.ownerRunId !== parent.runId
        || !source.browserTaskId
      ) {
        throw new Error('takeover_suspension_checkpoint_invalid')
      }
      const oldRun = db.prepare(
        `SELECT status FROM run_meta WHERE run_id = ? AND task_id = ? LIMIT 1`,
      ).get<{ status: string }>(parent.runId, parent.taskId)
      if (
        !oldRun
        || (
          recoveredPendingIntent
            ? !['running', 'checkpoint', 'interrupted'].includes(oldRun.status)
            : !['checkpoint', 'interrupted'].includes(oldRun.status)
        )
      ) {
        throw new Error('takeover_owner_not_suspended')
      }
      if (takeover?.state === 'pending' && takeover.browserTaskId && takeover.browserTaskId !== source.browserTaskId) {
        throw new Error('takeover_browser_task_mismatch')
      }
      const child = db.prepare(
        `SELECT payload_json FROM browser_tasks
          WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
      ).get<{ payload_json: string | null }>(source.browserTaskId, parent.taskId)
      if (!child) throw new Error('takeover_browser_child_missing')

      const createdAt = input.now || new Date().toISOString()
      const checkpointId = `checkpoint-${randomUUID()}`
      const copied = recoveredPendingIntent
        ? (() => {
            const recoveryFact = {
              role: 'system',
              content: 'Browser human takeover was durably requested before the standard tool result reached the session. Resume from the last clean boundary without replaying the request.',
              providerData: {
                readyHumanTakeoverRecoveryFact: {
                  takeoverId: input.takeoverId,
                  previousOwnerRunId: parent.runId,
                  standardToolResultPersisted: false,
                  replayAllowed: false,
                },
              },
            } as unknown as AgentInputItem
            const finalInput = [...source.finalInput, recoveryFact]
            assertAgentInputToolPairIntegrity(finalInput)
            const finalInputJson = serializeWorkflowJson(finalInput, 'takeover_recovery_final_input_json')
            return db.prepare(
              `INSERT INTO agent_session_checkpoints (
                checkpoint_id, role, parent_task_id, browser_task_id, owner_run_id,
                ancestor_owner_run_id, ancestor_checkpoint_digest,
                schema_major, serializer_major, registry_major, safety_major,
                final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
                last_effective_browser_action_seq, steering_receipt_ids_json,
                steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
                prepared_skill_json, activated_capability_groups_json, created_at
              ) VALUES (?, 'clean_base', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              checkpointId, source.parentTaskId, source.browserTaskId, input.newOwnerRunId,
              source.ownerRunId, source.finalInputDigest, source.schemaMajor, source.serializerMajor,
              source.registryMajor, source.safetyMajor, finalInputJson,
              digestSerializedJson(finalInputJson), source.sdkSourceItemCount,
              source.sdkSourcePrefixDigest, source.lastEffectiveBrowserActionSeq,
              serializeWorkflowJson(source.steeringReceiptIds, 'takeover_recovery_steering_ids_json'),
              serializeWorkflowJson(source.steeringReceiptDigests, 'takeover_recovery_steering_digests_json'),
              serializeWorkflowJson(source.requiredOperationIds, 'takeover_recovery_operations_json'),
              serializeWorkflowJson(source.resourceRefs, 'takeover_recovery_resources_json'),
              serializeWorkflowJson(source.preparedSkill, 'takeover_recovery_prepared_skill_json'),
              serializeWorkflowJson(source.activatedCapabilityGroups, 'takeover_recovery_groups_json'),
              createdAt,
            )
          })()
        : db.prepare(
            `INSERT INTO agent_session_checkpoints (
              checkpoint_id, role, parent_task_id, browser_task_id, owner_run_id,
              ancestor_owner_run_id, ancestor_checkpoint_digest,
              schema_major, serializer_major, registry_major, safety_major,
              final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
              last_effective_browser_action_seq, steering_receipt_ids_json,
              steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
              prepared_skill_json, activated_capability_groups_json, created_at
            ) SELECT ?, 'clean_base', parent_task_id, browser_task_id, ?, owner_run_id,
                     final_input_digest, schema_major, serializer_major, registry_major, safety_major,
                     final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
                     last_effective_browser_action_seq, steering_receipt_ids_json,
                     steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
                     prepared_skill_json, activated_capability_groups_json, ?
                FROM agent_session_checkpoints WHERE checkpoint_id = ?`,
          ).run(checkpointId, input.newOwnerRunId, createdAt, sourceCheckpointId)
      if (changed(copied) !== 1) throw new Error('takeover_new_owner_checkpoint_copy_failed')

      if (recoveredPendingIntent && oldRun.status === 'running') {
        const recovered = db.prepare(
          `UPDATE run_meta
              SET status = 'checkpoint', terminal_reason = 'human_takeover_result_missing',
                  updated_at = ?
            WHERE run_id = ? AND task_id = ? AND status = 'running'`,
        ).run(Date.parse(createdAt) || Date.now(), parent.runId, parent.taskId)
        if (changed(recovered) !== 1) throw new Error('takeover_recovery_run_meta_conflict')
      }

      const claimed: HumanTakeoverRef = {
        ...takeover,
        state: 'claimed',
        claimedByRunId: input.newOwnerRunId,
      }
      const checkpointRefs: AgentCheckpointRefs = {
        cleanBaseCheckpointId: checkpointId,
        suspensionCheckpointId: null,
      }
      const parentUpdate = db.prepare(
        `UPDATE task_projections
            SET run_id = ?, execution_binding_json = ?, human_takeover_ref_json = ?,
                checkpoint_refs_json = ?, status = 'running', interaction_state = 'resuming',
                waiting_for = 'none', blocked_reason = NULL, resumable_actions_json = ?,
                revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND revision = ? AND run_id = ?`,
      ).run(
        input.newOwnerRunId,
        serializeWorkflowJson(input.executionBinding, 'takeover_execution_binding_json'),
        serializeWorkflowJson(claimed, 'human_takeover_ref_json'),
        serializeWorkflowJson(checkpointRefs, 'checkpoint_refs_json'),
        serializeWorkflowJson(['none'], 'takeover_running_resumable_actions_json'),
        createdAt,
        parent.taskId,
        parent.revision,
        parent.runId,
      )
      if (changed(parentUpdate) !== 1) throw new Error('takeover_parent_revision_conflict')

      const payload = child.payload_json
        ? parseObjectStrict<Record<string, unknown>>(child.payload_json, 'takeover_browser_payload_json')
        : {}
      const childUpdate = db.prepare(
        `UPDATE browser_tasks
            SET status = 'running', payload_json = ?, active_execution_binding_json = ?,
                revision = revision + 1, updated_at = ?, finished_at = NULL, error = NULL
          WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow'`,
      ).run(
        serializeWorkflowJson({
          ...payload,
          ownerRunId: input.newOwnerRunId,
          executionBinding: input.executionBinding,
        }, 'takeover_browser_payload_json'),
        serializeWorkflowJson(input.executionBinding, 'takeover_browser_execution_binding_json'),
        createdAt,
        source.browserTaskId,
        parent.taskId,
      )
      if (changed(childUpdate) !== 1) throw new Error('takeover_browser_child_conflict')

      const nowMs = Date.parse(createdAt) || Date.now()
      db.prepare(
        `INSERT INTO run_meta (
          run_id, task_id, scope_id, execution_binding_json, status, initiator,
          input_tokens, output_tokens, total_tokens, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, 0, 0, 0, ?, ?)`,
      ).run(
        input.newOwnerRunId,
        parent.taskId,
        parent.scopeId,
        serializeWorkflowJson(input.executionBinding, 'takeover_run_execution_binding_json'),
        'human_takeover_resume',
        nowMs,
        nowMs,
      )

      db.prepare(
        `DELETE FROM agent_session_checkpoints
          WHERE parent_task_id = ? AND checkpoint_id <> ?`,
      ).run(parent.taskId, checkpointId)
      const checkpoint = this.readCheckpointFromDb(db, checkpointId)
      if (!checkpoint || checkpoint.ownerRunId !== input.newOwnerRunId) {
        throw new Error('takeover_new_owner_checkpoint_readback_failed')
      }
      return {
        parent: readParent(db, parent.taskId),
        browserTaskId: source.browserTaskId,
        checkpoint,
        previousOwnerRunId: parent.runId,
        newOwnerRunId: input.newOwnerRunId,
      }
    })
  }

  currentBrowserPowerConfirmation(parentTaskId: string): {
    request: BrowserPowerConfirmationSuspensionRequest
    checkpointId: string
    basisRevision: number
  } | null {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const parent = readParent(db, parentTaskId)
    const checkpointId = parent.checkpointRefs.suspensionCheckpointId
    if (!checkpointId) return null
    const run = db.prepare(
      `SELECT continuation_ref_json FROM run_meta
        WHERE run_id = ? AND task_id = ? AND status IN ('checkpoint', 'interrupted') LIMIT 1`,
    ).get<{ continuation_ref_json: string | null }>(parent.runId, parent.taskId)
    if (!run?.continuation_ref_json) return null
    const continuation = parseObjectStrict<Record<string, unknown>>(
      run.continuation_ref_json,
      'browser_power_continuation_ref_json',
    )
    const request = powerConfirmationRequestFromContinuation(continuation)
    if (
      continuation.kind !== 'browser_checkpoint'
      || continuation.suspensionReason !== 'browser_power_confirmation'
      || continuation.checkpointId !== checkpointId
      || !request
      || request.target.ownerRunId !== parent.runId
      || request.target.browserTaskId !== continuation.browserTaskId
      || request.target.scopeId !== parent.scopeId
    ) return null
    return { request, checkpointId, basisRevision: parent.revision }
  }

  currentBrowserPermissionConfirmation(parentTaskId: string): {
    request: Extract<BrowserConfirmationSuspensionRequest, { kind: 'browser_permission' }>
    checkpointId: string
    basisRevision: number
  } | null {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const parent = readParent(db, parentTaskId)
    const checkpointId = parent.checkpointRefs.suspensionCheckpointId
    if (!checkpointId) return null
    const run = db.prepare(
      `SELECT continuation_ref_json FROM run_meta
        WHERE run_id = ? AND task_id = ? AND status IN ('checkpoint', 'interrupted') LIMIT 1`,
    ).get<{ continuation_ref_json: string | null }>(parent.runId, parent.taskId)
    if (!run?.continuation_ref_json) return null
    const continuation = parseObjectStrict<Record<string, unknown>>(
      run.continuation_ref_json,
      'browser_permission_continuation_ref_json',
    )
    const request = permissionConfirmationRequestFromContinuation(continuation)
    if (
      continuation.kind !== 'browser_checkpoint'
      || continuation.suspensionReason !== 'browser_permission'
      || continuation.checkpointId !== checkpointId
      || !request
      || request.target.ownerRunId !== parent.runId
      || request.target.browserTaskId !== continuation.browserTaskId
      || request.target.scopeId !== parent.scopeId
    ) return null
    return { request, checkpointId, basisRevision: parent.revision }
  }

  currentOwnerCrashRecovery(parentTaskId: string): {
    receipt: BrowserOwnerCrashRecoveryReceipt
    checkpointId: string
    basisRevision: number
  } | null {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const parent = readParent(db, parentTaskId)
    const checkpointId = parent.checkpointRefs.suspensionCheckpointId
    if (!checkpointId) return null
    const row = db.prepare(
      `SELECT continuation_ref_json FROM run_meta
        WHERE run_id = ? AND task_id = ? AND status = 'interrupted' LIMIT 1`,
    ).get<{ continuation_ref_json: string | null }>(parent.runId, parent.taskId)
    if (!row?.continuation_ref_json) return null
    const continuation = parseObjectStrict<Record<string, unknown>>(
      row.continuation_ref_json,
      'owner_crash_continuation_ref_json',
    )
    const receipt = ownerCrashReceiptFromContinuation(continuation)
    if (
      continuation.kind !== 'browser_checkpoint'
      || continuation.suspensionReason !== 'owner_crash'
      || continuation.checkpointId !== checkpointId
      || !receipt
      || receipt.failedOwnerRunId !== parent.runId
      || receipt.checkpointId !== checkpointId
    ) return null
    return { receipt, checkpointId, basisRevision: parent.revision }
  }

  async settleOwnerFailure(input: {
    parentTaskId: string
    failedOwnerRunId: string
    terminalReason: 'owner_launch_failed' | 'main_process_restarted'
    error: string
    now?: string
  }): Promise<BrowserOwnerCrashRecoveryReceipt | null> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.parentTaskId)
      if (parent.runId !== input.failedOwnerRunId) return null
      if (parent.status !== 'running') return null
      const sourceCheckpointId = parent.checkpointRefs.cleanBaseCheckpointId
      if (!sourceCheckpointId) throw new Error('owner_crash_clean_checkpoint_missing')
      const source = this.readCheckpointFromDb(db, sourceCheckpointId)
      if (
        !source
        || source.role !== 'clean_base'
        || source.ownerRunId !== input.failedOwnerRunId
        || !source.browserTaskId
      ) throw new Error('owner_crash_clean_checkpoint_invalid')
      const winner = db.prepare(
        `SELECT p.execution_binding_json AS parent_binding, r.execution_binding_json AS run_binding,
                r.status AS run_status
           FROM task_projections p
           JOIN run_meta r ON r.run_id = p.run_id AND r.task_id = p.task_id
          WHERE p.task_id = ? AND p.revision = ? AND p.run_id = ? LIMIT 1`,
      ).get<{
        parent_binding: string | null
        run_binding: string | null
        run_status: string
      }>(parent.taskId, parent.revision, input.failedOwnerRunId)
      if (
        !winner?.parent_binding
        || !winner.run_binding
        || winner.run_status !== 'running'
        || workflowDigest(parseObjectStrict(winner.parent_binding, 'owner_crash_parent_binding_json'))
          !== workflowDigest(parseObjectStrict(winner.run_binding, 'owner_crash_run_binding_json'))
      ) throw new Error('owner_crash_execution_winner_mismatch')

      const createdAt = input.now || new Date().toISOString()
      const checkpointId = `checkpoint-${randomUUID()}`
      const receipt: BrowserOwnerCrashRecoveryReceipt = {
        version: 1,
        receiptId: `owner-crash-${workflowDigest({
          parentTaskId: parent.taskId,
          failedOwnerRunId: input.failedOwnerRunId,
          checkpointId,
          error: input.error,
          createdAt,
        }).slice(0, 32)}`,
        failedOwnerRunId: input.failedOwnerRunId,
        checkpointId,
        errorDigest: workflowDigest(input.error),
        createdAt,
      }
      const copied = db.prepare(
        `INSERT INTO agent_session_checkpoints (
          checkpoint_id, role, parent_task_id, browser_task_id, owner_run_id,
          ancestor_owner_run_id, ancestor_checkpoint_digest,
          schema_major, serializer_major, registry_major, safety_major,
          final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
          last_effective_browser_action_seq, steering_receipt_ids_json,
          steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
          prepared_skill_json, activated_capability_groups_json, created_at
        ) SELECT ?, 'suspension', parent_task_id, browser_task_id, owner_run_id,
                 ancestor_owner_run_id, ancestor_checkpoint_digest,
                 schema_major, serializer_major, registry_major, safety_major,
                 final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
                 last_effective_browser_action_seq, steering_receipt_ids_json,
                 steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
                 prepared_skill_json, activated_capability_groups_json, ?
            FROM agent_session_checkpoints
           WHERE checkpoint_id = ? AND role = 'clean_base' AND owner_run_id = ?`,
      ).run(checkpointId, createdAt, sourceCheckpointId, input.failedOwnerRunId)
      if (changed(copied) !== 1) throw new Error('owner_crash_checkpoint_copy_failed')

      const checkpointRefs: AgentCheckpointRefs = {
        cleanBaseCheckpointId: null,
        suspensionCheckpointId: checkpointId,
      }
      const parentUpdate = db.prepare(
        `UPDATE task_projections
            SET status = 'recoverable_paused', interaction_state = 'suspended',
                waiting_for = 'none', blocked_reason = 'browser_owner_crash_checkpoint',
                resumable_actions_json = ?, checkpoint_refs_json = ?,
                revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND revision = ? AND run_id = ?
            AND status = 'running' AND execution_binding_json = ?`,
      ).run(
        serializeWorkflowJson(['continue', 'cancel'], 'owner_crash_resumable_actions_json'),
        serializeWorkflowJson(checkpointRefs, 'owner_crash_checkpoint_refs_json'),
        createdAt,
        parent.taskId,
        parent.revision,
        input.failedOwnerRunId,
        winner.parent_binding,
      )
      if (changed(parentUpdate) !== 1) throw new Error('owner_crash_parent_conflict')

      const continuation = {
        kind: 'browser_checkpoint',
        checkpointId,
        browserTaskId: source.browserTaskId,
        suspensionReason: 'owner_crash',
        ownerCrashReceipt: receipt,
      }
      const runUpdate = db.prepare(
        `UPDATE run_meta
            SET status = 'interrupted', terminal_reason = ?,
                continuation_ref_json = ?, updated_at = ?
          WHERE run_id = ? AND task_id = ? AND status = 'running'
            AND execution_binding_json = ?`,
      ).run(
        input.terminalReason,
        serializeWorkflowJson(continuation, 'owner_crash_continuation_ref_json'),
        Date.parse(createdAt) || Date.now(),
        input.failedOwnerRunId,
        parent.taskId,
        winner.run_binding,
      )
      if (changed(runUpdate) !== 1) throw new Error('owner_crash_run_conflict')

      const childUpdate = db.prepare(
        `UPDATE browser_tasks SET status = 'paused', updated_at = ?
          WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow'
            AND status = 'running' AND active_execution_binding_json = ?`,
      ).run(createdAt, source.browserTaskId, parent.taskId, winner.parent_binding)
      if (changed(childUpdate) !== 1) throw new Error('owner_crash_child_conflict')
      db.prepare('DELETE FROM agent_session_checkpoints WHERE checkpoint_id = ?').run(sourceCheckpointId)
      return receipt
    })
  }

  async resumeSuspendedBrowserWorkflow(input: {
    taskId: string
    newOwnerRunId: string
    executionBinding: TaskExecutionBinding
    wake: BrowserCheckpointWakeReceiptInput
    now?: string
  }): Promise<HumanTakeoverResumeBinding> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.taskId)
      if (parent.humanTakeoverRef?.state === 'pending') throw new Error('typed_takeover_receipt_required')
      if (input.executionBinding.runId !== input.newOwnerRunId) {
        throw new Error('checkpoint_resume_execution_binding_run_mismatch')
      }
      const checkpointId = parent.checkpointRefs.suspensionCheckpointId
      if (!checkpointId || checkpointId !== input.wake.checkpointId) {
        throw new Error('checkpoint_wake_checkpoint_mismatch')
      }
      if (parent.revision !== input.wake.basisRevision) {
        throw new Error('checkpoint_wake_basis_revision_mismatch')
      }
      const source = this.readCheckpointFromDb(db, checkpointId)
      if (
        !source
        || source.role !== 'suspension'
        || source.ownerRunId !== parent.runId
        || !source.browserTaskId
      ) {
        throw new Error('checkpoint_resume_source_invalid')
      }
      const oldRun = db.prepare(
        `SELECT status, continuation_ref_json FROM run_meta
          WHERE run_id = ? AND task_id = ? LIMIT 1`,
      ).get<{ status: string; continuation_ref_json: string | null }>(parent.runId, parent.taskId)
      if (!oldRun || !['checkpoint', 'interrupted'].includes(oldRun.status)) {
        throw new Error('checkpoint_resume_owner_not_suspended')
      }
      const continuation = parseObjectStrict<Record<string, unknown>>(
        oldRun.continuation_ref_json,
        'checkpoint_resume_continuation_ref_json',
      )
      if (continuation.checkpointId !== checkpointId || continuation.kind !== 'browser_checkpoint') {
        throw new Error('checkpoint_resume_continuation_mismatch')
      }
      const suspensionReason = String(continuation.suspensionReason || '')
      if (![
        'human_takeover',
        'browser_power_confirmation',
        'browser_permission',
        'budget',
        'steering',
        'incomplete',
        'background',
        'foreground',
        'capability',
        'config',
        'provider_transfer',
        'owner_crash',
        'manual',
      ].includes(suspensionReason)) {
        throw new Error('checkpoint_suspension_reason_unknown')
      }
      const expectedWakeKind = browserWakeKindForSuspensionReason(
        suspensionReason as BrowserCheckpointSuspensionReason,
      )
      if (input.wake.kind !== expectedWakeKind) throw new Error('checkpoint_wake_kind_mismatch')
      const wakeId = String(input.wake.wakeId || '').trim()
      const sourceId = String(input.wake.sourceId || '').trim()
      if (!wakeId || !sourceId || !input.wake.issuedAt) throw new Error('checkpoint_wake_invalid')
      if (input.wake.kind === 'steering') {
        const index = source.steeringReceiptIds.indexOf(sourceId)
        if (index < 0 || source.steeringReceiptDigests[index] !== input.wake.sourceDigest) {
          throw new Error('checkpoint_wake_steering_digest_mismatch')
        }
      } else if (
        input.wake.kind === 'browser_power_confirmation'
        || input.wake.kind === 'browser_permission'
      ) {
        const request = confirmationRequestFromContinuation(continuation)
        if (
          !request
          || request.wakeKind !== input.wake.kind
          || request.requestId !== sourceId
          || request.target.ownerRunId !== parent.runId
          || request.target.browserTaskId !== source.browserTaskId
          || request.target.scopeId !== parent.scopeId
          || (input.wake.decision !== 'confirmed' && input.wake.decision !== 'denied')
        ) throw new Error('checkpoint_confirmation_wake_invalid')
        const expectedDigest = workflowDigest({
          parentTaskId: parent.taskId,
          checkpointId,
          basisRevision: parent.revision,
          kind: input.wake.kind,
          sourceId,
          decision: input.wake.decision,
          request,
        })
        if (input.wake.sourceDigest !== expectedDigest) {
          throw new Error('checkpoint_confirmation_digest_mismatch')
        }
      } else if (input.wake.kind === 'owner_crash') {
        const receipt = ownerCrashReceiptFromContinuation(continuation)
        if (
          !receipt
          || receipt.receiptId !== sourceId
          || receipt.failedOwnerRunId !== parent.runId
          || receipt.checkpointId !== checkpointId
        ) throw new Error('checkpoint_owner_crash_wake_invalid')
        const expectedDigest = workflowDigest({
          parentTaskId: parent.taskId,
          checkpointId,
          basisRevision: parent.revision,
          kind: input.wake.kind,
          sourceId,
          receipt,
        })
        if (input.wake.sourceDigest !== expectedDigest) {
          throw new Error('checkpoint_owner_crash_digest_mismatch')
        }
      } else {
        const expectedDigest = workflowDigest({
          parentTaskId: parent.taskId,
          checkpointId,
          basisRevision: parent.revision,
          kind: input.wake.kind,
          sourceId,
        })
        if (input.wake.sourceDigest !== expectedDigest) {
          throw new Error('checkpoint_wake_source_digest_mismatch')
        }
      }
      const issued = db.prepare(
        `INSERT INTO agent_checkpoint_wake_receipts (
          wake_id, parent_task_id, checkpoint_id, basis_revision, kind,
          source_id, source_digest, issued_at, consumed_by_run_id, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        wakeId,
        parent.taskId,
        checkpointId,
        parent.revision,
        input.wake.kind,
        sourceId,
        input.wake.sourceDigest,
        input.wake.issuedAt,
      )
      if (changed(issued) !== 1) throw new Error('checkpoint_wake_issue_conflict')

      const createdAt = input.now || new Date().toISOString()
      const newCheckpointId = `checkpoint-${randomUUID()}`
      const confirmationRequest = input.wake.kind === 'browser_power_confirmation'
        || input.wake.kind === 'browser_permission'
        ? confirmationRequestFromContinuation(continuation)
        : null
      const copied = confirmationRequest
        ? (() => {
            const decision = input.wake.decision === 'confirmed' ? 'confirmed' : 'denied'
            const powerRequest = confirmationRequest.kind === 'browser_power_confirmation'
              ? confirmationRequest
              : null
            const permissionRequest = confirmationRequest.kind === 'browser_permission'
              ? confirmationRequest
              : null
            const confirmationFact = {
              role: 'system',
              content: powerRequest
                ? decision === 'confirmed'
                  ? 'The user confirmed the exact pending Browser Power request. Retry only that same action; Ready will revalidate the live target before execution.'
                  : 'The user denied the pending Browser Power request. Do not execute or retry that destructive action.'
                : decision === 'confirmed'
                  ? 'The user confirmed the exact pending site-permission request. Retry only that same browser_permission action.'
                  : 'The user denied the exact pending site-permission request. Do not retry the allow action; the live browser callback must still be read back before Ready can report the denial as applied.',
              providerData: powerRequest
                ? {
                    readyBrowserPowerConfirmation: {
                      version: 1,
                      decision,
                      request: powerRequest,
                      previousOwnerRunId: parent.runId,
                      resumedOwnerRunId: input.newOwnerRunId,
                      wakeId,
                    },
                  }
                : {
                    readyBrowserPermissionConfirmation: {
                  version: 1,
                  decision,
                  request: permissionRequest,
                  previousOwnerRunId: parent.runId,
                  resumedOwnerRunId: input.newOwnerRunId,
                  wakeId,
                },
              },
            } as unknown as AgentInputItem
            const finalInput = [...source.finalInput, confirmationFact]
            assertAgentInputToolPairIntegrity(finalInput)
            const finalInputJson = serializeWorkflowJson(finalInput, 'browser_confirmation_final_input_json')
            return db.prepare(
              `INSERT INTO agent_session_checkpoints (
                checkpoint_id, role, parent_task_id, browser_task_id, owner_run_id,
                ancestor_owner_run_id, ancestor_checkpoint_digest,
                schema_major, serializer_major, registry_major, safety_major,
                final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
                last_effective_browser_action_seq, steering_receipt_ids_json,
                steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
                prepared_skill_json, activated_capability_groups_json, created_at
              ) VALUES (?, 'clean_base', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              newCheckpointId, source.parentTaskId, source.browserTaskId, input.newOwnerRunId,
              source.ownerRunId, source.finalInputDigest, source.schemaMajor, source.serializerMajor,
              source.registryMajor, source.safetyMajor, finalInputJson, digestSerializedJson(finalInputJson),
              source.sdkSourceItemCount, source.sdkSourcePrefixDigest, source.lastEffectiveBrowserActionSeq,
              serializeWorkflowJson(source.steeringReceiptIds, 'confirmation_steering_ids_json'),
              serializeWorkflowJson(source.steeringReceiptDigests, 'confirmation_steering_digests_json'),
              serializeWorkflowJson(source.requiredOperationIds, 'confirmation_operations_json'),
              serializeWorkflowJson(source.resourceRefs, 'confirmation_resources_json'),
              serializeWorkflowJson(source.preparedSkill, 'confirmation_prepared_skill_json'),
              serializeWorkflowJson(source.activatedCapabilityGroups, 'confirmation_groups_json'),
              createdAt,
            )
          })()
        : db.prepare(
            `INSERT INTO agent_session_checkpoints (
              checkpoint_id, role, parent_task_id, browser_task_id, owner_run_id,
              ancestor_owner_run_id, ancestor_checkpoint_digest,
              schema_major, serializer_major, registry_major, safety_major,
              final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
              last_effective_browser_action_seq, steering_receipt_ids_json,
              steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
              prepared_skill_json, activated_capability_groups_json, created_at
            ) SELECT ?, 'clean_base', parent_task_id, browser_task_id, ?, owner_run_id,
                     final_input_digest, schema_major, serializer_major, registry_major, safety_major,
                     final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
                     last_effective_browser_action_seq, steering_receipt_ids_json,
                     steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
                     prepared_skill_json, activated_capability_groups_json, ?
                FROM agent_session_checkpoints WHERE checkpoint_id = ? AND role = 'suspension'`,
          ).run(newCheckpointId, input.newOwnerRunId, createdAt, checkpointId)
      if (changed(copied) !== 1) throw new Error('checkpoint_resume_owner_checkpoint_copy_failed')

      const receipts = parent.steeringReceipts.map((receipt) =>
        input.wake.kind === 'steering' && receipt.receiptId === sourceId
          ? { ...receipt, wakeClaimedByRunId: input.newOwnerRunId }
          : receipt,
      )
      const checkpointRefs: AgentCheckpointRefs = {
        cleanBaseCheckpointId: newCheckpointId,
        suspensionCheckpointId: null,
      }
      const parentUpdate = db.prepare(
        `UPDATE task_projections
            SET run_id = ?, execution_binding_json = ?, steering_receipts_json = ?,
                checkpoint_refs_json = ?, status = 'running', interaction_state = 'resuming',
                waiting_for = 'none', blocked_reason = NULL, resumable_actions_json = ?,
                revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND revision = ? AND run_id = ?`,
      ).run(
        input.newOwnerRunId,
        serializeWorkflowJson(input.executionBinding, 'checkpoint_resume_execution_binding_json'),
        serializeWorkflowJson(receipts, 'checkpoint_resume_steering_receipts_json'),
        serializeWorkflowJson(checkpointRefs, 'checkpoint_resume_refs_json'),
        serializeWorkflowJson(['none'], 'checkpoint_resume_actions_json'),
        createdAt,
        parent.taskId,
        parent.revision,
        parent.runId,
      )
      if (changed(parentUpdate) !== 1) throw new Error('checkpoint_resume_parent_revision_conflict')

      const child = db.prepare(
        `SELECT payload_json FROM browser_tasks
          WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
      ).get<{ payload_json: string | null }>(source.browserTaskId, parent.taskId)
      if (!child) throw new Error('checkpoint_resume_browser_child_missing')
      const payload = child.payload_json
        ? parseObjectStrict<Record<string, unknown>>(child.payload_json, 'checkpoint_resume_browser_payload_json')
        : {}
      const childUpdate = db.prepare(
        `UPDATE browser_tasks
            SET status = 'running', payload_json = ?, active_execution_binding_json = ?,
                revision = revision + 1, updated_at = ?, finished_at = NULL, error = NULL
          WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow'`,
      ).run(
        serializeWorkflowJson({
          ...payload,
          ownerRunId: input.newOwnerRunId,
          executionBinding: input.executionBinding,
        }, 'checkpoint_resume_browser_payload_json'),
        serializeWorkflowJson(input.executionBinding, 'checkpoint_resume_browser_binding_json'),
        createdAt,
        source.browserTaskId,
        parent.taskId,
      )
      if (changed(childUpdate) !== 1) throw new Error('checkpoint_resume_browser_child_conflict')

      const nowMs = Date.parse(createdAt) || Date.now()
      const newRun = db.prepare(
        `INSERT INTO run_meta (
          run_id, task_id, scope_id, execution_binding_json, status, initiator,
          input_tokens, output_tokens, total_tokens, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, 0, 0, 0, ?, ?)`,
      ).run(
        input.newOwnerRunId,
        parent.taskId,
        parent.scopeId,
        serializeWorkflowJson(input.executionBinding, 'checkpoint_resume_run_binding_json'),
        `browser_checkpoint_resume:${input.wake.kind}`,
        nowMs,
        nowMs,
      )
      if (changed(newRun) !== 1) throw new Error('checkpoint_resume_run_conflict')
      const consumed = db.prepare(
        `UPDATE agent_checkpoint_wake_receipts
            SET consumed_by_run_id = ?, consumed_at = ?
          WHERE wake_id = ? AND consumed_by_run_id IS NULL`,
      ).run(input.newOwnerRunId, createdAt, wakeId)
      if (changed(consumed) !== 1) throw new Error('checkpoint_wake_consume_conflict')
      db.prepare(
        `DELETE FROM agent_session_checkpoints
          WHERE parent_task_id = ? AND checkpoint_id <> ?`,
      ).run(parent.taskId, newCheckpointId)
      const checkpoint = this.readCheckpointFromDb(db, newCheckpointId)
      if (!checkpoint || checkpoint.ownerRunId !== input.newOwnerRunId) {
        throw new Error('checkpoint_resume_readback_failed')
      }
      return {
        parent: readParent(db, parent.taskId),
        browserTaskId: source.browserTaskId,
        checkpoint,
        previousOwnerRunId: parent.runId,
        newOwnerRunId: input.newOwnerRunId,
      }
    })
  }

  private readCheckpointFromDb(db: WorkflowRawDatabase, checkpointId: string): AgentSessionCheckpoint | null {
    const row = db.prepare(
      'SELECT * FROM agent_session_checkpoints WHERE checkpoint_id = ? LIMIT 1',
    ).get<WorkflowCheckpointRow>(checkpointId)
    return row ? mapWorkflowCheckpointRow(row) : null
  }
}
