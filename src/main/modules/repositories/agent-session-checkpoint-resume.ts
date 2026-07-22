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
    targetClaimId?: string | null
    targetClaimGeneration?: number | null
    physicalTarget?: BrowserHumanTakeoverPhysicalTarget | null
    userPrompt?: BrowserHumanTakeoverPrompt | null
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
      const pending = parent.humanTakeoverRef?.state === 'pending'
        ? parent.humanTakeoverRef
        : null
      if (pending && (
        pending.ownerRunId !== input.ownerRunId
        || pending.browserTaskId !== browserTaskId
      )) throw new Error('takeover_pending_intent_conflict')
      if (
        pending
        && workflowDigest(pending.physicalTarget ?? null) === workflowDigest(physicalTarget)
      ) return pending
      let takeoverClaim: {
        partition: string
        tabId: string
        physicalTargetToken: string
        bootIncarnationId: string
        previousClaimId: string
        previousGeneration: number
        nextClaimId: string
        nextGeneration: number
        suspensionCheckpointId: string
      } | null = null
      if (physicalTarget && browserTaskId && input.targetClaimId && input.targetClaimGeneration) {
        const partition = physicalTarget.profileId
          ? `persist:browser-profile-${physicalTarget.profileId.trim().toLowerCase()}`
          : 'persist:browser'
        const current = db.prepare(`
          SELECT physical_target_token, boot_incarnation_id, claim_id, generation, state,
                 parent_task_id, browser_task_id, owner_run_id
            FROM browser_target_claims
           WHERE partition = ? AND tab_id = ? LIMIT 1
        `).get<{
          physical_target_token: string | null
          boot_incarnation_id: string | null
          claim_id: string
          generation: number
          state: string
          parent_task_id: string
          browser_task_id: string
          owner_run_id: string
        }>(partition, physicalTarget.tabId)
        if (
          !current
          || current.state !== 'held'
          || current.parent_task_id !== parent.taskId
          || current.browser_task_id !== browserTaskId
          || current.owner_run_id !== input.ownerRunId
          || current.claim_id !== input.targetClaimId
          || current.generation !== input.targetClaimGeneration
          || current.physical_target_token !== physicalTarget.physicalTargetToken
          || !current.boot_incarnation_id
          || !parent.checkpointRefs.cleanBaseCheckpointId
        ) throw new Error('takeover_target_claim_mismatch')
        takeoverClaim = {
          partition,
          tabId: physicalTarget.tabId,
          physicalTargetToken: current.physical_target_token,
          bootIncarnationId: current.boot_incarnation_id,
          previousClaimId: current.claim_id,
          previousGeneration: current.generation,
          nextClaimId: `claim-${randomUUID()}`,
          nextGeneration: current.generation + 1,
          suspensionCheckpointId: parent.checkpointRefs.cleanBaseCheckpointId,
        }
      }
      const ref: HumanTakeoverRef = pending || {
        taskId: parent.taskId,
        takeoverId: `takeover-${randomUUID()}`,
        ownerRunId: input.ownerRunId,
        browserTaskId,
        basisRevision: parent.revision,
        state: 'pending',
        claimedByRunId: null,
        physicalTarget,
        userPrompt: input.userPrompt ?? null,
        createdAt: input.now || new Date().toISOString(),
      }
      if (!pending) {
        const update = db.prepare(
          `UPDATE task_projections
              SET human_takeover_ref_json = ?, interaction_state = 'human_takeover',
                  waiting_for = 'confirmation', blocked_reason = ?, resumable_actions_json = ?,
                  revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND revision = ? AND run_id = ?`,
        ).run(
          serializeWorkflowJson(ref, 'human_takeover_ref_json'),
          browserHumanTakeoverBlockedReason(ref.userPrompt),
          serializeWorkflowJson(['continue', 'cancel'], 'takeover_resumable_actions_json'),
          ref.createdAt,
          parent.taskId,
          parent.revision,
          input.ownerRunId,
        )
        if (changed(update) !== 1) throw new Error('takeover_parent_revision_conflict')
      }
      if (takeoverClaim) {
        const updatedClaim = db.prepare(`
          UPDATE browser_target_claims
             SET state = 'user_owned', claim_id = ?, generation = ?,
                 suspension_checkpoint_id = ?, suspension_reason = 'browser_target_user_owned',
                 expires_at = ?, updated_at = ?
           WHERE partition = ? AND tab_id = ? AND state = 'held'
             AND claim_id = ? AND generation = ? AND owner_run_id = ?
        `).run(
          takeoverClaim.nextClaimId,
          takeoverClaim.nextGeneration,
          takeoverClaim.suspensionCheckpointId,
          Date.parse(ref.createdAt),
          Date.parse(ref.createdAt),
          takeoverClaim.partition,
          takeoverClaim.tabId,
          takeoverClaim.previousClaimId,
          takeoverClaim.previousGeneration,
          input.ownerRunId,
        )
        if (changed(updatedClaim) !== 1) throw new Error('takeover_target_claim_cas_conflict')
        const sequence = Number(db.prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
        ).get<{ sequence: number }>(browserTaskId)?.sequence || 1)
        db.prepare(`
          INSERT INTO browser_control_receipts (
            receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
            partition, tab_id, physical_target_token, boot_incarnation_id,
            previous_claim_id, previous_generation, next_claim_id, next_generation,
            clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
            continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'target_user_owned', NULL, 1, ?)
        `).run(
          `browser-control-${randomUUID()}`,
          sequence,
          parent.taskId,
          browserTaskId,
          input.ownerRunId,
          takeoverClaim.partition,
          takeoverClaim.tabId,
          takeoverClaim.physicalTargetToken,
          takeoverClaim.bootIncarnationId,
          takeoverClaim.previousClaimId,
          takeoverClaim.previousGeneration,
          takeoverClaim.nextClaimId,
          takeoverClaim.nextGeneration,
          parent.checkpointRefs.cleanBaseCheckpointId,
          takeoverClaim.suspensionCheckpointId,
          ref.takeoverId,
          `target_user_owned:${takeoverClaim.nextClaimId}:${takeoverClaim.nextGeneration}`,
          ref.createdAt,
        )
      }
      return ref
    })
  }

  async completeHumanTakeover(input: {
    taskId: string
    takeoverId: string
    newOwnerRunId: string
    executionBinding: TaskExecutionBinding
    wakeId?: string
    targetClaim?: {
      partition: string
      tabId: string
      physicalTargetToken: string
      claimId: string
      generation: number
      suspensionCheckpointId: string
      browserTaskId: string
    }
    now?: string
  }): Promise<HumanTakeoverResumeBinding> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.taskId)
      const takeover = parent.humanTakeoverRef
      if (
        takeover?.state === 'claimed'
        && takeover.claimedByRunId === parent.runId
        && input.targetClaim
      ) {
        return this.resumeAdditionalTargetForCurrentOwner(db, parent, input)
      }
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
      const takeoverTarget = takeover.physicalTarget
      const targetPartition = input.targetClaim?.partition || (takeoverTarget?.profileId
        ? `persist:browser-profile-${takeoverTarget.profileId.trim().toLowerCase()}`
        : 'persist:browser')
      const targetTabId = input.targetClaim?.tabId || takeoverTarget?.tabId || null
      const targetClaim = targetTabId
        ? db.prepare(`
            SELECT claim_id, generation, physical_target_token, boot_incarnation_id,
                   suspension_checkpoint_id
              FROM browser_target_claims
             WHERE partition = ? AND tab_id = ? AND parent_task_id = ?
               AND browser_task_id = ? AND owner_run_id = ? AND state = 'user_owned'
             LIMIT 1
          `).get<{
            claim_id: string
            generation: number
            physical_target_token: string | null
            boot_incarnation_id: string | null
            suspension_checkpoint_id: string | null
          }>(
            targetPartition,
            targetTabId,
            parent.taskId,
            source.browserTaskId,
            parent.runId,
          ) || null
        : null
      const targetOwnershipWake = Boolean(db.prepare(`
        SELECT 1 AS present FROM browser_control_receipts
         WHERE wake_id = ? AND kind = 'target_user_owned' LIMIT 1
      `).get(input.takeoverId))
      if ((targetOwnershipWake || input.targetClaim) && !targetClaim) throw new Error('takeover_target_resume_claim_missing')
      if (
        targetClaim
        && (
          targetClaim.physical_target_token !== (input.targetClaim?.physicalTargetToken || takeoverTarget?.physicalTargetToken)
          || !targetClaim.boot_incarnation_id
          || targetClaim.suspension_checkpoint_id !== sourceCheckpointId
          || (input.targetClaim && (
            targetClaim.claim_id !== input.targetClaim.claimId
            || targetClaim.generation !== input.targetClaim.generation
            || targetClaim.suspension_checkpoint_id !== input.targetClaim.suspensionCheckpointId
          ))
        )
      ) throw new Error('takeover_target_resume_identity_mismatch')
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

      if (targetClaim && targetTabId) {
        const nextClaimId = `claim-${randomUUID()}`
        const nextGeneration = targetClaim.generation + 1
        const targetUpdate = db.prepare(`
          UPDATE browser_target_claims
             SET state = 'held', claim_id = ?, generation = ?, owner_run_id = ?,
                 suspension_checkpoint_id = NULL, suspension_reason = NULL,
                 heartbeat_at = ?, expires_at = ?, updated_at = ?
           WHERE partition = ? AND tab_id = ? AND state = 'user_owned'
             AND claim_id = ? AND generation = ? AND owner_run_id = ?
        `).run(
          nextClaimId,
          nextGeneration,
          input.newOwnerRunId,
          Date.parse(createdAt),
          Date.parse(createdAt) + 60_000,
          Date.parse(createdAt),
          targetPartition,
          targetTabId,
          targetClaim.claim_id,
          targetClaim.generation,
          parent.runId,
        )
        if (changed(targetUpdate) !== 1) throw new Error('takeover_target_resume_cas_conflict')
        const firstSequence = Number(db.prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
        ).get<{ sequence: number }>(source.browserTaskId)?.sequence || 1)
        const insertReceipt = db.prepare(`
          INSERT INTO browser_control_receipts (
            receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
            partition, tab_id, physical_target_token, boot_incarnation_id,
            previous_claim_id, previous_generation, next_claim_id, next_generation,
            clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
            continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `)
        insertReceipt.run(
          `browser-control-${randomUUID()}`,
          firstSequence,
          parent.taskId,
          source.browserTaskId,
          input.newOwnerRunId,
          targetPartition,
          targetTabId,
          targetClaim.physical_target_token,
          targetClaim.boot_incarnation_id,
          targetClaim.claim_id,
          targetClaim.generation,
          nextClaimId,
          nextGeneration,
          checkpointId,
          sourceCheckpointId,
          input.wakeId || input.takeoverId,
          input.newOwnerRunId,
          targetClaim.generation,
          `target_resume_authorized:${input.wakeId || input.takeoverId}`,
          'target_resume_authorized',
          1,
          createdAt,
        )
        insertReceipt.run(
          `browser-control-${randomUUID()}`,
          firstSequence + 1,
          parent.taskId,
          source.browserTaskId,
          input.newOwnerRunId,
          targetPartition,
          targetTabId,
          targetClaim.physical_target_token,
          targetClaim.boot_incarnation_id,
          targetClaim.claim_id,
          targetClaim.generation,
          nextClaimId,
          nextGeneration,
          checkpointId,
          sourceCheckpointId,
          input.wakeId || input.takeoverId,
          input.newOwnerRunId,
          targetClaim.generation,
          `claim_resumed:${nextClaimId}:${nextGeneration}`,
          'claim_resumed',
          0,
          createdAt,
        )
      }

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
        createdSuccessor: true,
      }
    })
  }

  private resumeAdditionalTargetForCurrentOwner(
    db: WorkflowRawDatabase,
    parent: ReturnType<typeof readParent>,
    input: {
      takeoverId: string
      newOwnerRunId: string
      executionBinding: TaskExecutionBinding
      wakeId?: string
      targetClaim?: {
        partition: string
        tabId: string
        physicalTargetToken: string
        claimId: string
        generation: number
        suspensionCheckpointId: string
        browserTaskId: string
      }
      now?: string
    },
  ): HumanTakeoverResumeBinding {
    const target = input.targetClaim
    const takeover = parent.humanTakeoverRef
    if (!target || !takeover || takeover.takeoverId !== input.takeoverId) {
      throw new Error('takeover_target_resume_identity_mismatch')
    }
    const checkpointId = parent.checkpointRefs.cleanBaseCheckpointId
    if (!checkpointId) throw new Error('takeover_current_owner_checkpoint_missing')
    const checkpoint = this.readCheckpointFromDb(db, checkpointId)
    if (
      !checkpoint
      || checkpoint.ownerRunId !== parent.runId
      || checkpoint.browserTaskId !== target.browserTaskId
    ) throw new Error('takeover_current_owner_checkpoint_invalid')
    const claim = db.prepare(`
      SELECT claim_id, generation, physical_target_token, boot_incarnation_id,
             suspension_checkpoint_id, owner_run_id
        FROM browser_target_claims
       WHERE partition = ? AND tab_id = ? AND parent_task_id = ?
         AND browser_task_id = ? AND state = 'user_owned'
       LIMIT 1
    `).get<{
      claim_id: string
      generation: number
      physical_target_token: string | null
      boot_incarnation_id: string | null
      suspension_checkpoint_id: string | null
      owner_run_id: string
    }>(target.partition, target.tabId, parent.taskId, target.browserTaskId)
    if (
      !claim
      || claim.claim_id !== target.claimId
      || claim.generation !== target.generation
      || claim.physical_target_token !== target.physicalTargetToken
      || !claim.boot_incarnation_id
      || claim.suspension_checkpoint_id !== target.suspensionCheckpointId
      || claim.owner_run_id !== takeover.ownerRunId
    ) throw new Error('takeover_target_resume_identity_mismatch')

    const createdAt = input.now || new Date().toISOString()
    const createdAtMs = Date.parse(createdAt) || Date.now()
    const nextClaimId = `claim-${randomUUID()}`
    const nextGeneration = claim.generation + 1
    const updated = db.prepare(`
      UPDATE browser_target_claims
         SET state = 'held', claim_id = ?, generation = ?, owner_run_id = ?,
             suspension_checkpoint_id = NULL, suspension_reason = NULL,
             heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE partition = ? AND tab_id = ? AND state = 'user_owned'
         AND claim_id = ? AND generation = ? AND owner_run_id = ?
    `).run(
      nextClaimId,
      nextGeneration,
      parent.runId,
      createdAtMs,
      createdAtMs + 60_000,
      createdAtMs,
      target.partition,
      target.tabId,
      claim.claim_id,
      claim.generation,
      takeover.ownerRunId,
    )
    if (changed(updated) !== 1) throw new Error('takeover_target_resume_cas_conflict')

    const firstSequence = Number(db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
    ).get<{ sequence: number }>(target.browserTaskId)?.sequence || 1)
    const insertReceipt = db.prepare(`
      INSERT INTO browser_control_receipts (
        receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
        partition, tab_id, physical_target_token, boot_incarnation_id,
        previous_claim_id, previous_generation, next_claim_id, next_generation,
        clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
        continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `)
    const wakeId = input.wakeId || input.takeoverId
    for (const [offset, kind, recoverable] of [
      [0, 'target_resume_authorized', 1],
      [1, 'claim_resumed', 0],
    ] as const) {
      insertReceipt.run(
        `browser-control-${randomUUID()}`,
        firstSequence + offset,
        parent.taskId,
        target.browserTaskId,
        parent.runId,
        target.partition,
        target.tabId,
        claim.physical_target_token,
        claim.boot_incarnation_id,
        claim.claim_id,
        claim.generation,
        nextClaimId,
        nextGeneration,
        checkpointId,
        target.suspensionCheckpointId,
        wakeId,
        parent.runId,
        claim.generation,
        `${kind}:${wakeId}`,
        kind,
        recoverable,
        createdAt,
      )
    }
    return {
      parent: readParent(db, parent.taskId),
      browserTaskId: target.browserTaskId,
      checkpoint,
      previousOwnerRunId: takeover.ownerRunId,
      newOwnerRunId: parent.runId,
      createdSuccessor: false,
    }
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

  async expirePendingBrowserConfirmations(input: {
    scopeId?: string | null
    now?: string
  } = {}): Promise<string[]> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const now = input.now || new Date().toISOString()
      const rows = db.prepare(
        `SELECT task_id, continuation_ref_json, revision
           FROM task_projections
          WHERE status = 'recoverable_paused'
            AND waiting_for = 'confirmation'
            AND blocked_reason IN ('browser_power_confirmation_checkpoint', 'browser_permission_checkpoint')
            AND (? IS NULL OR scope_id = ?)
          ORDER BY updated_at ASC`,
      ).all<{ task_id: string; continuation_ref_json: string | null; revision: number }>(
        input.scopeId || null,
        input.scopeId || null,
      )
      const expiredTaskIds: string[] = []
      for (const row of rows) {
        const continuation = parseObjectStrict<Record<string, unknown>>(
          row.continuation_ref_json,
          'browser_confirmation_expiration_continuation_ref_json',
        )
        if (!confirmationRequestFromContinuation(continuation)) continue
        const nextContinuation = { ...continuation }
        delete nextContinuation.suspensionRequest
        const result = db.prepare(
          `UPDATE task_projections
              SET waiting_for = 'none',
                  blocked_reason = 'browser_confirmation_expired_checkpoint',
                  degradation_reason = 'browser_confirmation_expired_on_restart_or_resend',
                  resumable_actions_json = ?,
                  continuation_ref_json = ?,
                  revision = revision + 1,
                  updated_at = ?
            WHERE task_id = ? AND revision = ? AND waiting_for = 'confirmation'`,
        ).run(
          serializeWorkflowJson(['continue', 'cancel'], 'browser_confirmation_expiration_actions'),
          serializeWorkflowJson(nextContinuation, 'browser_confirmation_expiration_continuation'),
          now,
          row.task_id,
          row.revision,
        )
        if (changed(result) !== 1) throw new Error('browser_confirmation_expiration_cas_failed')
        expiredTaskIds.push(row.task_id)
      }
      return expiredTaskIds
    })
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

  async resumeSuspendedBrowserWorkflow(input: {
    taskId: string
    newOwnerRunId: string
    executionBinding: TaskExecutionBinding
    wake: BrowserCheckpointWakeReceiptInput
    now?: string
  }): Promise<HumanTakeoverResumeBinding> {
    try {
      return await this.unitOfWork.runImmediateWithRetry((db) => {
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
      const sequence = Number(db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
      ).get<{ sequence: number }>(source.browserTaskId)?.sequence || 1)
      db.prepare(`
        INSERT INTO browser_control_receipts (
          receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
          partition, tab_id, physical_target_token, boot_incarnation_id,
          previous_claim_id, previous_generation, next_claim_id, next_generation,
          clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
          continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'task_resume_authorized', NULL, 1, ?)
      `).run(
        `browser-control-${randomUUID()}`,
        sequence,
        parent.taskId,
        source.browserTaskId,
        input.newOwnerRunId,
        newCheckpointId,
        checkpointId,
        wakeId,
        input.newOwnerRunId,
        parent.revision + 1,
        `task_resume_authorized:${wakeId}`,
        createdAt,
      )
      return {
        parent: readParent(db, parent.taskId),
        browserTaskId: source.browserTaskId,
        checkpoint,
        previousOwnerRunId: parent.runId,
        newOwnerRunId: input.newOwnerRunId,
        createdSuccessor: true,
      }
      })
    } catch (error) {
      this.recordResumeRejected(input, error)
      throw error
    }
  }

  private recordResumeRejected(
    input: {
      taskId: string
      newOwnerRunId: string
      wake: BrowserCheckpointWakeReceiptInput
      now?: string
    },
    error: unknown,
  ): void {
    this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.taskId)
      const checkpointId = parent.checkpointRefs.suspensionCheckpointId
      if (!checkpointId) return
      const checkpoint = this.readCheckpointFromDb(db, checkpointId)
      if (!checkpoint?.browserTaskId) return
      const errorCode = error instanceof Error ? error.message : String(error)
      const sequence = Number(db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
      ).get<{ sequence: number }>(checkpoint.browserTaskId)?.sequence || 1)
      db.prepare(`
        INSERT OR IGNORE INTO browser_control_receipts (
          receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
          partition, tab_id, physical_target_token, boot_incarnation_id,
          previous_claim_id, previous_generation, next_claim_id, next_generation,
          clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
          continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, 'resume_rejected', ?, 1, ?)
      `).run(
        `browser-control-${randomUUID()}`,
        sequence,
        parent.taskId,
        checkpoint.browserTaskId,
        parent.runId,
        parent.checkpointRefs.cleanBaseCheckpointId,
        checkpointId,
        String(input.wake.wakeId || ''),
        parent.revision,
        `resume_rejected:${String(input.wake.wakeId || 'missing')}:${workflowDigest(errorCode)}`,
        errorCode,
        input.now || new Date().toISOString(),
      )
    })
  }

  private readCheckpointFromDb(db: WorkflowRawDatabase, checkpointId: string): AgentSessionCheckpoint | null {
    const row = db.prepare(
      'SELECT * FROM agent_session_checkpoints WHERE checkpoint_id = ? LIMIT 1',
    ).get<WorkflowCheckpointRow>(checkpointId)
    return row ? mapWorkflowCheckpointRow(row) : null
  }
}
