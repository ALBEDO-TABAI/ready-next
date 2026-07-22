import { randomUUID } from 'node:crypto'
import type { AgentInputItem } from '@openai/agents'
import type {
  AgentCheckpointRefs,
  BrowserCheckpointSuspensionReason,
  BrowserConfirmationSuspensionRequest,
} from '../../../shared/browser-workflow-control'
import { browserHumanTakeoverBlockedReason } from '../../../shared/browser-workflow-control'
import { browserConfirmationNotice } from '../../../shared/browser-confirmation-card'
import type { CanonicalAssistantMessageReceipt } from '../../../shared/ipc-contracts/canonical-message'
import { BROWSER_OPERATION_IDS } from '../../../shared/browser-capability-registry'
import { assertAgentInputToolPairIntegrity } from '../agent-control/compaction/compact-agent-input'
import { readVerifiedBrowserWorkflowEvidence } from '../browser-engine/browser-workflow-evidence'
import type { PreparedSkillTurnTruth } from '../agent-control/contracts/browser-workflow-control'
import {
  digestSerializedJson,
  parseArrayStrict,
  parseJsonStrict,
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
import type { BrowserObservationGap } from './agent-session-checkpoint-types'
import { buildCanonicalCoreCloseoutMessage } from './canonical-core-closeout-message'

interface ChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json?: string | null
}

export type AgentSessionCheckpointWriteResult = AgentSessionCheckpoint & Partial<CanonicalAssistantMessageReceipt>

interface SteeringMessageResourceRow {
  resource_id: string
  message_id: string
  ordinal: number
  block_type: 'text' | 'image' | 'video'
  media_type: string | null
  content: string
  content_digest: string
  provenance_digest: string
}

const BROWSER_OPERATION_ID_SET = new Set<string>(BROWSER_OPERATION_IDS)

function settledActionSequences(payloadJson: string | null): Set<number> {
  if (!payloadJson) return new Set()
  const payload = parseObjectStrict<Record<string, unknown>>(
    payloadJson,
    'browser_workflow_payload_json',
  )
  const journal = payload.browserWorkflowActionJournal
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return new Set()
  const settled = (journal as Record<string, unknown>).settledOutcomes
  if (!Array.isArray(settled)) return new Set()
  const sequences = new Set<number>()
  for (const item of settled) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const sequence = Math.floor(Number((item as Record<string, unknown>).actionSeq || 0))
    if (Number.isInteger(sequence) && sequence > 0) sequences.add(sequence)
  }
  return sequences
}

const readParent = readWorkflowParent

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export function suspendHeldBrowserTargetClaims(
  db: WorkflowRawDatabase,
  input: {
    ownerRunId: string
    checkpointId: string
    cleanBaseCheckpointId: string | null
    suspensionReason: string
    createdAt: string
  },
): void {
  const claims = db.prepare(`
    SELECT partition, tab_id, physical_target_token, boot_incarnation_id,
           claim_id, generation, parent_task_id, browser_task_id
      FROM browser_target_claims
     WHERE owner_run_id = ? AND state = 'held'
     ORDER BY browser_task_id, partition, tab_id
  `).all<{
    partition: string
    tab_id: string
    physical_target_token: string | null
    boot_incarnation_id: string | null
    claim_id: string
    generation: number
    parent_task_id: string
    browser_task_id: string
  }>(input.ownerRunId)
  const nowMs = Date.parse(input.createdAt) || Date.now()
  for (const claim of claims) {
    const nextClaimId = `claim-${randomUUID()}`
    const nextGeneration = claim.generation + 1
    const update = db.prepare(`
      UPDATE browser_target_claims
         SET state = 'suspended', physical_target_token = NULL, boot_incarnation_id = NULL,
             claim_id = ?, generation = ?, suspension_checkpoint_id = ?, suspension_reason = ?,
             heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE partition = ? AND tab_id = ? AND owner_run_id = ? AND state = 'held'
         AND claim_id = ? AND generation = ?
    `).run(
      nextClaimId,
      nextGeneration,
      input.checkpointId,
      input.suspensionReason,
      nowMs,
      nowMs,
      nowMs,
      claim.partition,
      claim.tab_id,
      input.ownerRunId,
      claim.claim_id,
      claim.generation,
    )
    if (changed(update) !== 1) throw new Error('checkpoint_target_claim_cas_conflict')
    const sequence = Number(db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
    ).get<{ sequence: number }>(claim.browser_task_id)?.sequence || 1)
    db.prepare(`
      INSERT INTO browser_control_receipts (
        receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
        partition, tab_id, physical_target_token, boot_incarnation_id,
        previous_claim_id, previous_generation, next_claim_id, next_generation,
        clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
        continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'claim_suspended', NULL, 1, ?)
    `).run(
      `browser-control-${randomUUID()}`,
      sequence,
      claim.parent_task_id,
      claim.browser_task_id,
      input.ownerRunId,
      claim.partition,
      claim.tab_id,
      claim.physical_target_token,
      claim.boot_incarnation_id,
      claim.claim_id,
      claim.generation,
      nextClaimId,
      nextGeneration,
      input.cleanBaseCheckpointId,
      input.checkpointId,
      `claim-suspended:${claim.claim_id}:${claim.generation}:${input.checkpointId}`,
      input.createdAt,
    )
  }
}

