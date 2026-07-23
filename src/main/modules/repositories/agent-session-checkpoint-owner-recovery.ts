import { randomUUID } from 'node:crypto'
import type { AgentInputItem } from '@openai/agents'
import type {
  AgentCheckpointRefs,
  BrowserCheckpointSuspensionReason,
  BrowserCheckpointWakeKind,
  BrowserConfirmationSuspensionRequest,
  BrowserHumanTakeoverPrompt,
  BrowserHumanTakeoverPhysicalTarget,
  BrowserOwnerCrashRecoveryReceipt,
  BrowserPowerConfirmationSuspensionRequest,
  HumanTakeoverRef,
} from '../../../shared/browser-workflow-control'
import { browserHumanTakeoverBlockedReason, browserWakeKindForSuspensionReason } from '../../../shared/browser-workflow-control'
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
import { suspendHeldBrowserTargetClaims } from './agent-session-checkpoint-store'
import { buildTypedResumeCheckpointInput } from './typed-resume-checkpoint'

const readParent = readWorkflowParent

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export class AgentSessionCheckpointOwnerRecoveryRepository {
  constructor(
    private readonly accessor: WorkflowDatabaseAccessor,
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
  ) {}

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
      suspendHeldBrowserTargetClaims(db, {
        ownerRunId: input.failedOwnerRunId,
        checkpointId,
        cleanBaseCheckpointId: sourceCheckpointId,
        suspensionReason: 'owner_crash',
        createdAt,
      })

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

  private readCheckpointFromDb(db: WorkflowRawDatabase, checkpointId: string): AgentSessionCheckpoint | null {
    const row = db.prepare(
      'SELECT * FROM agent_session_checkpoints WHERE checkpoint_id = ? LIMIT 1',
    ).get<WorkflowCheckpointRow>(checkpointId)
    return row ? mapWorkflowCheckpointRow(row) : null
  }
}