export class AgentSessionCheckpointStoreRepository {
  constructor(
    private readonly accessor: WorkflowDatabaseAccessor,
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
  ) {}

  async writeCleanBoundary(input: {
    parentTaskId: string
    browserTaskId?: string | null
    ownerRunId: string
    role?: 'clean_base' | 'suspension'
    sourceItems: AgentInputItem[]
    sdkSourceItems?: AgentInputItem[]
    sdkSourceItemCount: number
    sdkSourcePrefixDigest: string
    lastEffectiveBrowserActionSeq?: number
    requiredOperationIds?: string[]
    resourceRefs?: string[]
    preparedSkill: PreparedSkillTurnTruth
    activatedCapabilityGroups: string[]
    takeoverId?: string | null
    suspensionRequest?: BrowserConfirmationSuspensionRequest | null
    suspensionReason?: BrowserCheckpointSuspensionReason
    versions?: Partial<Pick<AgentSessionCheckpoint, 'schemaMajor' | 'serializerMajor' | 'registryMajor' | 'safetyMajor'>>
    ancestorOwnerRunId?: string | null
    ancestorCheckpointDigest?: string | null
    now?: string
  }): Promise<AgentSessionCheckpointWriteResult> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.parentTaskId)
      if (parent.runId !== input.ownerRunId) throw new Error('checkpoint_owner_mismatch')
      const suspensionReason = input.role === 'suspension'
        ? input.suspensionReason || (input.takeoverId ? 'human_takeover' : 'manual')
        : null
      if (suspensionReason === 'human_takeover') {
        const takeover = parent.humanTakeoverRef
        if (
          !input.takeoverId
          || !takeover
          || takeover.state !== 'pending'
          || takeover.takeoverId !== input.takeoverId
          || takeover.ownerRunId !== input.ownerRunId
          || (takeover.browserTaskId && takeover.browserTaskId !== input.browserTaskId)
        ) {
          throw new Error('checkpoint_takeover_intent_mismatch')
        }
      } else if (suspensionReason === 'browser_power_confirmation') {
        const request = input.suspensionRequest
        if (
          !request
          || request.kind !== 'browser_power_confirmation'
          || request.target.ownerRunId !== input.ownerRunId
          || request.target.browserTaskId !== input.browserTaskId
          || request.target.scopeId !== parent.scopeId
        ) throw new Error('checkpoint_power_confirmation_request_mismatch')
      } else if (suspensionReason === 'browser_permission') {
        const request = input.suspensionRequest
        if (
          !request
          || request.kind !== 'browser_permission'
          || request.target.ownerRunId !== input.ownerRunId
          || request.target.browserTaskId !== input.browserTaskId
          || request.target.scopeId !== parent.scopeId
        ) throw new Error('checkpoint_permission_request_mismatch')
      }
      const sdkSourceItems = input.sdkSourceItems || input.sourceItems
      if (
        input.sdkSourceItemCount < 0
        || input.sdkSourceItemCount > sdkSourceItems.length
        || workflowDigest(sdkSourceItems.slice(0, input.sdkSourceItemCount)) !== input.sdkSourcePrefixDigest
      ) {
        throw new Error('checkpoint_sdk_source_prefix_mismatch')
      }
      const requiredOperationIds = [...new Set(input.requiredOperationIds || [])].sort()
      if (requiredOperationIds.some((operationId) => !BROWSER_OPERATION_ID_SET.has(operationId))) {
        throw new Error('checkpoint_required_browser_operation_missing')
      }
      const referencedCheckpointIds = [
        parent.checkpointRefs.cleanBaseCheckpointId,
        parent.checkpointRefs.suspensionCheckpointId,
      ].filter((checkpointId): checkpointId is string => Boolean(checkpointId))
      const previousCheckpoints = referencedCheckpointIds
        .map((checkpointId) => this.readCheckpointFromDb(db, checkpointId))
        .filter((checkpoint): checkpoint is AgentSessionCheckpoint => Boolean(checkpoint))
      const previousActionSeq = previousCheckpoints.reduce(
        (highest, checkpoint) => Math.max(highest, checkpoint.lastEffectiveBrowserActionSeq),
        0,
      )
      const proposedActionSeq = Math.max(0, Math.floor(input.lastEffectiveBrowserActionSeq || 0))
      if (proposedActionSeq < previousActionSeq) {
        throw new Error('checkpoint_browser_action_cursor_regressed')
      }
      const previousRequiredOperations = new Set(
        previousCheckpoints.flatMap((checkpoint) => checkpoint.requiredOperationIds),
      )
      if ([...previousRequiredOperations].some((operationId) => !requiredOperationIds.includes(operationId))) {
        throw new Error('checkpoint_required_browser_operation_regressed')
      }
      if (proposedActionSeq > previousActionSeq) {
        if (!input.browserTaskId) throw new Error('checkpoint_browser_task_required_for_action_cursor')
        const child = db.prepare(
          `SELECT payload_json FROM browser_tasks
            WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
        ).get<{ payload_json: string | null }>(input.browserTaskId, parent.taskId)
        if (!child) throw new Error('checkpoint_browser_workflow_child_missing')
        const settledSequences = settledActionSequences(child.payload_json)
        for (let sequence = previousActionSeq + 1; sequence <= proposedActionSeq; sequence += 1) {
          if (!settledSequences.has(sequence)) {
            throw new Error(`checkpoint_browser_action_cursor_gap:${sequence}`)
          }
        }
      }
      const pending = parent.steeringReceipts
        .filter((receipt) => !receipt.contentCheckpointId)
        .sort((left, right) => left.sequence - right.sequence)
      const steeringItems = pending.map((receipt) => {
        const message = db.prepare(
          `SELECT id, conversation_id, role, content, timestamp FROM chat_messages WHERE id = ? LIMIT 1`,
        ).get<ChatMessageRow>(receipt.messageId)
        if (!message || message.role !== 'user') throw new Error('steering_canonical_message_missing')
        const digest = workflowDigest({
          id: message.id,
          conversationId: message.conversation_id,
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
        })
        if (digest !== receipt.messageDigest) throw new Error('steering_canonical_message_digest_mismatch')
        if (
          receipt.contentVersion !== 1
          || !Array.isArray(receipt.resourceRefs)
          || workflowDigest({ version: 1, resourceRefs: receipt.resourceRefs }) !== receipt.contentDigest
        ) throw new Error('steering_structured_receipt_invalid')
        const resources = db.prepare(
          `SELECT resource_id, message_id, ordinal, block_type, media_type, content,
                  content_digest, provenance_digest
             FROM agent_steering_message_resources
            WHERE message_id = ? ORDER BY ordinal ASC`,
        ).all<SteeringMessageResourceRow>(receipt.messageId)
        if (resources.length !== receipt.resourceRefs.length) {
          throw new Error('steering_resource_count_mismatch')
        }
        const content = resources.map((resource, index) => {
          const ref = receipt.resourceRefs[index]
          if (
            !ref
            || ref.resourceId !== resource.resource_id
            || ref.ordinal !== resource.ordinal
            || ref.blockType !== resource.block_type
            || ref.mediaType !== resource.media_type
            || ref.contentDigest !== resource.content_digest
            || ref.provenanceDigest !== resource.provenance_digest
            || workflowDigest({
              blockType: resource.block_type,
              mediaType: resource.media_type,
              content: resource.content,
            }) !== resource.content_digest
          ) throw new Error('steering_resource_digest_mismatch')
          if (resource.block_type === 'image') {
            return {
              type: 'input_image',
              image: `data:${resource.media_type || 'image/png'};base64,${resource.content}`,
              detail: 'auto',
            }
          }
          return {
            type: 'input_text',
            text: resource.block_type === 'video'
              ? '[视频附件已接收；当前 SDK 路径以资源引用继续。]'
              : resource.content,
          }
        })
        return {
          role: 'user',
          content,
          providerData: {
            readySteeringReceipt: {
              receiptId: receipt.receiptId,
              messageDigest: receipt.messageDigest,
              contentDigest: receipt.contentDigest,
              resourceRefs: receipt.resourceRefs,
              sequence: receipt.sequence,
            },
          },
        } as unknown as AgentInputItem
      })

      const finalInputJson = serializeWorkflowJson(
        [...input.sourceItems, ...steeringItems],
        'checkpoint_final_input',
      )
      const finalInput = parseJsonStrict(finalInputJson, 'checkpoint_final_input') as AgentInputItem[]
      if (!Array.isArray(finalInput)) throw new Error('checkpoint_final_input_wrong_shape')
      assertAgentInputToolPairIntegrity(finalInput)
      const checkpointId = `checkpoint-${randomUUID()}`
      const createdAt = input.now || new Date().toISOString()
      const finalInputDigest = digestSerializedJson(finalInputJson)
      const checkpoint: AgentSessionCheckpoint = {
        checkpointId,
        role: input.role || 'clean_base',
        parentTaskId: parent.taskId,
        browserTaskId: input.browserTaskId ?? null,
        ownerRunId: input.ownerRunId,
        ancestorOwnerRunId: input.ancestorOwnerRunId ?? null,
        ancestorCheckpointDigest: input.ancestorCheckpointDigest ?? null,
        schemaMajor: input.versions?.schemaMajor ?? 1,
        serializerMajor: input.versions?.serializerMajor ?? 1,
        registryMajor: input.versions?.registryMajor ?? 1,
        safetyMajor: input.versions?.safetyMajor ?? 1,
        finalInput,
        finalInputDigest,
        sdkSourceItemCount: input.sdkSourceItemCount,
        sdkSourcePrefixDigest: input.sdkSourcePrefixDigest,
        lastEffectiveBrowserActionSeq: proposedActionSeq,
        steeringReceiptIds: pending.map((receipt) => receipt.receiptId),
        steeringReceiptDigests: pending.map((receipt) => receipt.messageDigest),
        requiredOperationIds,
        resourceRefs: [...new Set(input.resourceRefs || [])].sort(),
        preparedSkill: input.preparedSkill,
        activatedCapabilityGroups: [...new Set(input.activatedCapabilityGroups)].sort(),
        createdAt,
      }
      db.prepare(
        `INSERT INTO agent_session_checkpoints (
          checkpoint_id, role, parent_task_id, browser_task_id, owner_run_id,
          ancestor_owner_run_id, ancestor_checkpoint_digest,
          schema_major, serializer_major, registry_major, safety_major,
          final_input_json, final_input_digest, sdk_source_item_count, sdk_source_prefix_digest,
          last_effective_browser_action_seq, steering_receipt_ids_json,
          steering_receipt_digests_json, required_operation_ids_json, resource_refs_json,
          prepared_skill_json, activated_capability_groups_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        checkpoint.checkpointId, checkpoint.role, checkpoint.parentTaskId,
        checkpoint.browserTaskId, checkpoint.ownerRunId, checkpoint.ancestorOwnerRunId,
        checkpoint.ancestorCheckpointDigest, checkpoint.schemaMajor, checkpoint.serializerMajor,
        checkpoint.registryMajor, checkpoint.safetyMajor, finalInputJson,
        checkpoint.finalInputDigest, checkpoint.sdkSourceItemCount,
        checkpoint.sdkSourcePrefixDigest, checkpoint.lastEffectiveBrowserActionSeq,
        serializeWorkflowJson(checkpoint.steeringReceiptIds, 'steering_receipt_ids_json'),
        serializeWorkflowJson(checkpoint.steeringReceiptDigests, 'steering_receipt_digests_json'),
        serializeWorkflowJson(checkpoint.requiredOperationIds, 'required_operation_ids_json'),
        serializeWorkflowJson(checkpoint.resourceRefs, 'resource_refs_json'),
        serializeWorkflowJson(checkpoint.preparedSkill, 'prepared_skill_json'),
        serializeWorkflowJson(checkpoint.activatedCapabilityGroups, 'activated_capability_groups_json'),
        checkpoint.createdAt,
      )

      const receipts = parent.steeringReceipts.map((receipt) => pending.some((item) => item.receiptId === receipt.receiptId)
        ? { ...receipt, contentCheckpointId: checkpointId, consumedByOwnerRunId: input.ownerRunId }
        : receipt)
      const previousCheckpointId = checkpoint.role === 'clean_base'
        ? parent.checkpointRefs.cleanBaseCheckpointId
        : parent.checkpointRefs.suspensionCheckpointId
      const checkpointRefs: AgentCheckpointRefs = checkpoint.role === 'clean_base'
        ? { ...parent.checkpointRefs, cleanBaseCheckpointId: checkpointId }
        : { ...parent.checkpointRefs, suspensionCheckpointId: checkpointId }
      const continuationRef = {
        kind: suspensionReason === 'human_takeover' ? 'human_takeover' : 'browser_checkpoint',
        ...(input.takeoverId ? { takeoverId: input.takeoverId } : {}),
        ...(input.suspensionRequest ? { suspensionRequest: input.suspensionRequest } : {}),
        checkpointId,
        browserTaskId: input.browserTaskId ?? null,
        suspensionReason,
      }
      const parentUpdate = input.role === 'suspension'
        ? db.prepare(
            `UPDATE task_projections
                SET steering_receipts_json = ?, checkpoint_refs_json = ?,
                    status = 'recoverable_paused', interaction_state = ?,
                    waiting_for = ?, blocked_reason = ?,
                    resumable_actions_json = ?, continuation_ref_json = ?,
                    revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND revision = ? AND run_id = ?`,
          ).run(
            serializeWorkflowJson(receipts, 'steering_receipts_json'),
            serializeWorkflowJson(checkpointRefs, 'checkpoint_refs_json'),
            suspensionReason === 'human_takeover' ? 'human_takeover' : 'suspended',
            suspensionReason === 'human_takeover'
              || suspensionReason === 'browser_power_confirmation'
              || suspensionReason === 'browser_permission'
              ? 'confirmation'
              : 'none',
            suspensionReason === 'human_takeover'
              ? browserHumanTakeoverBlockedReason(parent.humanTakeoverRef?.userPrompt)
              : suspensionReason === 'browser_power_confirmation'
                ? 'browser_power_confirmation_checkpoint'
                : suspensionReason === 'browser_permission'
                  ? 'browser_permission_checkpoint'
                : `browser_${suspensionReason || 'manual'}_checkpoint`,
            serializeWorkflowJson(['continue', 'cancel'], 'takeover_resumable_actions_json'),
            serializeWorkflowJson(continuationRef, 'suspension_continuation_ref_json'),
            createdAt,
            parent.taskId,
            parent.revision,
            input.ownerRunId,
          )
        : db.prepare(
            `UPDATE task_projections
                SET steering_receipts_json = ?, checkpoint_refs_json = ?,
                    revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND revision = ? AND run_id = ?`,
          ).run(
            serializeWorkflowJson(receipts, 'steering_receipts_json'),
            serializeWorkflowJson(checkpointRefs, 'checkpoint_refs_json'),
            createdAt,
            parent.taskId,
            parent.revision,
            input.ownerRunId,
          )
      if (changed(parentUpdate) !== 1) throw new Error('checkpoint_parent_revision_conflict')

      if (input.role === 'suspension') {
        if (suspensionReason === 'human_takeover' && input.browserTaskId) {
          db.prepare(`
            UPDATE browser_target_claims
               SET suspension_checkpoint_id = ?, updated_at = ?
             WHERE parent_task_id = ? AND browser_task_id = ? AND owner_run_id = ?
               AND state = 'user_owned' AND suspension_reason = 'browser_target_user_owned'
          `).run(
            checkpointId,
            Date.parse(createdAt) || Date.now(),
            parent.taskId,
            input.browserTaskId,
            input.ownerRunId,
          )
        }
        suspendHeldBrowserTargetClaims(db, {
          ownerRunId: input.ownerRunId,
          checkpointId,
          cleanBaseCheckpointId: parent.checkpointRefs.cleanBaseCheckpointId,
          suspensionReason: suspensionReason || 'browser_run_checkpoint',
          createdAt,
        })
        const runUpdate = db.prepare(
          `UPDATE run_meta
              SET status = 'checkpoint', terminal_reason = ?,
                  continuation_ref_json = ?, updated_at = ?
            WHERE run_id = ? AND task_id = ? AND status = 'running'`,
        ).run(
          suspensionReason === 'human_takeover' ? 'human_takeover' : `checkpoint_${suspensionReason || 'manual'}`,
          serializeWorkflowJson(continuationRef, 'takeover_continuation_ref_json'),
          Date.parse(createdAt) || Date.now(),
          input.ownerRunId,
          parent.taskId,
        )
        if (changed(runUpdate) !== 1) throw new Error('checkpoint_takeover_run_meta_conflict')
        if (input.browserTaskId) {
          const childUpdate = db.prepare(
            `UPDATE browser_tasks
                SET status = 'paused', updated_at = ?
              WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow'`,
          ).run(createdAt, input.browserTaskId, parent.taskId)
          if (changed(childUpdate) !== 1) throw new Error('checkpoint_takeover_browser_child_mismatch')
        }
      }

      if (previousCheckpointId && previousCheckpointId !== checkpointId) {
        db.prepare(
          `DELETE FROM agent_session_checkpoints
            WHERE checkpoint_id = ? AND parent_task_id = ? AND role = ?`,
        ).run(previousCheckpointId, parent.taskId, checkpoint.role)
      }
      const readback = this.readCheckpointFromDb(db, checkpointId)
      if (!readback || readback.finalInputDigest !== checkpoint.finalInputDigest) {
        throw new Error('checkpoint_readback_failed')
      }
      const updatedParent = readParent(db, parent.taskId)
      const authoritativeId = checkpoint.role === 'clean_base'
        ? updatedParent.checkpointRefs.cleanBaseCheckpointId
        : updatedParent.checkpointRefs.suspensionCheckpointId
      if (authoritativeId !== checkpointId) throw new Error('checkpoint_parent_pointer_readback_failed')
      if (input.role !== 'suspension') return readback

      const notice = input.suspensionRequest
        ? browserConfirmationNotice(input.suspensionRequest)
        : suspensionReason === 'human_takeover'
          ? parent.humanTakeoverRef?.userPrompt
            ? browserHumanTakeoverBlockedReason(parent.humanTakeoverRef.userPrompt)
            || '页面需要你完成验证或手动操作。完成后可以从任务卡继续。'
            : '页面需要你完成验证或手动操作。完成后可以从任务卡继续。'
          : null
      if (!notice) return readback
      const canonicalMessage = buildCanonicalCoreCloseoutMessage({
        parentTaskId: parent.taskId,
        ownerRunId: input.ownerRunId,
        conversationId: parent.scopeId,
        finalText: notice,
        timestamp: createdAt,
        terminalReason: suspensionReason === 'human_takeover'
          ? 'human_takeover'
          : `checkpoint_${suspensionReason}`,
      })
      canonicalMessage.meta = {
        ...canonicalMessage.meta,
        checkpointId,
        ...(input.suspensionRequest ? { browserConfirmationRequest: input.suspensionRequest } : {}),
      }
      const canonicalMessageDigest = workflowDigest(canonicalMessage)
      db.prepare(
        `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
         VALUES (?, ?, 'assistant', ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        canonicalMessage.id,
        canonicalMessage.conversationId,
        canonicalMessage.content,
        canonicalMessage.timestamp,
        serializeWorkflowJson(canonicalMessage.meta, 'checkpoint_canonical_assistant_meta_json'),
      )
      const messageReadback = db.prepare(
        `SELECT id, conversation_id, role, content, timestamp, meta_json
           FROM chat_messages WHERE id = ? LIMIT 1`,
      ).get<Required<ChatMessageRow>>(canonicalMessage.id)
      if (!messageReadback || messageReadback.role !== 'assistant') {
        throw new Error('checkpoint_canonical_assistant_message_readback_failed')
      }
      const readbackCanonical = {
        id: messageReadback.id,
        conversationId: messageReadback.conversation_id,
        role: 'assistant' as const,
        content: messageReadback.content,
        timestamp: messageReadback.timestamp,
        meta: parseObjectStrict<Record<string, unknown>>(
          messageReadback.meta_json || '{}',
          'checkpoint_canonical_assistant_meta_json',
        ),
      }
      if (workflowDigest(readbackCanonical) !== canonicalMessageDigest) {
        throw new Error('checkpoint_canonical_assistant_message_digest_mismatch')
      }
      return {
        ...readback,
        canonicalMessage: readbackCanonical,
        canonicalMessageDigest,
      }
    })
  }

  current(parentTaskId: string, role: 'clean_base' | 'suspension'): AgentSessionCheckpoint | null {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const parent = readParent(db, parentTaskId)
    const checkpointId = role === 'clean_base'
      ? parent.checkpointRefs.cleanBaseCheckpointId
      : parent.checkpointRefs.suspensionCheckpointId
    if (!checkpointId) return null
    const checkpoint = this.readCheckpointFromDb(db, checkpointId)
    if (!checkpoint || checkpoint.parentTaskId !== parentTaskId || checkpoint.role !== role) {
      throw new Error('checkpoint_parent_pointer_invalid')
    }
    return checkpoint
  }

  read(checkpointId: string): AgentSessionCheckpoint | null {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    return this.readCheckpointFromDb(db, checkpointId)
  }

  /** Diagnostics only. Never use this timestamp ordering for recovery. */
  latestForDiagnostics(parentTaskId: string): AgentSessionCheckpoint | null {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const row = db.prepare(
      `SELECT * FROM agent_session_checkpoints
        WHERE parent_task_id = ? ORDER BY created_at DESC, checkpoint_id DESC LIMIT 1`,
    ).get<WorkflowCheckpointRow>(parentTaskId)
    return row ? mapWorkflowCheckpointRow(row) : null
  }

  readBrowserObservationGaps(parentTaskId: string): BrowserObservationGap[] {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const child = db.prepare(
      `SELECT id, payload_json FROM browser_tasks
        WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
    ).get<{ id: string; payload_json: string | null }>(parentTaskId)
    if (!child?.payload_json) return []
    const payload = parseObjectStrict<Record<string, unknown>>(
      child.payload_json,
      'browser_workflow_payload_json',
    )
    const evidence = readVerifiedBrowserWorkflowEvidence(child.id, payload)
    return evidence.unresolvedActions.map((entry) => ({
      browserTaskId: child.id,
      actionId: entry.actionId,
      actionSeq: entry.actionSeq,
      operationId: entry.outcome.operationId,
      outcome: structuredClone(entry.outcome) as unknown as Record<string, unknown>,
    }))
  }

  async deleteForParent(parentTaskId: string): Promise<void> {
    await this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, parentTaskId)
      const cleared: AgentCheckpointRefs = {
        cleanBaseCheckpointId: null,
        suspensionCheckpointId: null,
      }
      const update = db.prepare(
        `UPDATE task_projections
            SET checkpoint_refs_json = ?, revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND revision = ? AND run_id = ?`,
      ).run(
        serializeWorkflowJson(cleared, 'checkpoint_refs_json'),
        new Date().toISOString(),
        parent.taskId,
        parent.revision,
        parent.runId,
      )
      if (changed(update) !== 1) throw new Error('checkpoint_parent_revision_conflict')
      db.prepare('DELETE FROM agent_session_checkpoints WHERE parent_task_id = ?').run(parentTaskId)
    })
  }

  private readCheckpointFromDb(db: WorkflowRawDatabase, checkpointId: string): AgentSessionCheckpoint | null {
    const row = db.prepare(
      'SELECT * FROM agent_session_checkpoints WHERE checkpoint_id = ? LIMIT 1',
    ).get<WorkflowCheckpointRow>(checkpointId)
    return row ? mapWorkflowCheckpointRow(row) : null
  }
}
