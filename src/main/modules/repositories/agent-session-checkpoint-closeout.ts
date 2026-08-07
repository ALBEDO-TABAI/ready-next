import { randomUUID } from 'node:crypto'
import type { TaskExecutionBinding } from '../../../shared/agent-execution-profile'
import { assertDeliveryState, type DeliveryStateV1 } from '../../../shared/dynamic-delivery'
import type {
  CanonicalAssistantMessage,
} from '../../../shared/ipc-contracts/canonical-message'
import { buildCanonicalCoreCloseoutMessage } from './canonical-core-closeout-message'
import {
  parseArrayStrict,
  parseObjectStrict,
  serializeWorkflowJson,
  workflowDigest,
} from './browser-workflow-codec'
import type { DurableWriteResult } from './browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork, type WorkflowRawDatabase } from './browser-workflow-unit-of-work'
import { readWorkflowParent } from './browser-workflow-row-mapping'
import type {
  CanonicalCoreCloseoutInput,
  CanonicalCoreCloseoutResult,
} from './agent-session-checkpoint-types'
import { inspectWorkflowCloseoutFromDb } from './agent-session-checkpoint-route'

interface ChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json?: string | null
}

export interface CanonicalCoreCloseoutTransactionParticipant {
  complete(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): void
}

const readParent = readWorkflowParent

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

function releaseHeldBrowserTargetClaims(
  db: WorkflowRawDatabase,
  ownerRunId: string,
  nowMs: number,
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
  }>(ownerRunId)
  const createdAt = new Date(nowMs).toISOString()
  for (const claim of claims) {
    const nextClaimId = `claim-${randomUUID()}`
    const nextGeneration = claim.generation + 1
    const updated = db.prepare(`
      UPDATE browser_target_claims
         SET state = 'released', physical_target_token = NULL, boot_incarnation_id = NULL,
             claim_id = ?, generation = ?, suspension_checkpoint_id = NULL,
             suspension_reason = NULL, heartbeat_at = ?, expires_at = ?, updated_at = ?
       WHERE partition = ? AND tab_id = ? AND owner_run_id = ? AND state = 'held'
         AND claim_id = ? AND generation = ?
    `).run(
      nextClaimId,
      nextGeneration,
      nowMs,
      nowMs,
      nowMs,
      claim.partition,
      claim.tab_id,
      ownerRunId,
      claim.claim_id,
      claim.generation,
    )
    if (changed(updated) !== 1) throw new Error('core_closeout_target_claim_cas_conflict')
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 'claim_released', NULL, 0, ?)
    `).run(
      `browser-control-${randomUUID()}`,
      sequence,
      claim.parent_task_id,
      claim.browser_task_id,
      ownerRunId,
      claim.partition,
      claim.tab_id,
      claim.physical_target_token,
      claim.boot_incarnation_id,
      claim.claim_id,
      claim.generation,
      nextClaimId,
      nextGeneration,
      `claim-released:${claim.claim_id}:${claim.generation}`,
      createdAt,
    )
  }
}

export class AgentSessionCheckpointCloseoutRepository {
  constructor(
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
    private readonly transactionParticipant?: CanonicalCoreCloseoutTransactionParticipant,
  ) {}

  async commitCanonicalCoreCloseout(
    input: CanonicalCoreCloseoutInput,
  ): Promise<DurableWriteResult<CanonicalCoreCloseoutResult>> {
    return this.unitOfWork.commitCoreCloseout({
      writeCore: (db) => {
        const parent = readParent(db, input.parentTaskId)
        if (parent.runId !== input.ownerRunId) throw new Error('core_closeout_owner_mismatch')
        if (parent.scopeId !== input.conversationId) {
          throw new Error('core_closeout_conversation_mismatch')
        }
        const runMetaStatus = input.status === 'done'
          ? 'done'
          : input.status === 'interrupted'
            ? 'interrupted'
            : input.status
        const messageTemplate = buildCanonicalCoreCloseoutMessage({
          parentTaskId: parent.taskId,
          ownerRunId: input.ownerRunId,
          conversationId: input.conversationId,
          finalText: input.finalText,
          timestamp: input.now || '',
          terminalReason: input.terminalReason,
          completionVerifierReceipt: input.completionVerifierReceipt,
        })
        const messageId = messageTemplate.id
        const parentWinner = db.prepare(
          `SELECT status, execution_binding_json, delivery_state_json,
                  task_type, module, budget_json, budget_usage_percent,
                  budget_warning_level, continuation_ref_json, recent_artifacts_json
             FROM task_projections
            WHERE task_id = ? AND revision = ? AND run_id = ? LIMIT 1`,
        ).get<{
          status: string
          execution_binding_json: string | null
          delivery_state_json: string | null
          task_type: string
          module: string
          budget_json: string | null
          budget_usage_percent: number | null
          budget_warning_level: string | null
          continuation_ref_json: string | null
          recent_artifacts_json: string | null
        }>(
          parent.taskId,
          parent.revision,
          input.ownerRunId,
        )
        const parentAlreadyTerminal = parentWinner
          && ['completed', 'failed', 'killed'].includes(parentWinner.status)
        if (parentAlreadyTerminal) {
          const existingRun = db.prepare(
            `SELECT status, terminal_reason, task_type, budget_json, continuation_ref_json
               FROM run_meta
              WHERE run_id = ? AND task_id = ? AND scope_id = ? LIMIT 1`,
          ).get<{
            status: string
            terminal_reason: string | null
            task_type: string | null
            budget_json: string | null
            continuation_ref_json: string | null
          }>(
            input.ownerRunId,
            parent.taskId,
            parent.scopeId,
          )
          const existingMessage = db.prepare(
            `SELECT id, conversation_id, role, content, timestamp, meta_json
               FROM chat_messages WHERE id = ? LIMIT 1`,
          ).get<ChatMessageRow>(messageId)
          const canonicalMessage: CanonicalAssistantMessage | null = existingMessage
            ? {
                id: existingMessage.id,
                conversationId: existingMessage.conversation_id,
                role: 'assistant',
                content: existingMessage.content,
                timestamp: existingMessage.timestamp,
                meta: parseObjectStrict<Record<string, unknown>>(
                  existingMessage.meta_json || '{}',
                  'canonical_assistant_meta_json',
                ),
              }
            : null
          const expectedCanonicalMessage = existingMessage
            ? buildCanonicalCoreCloseoutMessage({
                parentTaskId: parent.taskId,
                ownerRunId: input.ownerRunId,
                conversationId: input.conversationId,
                finalText: input.finalText,
                timestamp: existingMessage.timestamp,
                terminalReason: input.terminalReason,
                recentArtifacts: parseArrayStrict<unknown>(
                  parentWinner.recent_artifacts_json || '[]',
                  'core_closeout_recent_artifacts_json',
                ),
                completionVerifierReceipt: input.completionVerifierReceipt,
              })
            : null
          if (
            existingRun?.status !== runMetaStatus
            || existingRun.terminal_reason !== input.terminalReason
            || existingRun.continuation_ref_json !== null
            || parentWinner.continuation_ref_json !== null
            || (input.taskType && existingRun.task_type !== input.taskType)
            || (input.taskType && parentWinner.task_type !== input.taskType)
            || (input.module && parentWinner.module !== input.module)
            || (
              input.budget
              && (
                !existingRun.budget_json
                || !parentWinner.budget_json
                || workflowDigest(parseObjectStrict(existingRun.budget_json, 'core_closeout_run_budget_json'))
                  !== workflowDigest(input.budget)
                || workflowDigest(parseObjectStrict(parentWinner.budget_json, 'core_closeout_parent_budget_json'))
                  !== workflowDigest(input.budget)
              )
            )
            || (
              typeof input.budgetUsagePercent === 'number'
              && parentWinner.budget_usage_percent !== input.budgetUsagePercent
            )
            || (
              input.budgetWarningLevel
              && parentWinner.budget_warning_level !== input.budgetWarningLevel
            )
            || !canonicalMessage
            || canonicalMessage.conversationId !== expectedCanonicalMessage?.conversationId
            || canonicalMessage.content !== expectedCanonicalMessage?.content
            || workflowDigest(canonicalMessage.meta) !== workflowDigest(expectedCanonicalMessage?.meta)
            || (
              input.deliveryState
              && workflowDigest(parseObjectStrict<DeliveryStateV1>(
                parentWinner.delivery_state_json || '{}',
                'core_closeout_delivery_state_json',
              )) !== workflowDigest(input.deliveryState)
            )
          ) {
            throw new Error('core_closeout_terminal_retry_conflict')
          }
          const browserTaskId = db.prepare(
            `SELECT id FROM browser_tasks
              WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
          ).get<{ id: string }>(parent.taskId)?.id ?? null
          releaseHeldBrowserTargetClaims(db, input.ownerRunId, Date.now())
          this.transactionParticipant?.complete({
            readyRunId: input.ownerRunId,
            productTerminalDigest: workflowDigest(canonicalMessage),
            closeoutAt: canonicalMessage.timestamp,
          })
          return {
            parent,
            browserTaskId,
            canonicalMessage,
            canonicalMessageDigest: workflowDigest(canonicalMessage),
          }
        }
        if (!parentWinner) {
          throw new Error('core_closeout_parent_not_active')
        }
        if (!parentWinner.execution_binding_json) {
          throw new Error('core_closeout_parent_binding_missing')
        }
        const parentBinding = parseObjectStrict<TaskExecutionBinding>(
          parentWinner.execution_binding_json,
          'core_closeout_parent_execution_binding_json',
        )
        if (parentBinding.runId !== input.ownerRunId) {
          throw new Error('core_closeout_parent_binding_owner_mismatch')
        }
        const runWinner = db.prepare(
          `SELECT status, execution_binding_json
             FROM run_meta
            WHERE run_id = ? AND task_id = ? AND scope_id = ? LIMIT 1`,
        ).get<{ status: string; execution_binding_json: string | null }>(
          input.ownerRunId,
          parent.taskId,
          parent.scopeId,
        )
        if (runWinner?.status !== 'running') throw new Error('core_closeout_run_not_running')
        if (
          !runWinner.execution_binding_json
          || workflowDigest(parseObjectStrict<TaskExecutionBinding>(
            runWinner.execution_binding_json,
            'core_closeout_run_execution_binding_json',
          )) !== workflowDigest(parentBinding)
        ) {
          throw new Error('core_closeout_run_binding_mismatch')
        }
        if (parent.steeringReceipts.some((receipt) => !receipt.contentCheckpointId)) {
          throw new Error('core_closeout_pending_steering')
        }
        if (input.deliveryState) assertDeliveryState(input.deliveryState)
        const browserTaskId = db.prepare(
          `SELECT id FROM browser_tasks
            WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
        ).get<{ id: string }>(parent.taskId)?.id ?? null
        const closeoutInspection = input.status === 'done' && browserTaskId
          ? inspectWorkflowCloseoutFromDb(db, parent.taskId)
          : null
        if (closeoutInspection && closeoutInspection.state !== 'sealable') {
          throw new Error(`core_closeout_browser_${closeoutInspection.state}`)
        }
        const currentWorkflowSeal = closeoutInspection?.state === 'sealable'
          ? closeoutInspection.seal
          : null
        if (input.browserTaskId && input.browserTaskId !== browserTaskId) {
          throw new Error('core_closeout_browser_child_mismatch')
        }
        let childWinner: {
          revision: number
          status: string
          active_execution_binding_json: string
        } | null = null
        if (browserTaskId) {
          const row = db.prepare(
            `SELECT revision, status, active_execution_binding_json
               FROM browser_tasks
              WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
          ).get<{
            revision: number | null
            status: string
            active_execution_binding_json: string | null
          }>(browserTaskId, parent.taskId)
          if (
            !row
            || !row.active_execution_binding_json
            || ['completed', 'failed', 'cancelled'].includes(row.status)
          ) {
            throw new Error('core_closeout_browser_child_not_active')
          }
          const childBinding = parseObjectStrict<TaskExecutionBinding>(
            row.active_execution_binding_json,
            'core_closeout_browser_execution_binding_json',
          )
          if (workflowDigest(childBinding) !== workflowDigest(parentBinding)) {
            throw new Error('core_closeout_browser_child_binding_mismatch')
          }
          childWinner = {
            revision: Math.max(0, Math.floor(Number(row.revision || 0))),
            status: row.status,
            active_execution_binding_json: row.active_execution_binding_json,
          }
          if (
            input.status === 'done'
            && childWinner.revision !== currentWorkflowSeal?.childRevision
          ) {
            throw new Error('core_closeout_browser_child_revision_mismatch')
          }
        }
        if (currentWorkflowSeal) {
          if (input.status === 'done' && !input.workflowCloseoutSeal) {
            throw new Error('core_closeout_workflow_seal_missing')
          }
          if (
            input.workflowCloseoutSeal
            && workflowDigest(input.workflowCloseoutSeal) !== workflowDigest(currentWorkflowSeal)
          ) {
            throw new Error('core_closeout_workflow_seal_mismatch')
          }
        } else if (input.workflowCloseoutSeal) {
          throw new Error('core_closeout_workflow_seal_mismatch')
        }
        if (input.completionVerifierReceipt && !currentWorkflowSeal) {
          throw new Error('core_closeout_verifier_receipt_requires_browser_workflow')
        }
        if (currentWorkflowSeal && input.status === 'done') {
          const receipt = input.completionVerifierReceipt
          if (!input.terminalQualityPatch) throw new Error('core_closeout_terminal_quality_patch_missing')
          if (!receipt || receipt.verdict !== 'accept' || receipt.version !== 1) {
            throw new Error('core_closeout_verifier_accept_receipt_missing')
          }
          if (receipt.parentTaskId !== parent.taskId || receipt.ownerRunId !== input.ownerRunId) {
            throw new Error('core_closeout_verifier_receipt_owner_mismatch')
          }
          if (receipt.candidateDigest !== workflowDigest(input.finalText)) {
            throw new Error('core_closeout_verifier_candidate_mismatch')
          }
          if (receipt.workflowCloseoutSealDigest !== workflowDigest(currentWorkflowSeal)) {
            throw new Error('core_closeout_verifier_seal_mismatch')
          }
          if (receipt.terminalQualityPatchDigest !== workflowDigest(input.terminalQualityPatch)) {
            throw new Error('core_closeout_verifier_quality_patch_mismatch')
          }
          if (!receipt.sealedCandidateDigest || !receipt.verifiedAt) {
            throw new Error('core_closeout_verifier_receipt_invalid')
          }
        } else if (input.completionVerifierReceipt) {
          throw new Error('core_closeout_verifier_receipt_not_allowed')
        }
        const now = input.now || new Date().toISOString()
        const existingMessage = db.prepare(
          `SELECT id, conversation_id, role, content, timestamp, meta_json
             FROM chat_messages WHERE id = ? LIMIT 1`,
        ).get<ChatMessageRow>(messageId)
        const expectedCanonicalMessage = buildCanonicalCoreCloseoutMessage({
          parentTaskId: parent.taskId,
          ownerRunId: input.ownerRunId,
          conversationId: input.conversationId,
          finalText: input.finalText,
          timestamp: existingMessage?.timestamp || now,
          terminalReason: input.terminalReason,
          recentArtifacts: parseArrayStrict<unknown>(
            parentWinner.recent_artifacts_json || '[]',
            'core_closeout_recent_artifacts_json',
          ),
          completionVerifierReceipt: input.completionVerifierReceipt,
        })
        const canonicalMessage: CanonicalAssistantMessage = existingMessage
          ? {
              id: existingMessage.id,
              conversationId: existingMessage.conversation_id,
              role: 'assistant',
              content: existingMessage.content,
              timestamp: existingMessage.timestamp,
              meta: parseObjectStrict<Record<string, unknown>>(
                existingMessage.meta_json || '{}',
                'canonical_assistant_meta_json',
              ),
            }
          : expectedCanonicalMessage
        if (
          canonicalMessage.conversationId !== expectedCanonicalMessage.conversationId
          || canonicalMessage.role !== 'assistant'
          || canonicalMessage.content !== expectedCanonicalMessage.content
          || workflowDigest(canonicalMessage.meta) !== workflowDigest(expectedCanonicalMessage.meta)
        ) {
          throw new Error('canonical_assistant_message_conflict')
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
          serializeWorkflowJson(canonicalMessage.meta, 'canonical_assistant_meta_json'),
        )
        const messageReadback = db.prepare(
          `SELECT id, conversation_id, role, content, timestamp, meta_json
             FROM chat_messages WHERE id = ? LIMIT 1`,
        ).get<ChatMessageRow>(canonicalMessage.id)
        if (!messageReadback || messageReadback.role !== 'assistant') {
          throw new Error('canonical_assistant_message_readback_failed')
        }
        const readbackCanonical: CanonicalAssistantMessage = {
          id: messageReadback.id,
          conversationId: messageReadback.conversation_id,
          role: 'assistant',
          content: messageReadback.content,
          timestamp: messageReadback.timestamp,
          meta: parseObjectStrict<Record<string, unknown>>(
            messageReadback.meta_json || '{}',
            'canonical_assistant_meta_json',
          ),
        }
        if (workflowDigest(readbackCanonical) !== canonicalMessageDigest) {
          throw new Error('canonical_assistant_message_digest_mismatch')
        }

        const nowMs = Date.parse(now)
        const persistedNowMs = Number.isFinite(nowMs) ? nowMs : Date.now()
        const runUpdate = db.prepare(
          `UPDATE run_meta
              SET status = ?, initiator = ?, duration_ms = ?,
                  task_type = COALESCE(?, task_type), terminal_reason = ?,
                  provider_diagnostics_json = COALESCE(?, provider_diagnostics_json),
                  budget_json = COALESCE(?, budget_json), continuation_ref_json = NULL,
                  input_tokens = ?, output_tokens = ?, total_tokens = ?,
                  last_message_text = ?, updated_at = ?
            WHERE run_id = ? AND task_id = ? AND scope_id = ?
              AND status = 'running' AND execution_binding_json = ?`,
        ).run(
          runMetaStatus,
          input.initiator,
          Math.max(0, Math.floor(input.durationMs)),
          input.taskType || null,
          input.terminalReason,
          input.providerDiagnostics
            ? serializeWorkflowJson(input.providerDiagnostics, 'run_meta_provider_diagnostics_json')
            : null,
          input.budget ? serializeWorkflowJson(input.budget, 'run_meta_budget_json') : null,
          Math.max(0, Math.floor(input.usage?.inputTokens || 0)),
          Math.max(0, Math.floor(input.usage?.outputTokens || 0)),
          Math.max(0, Math.floor(input.usage?.totalTokens || 0)),
          input.finalText,
          persistedNowMs,
          input.ownerRunId,
          parent.taskId,
          parent.scopeId,
          runWinner.execution_binding_json,
        )
        if (changed(runUpdate) !== 1) throw new Error('core_closeout_run_winner_conflict')

        const projectionStatus = input.status === 'done'
          ? 'completed'
          : input.status === 'error'
            ? 'failed'
            : 'killed'
        // A terminal owner must never remain logically interactive.  Keeping a
        // completed/failed/killed Parent in `running` lets generic ingress
        // mistake it for a steering target after the canonical closeout has
        // already committed.
        const interactionState = 'suspended'
        const resumableActions = ['none']
        const parentUpdate = input.terminalQualityPatch
          ? db.prepare(
              `UPDATE task_projections
                  SET status = ?, interaction_state = ?, waiting_for = 'none',
                      blocked_reason = ?, resumable_actions_json = ?,
                      task_type = COALESCE(?, task_type), module = COALESCE(?, module),
                      budget_json = COALESCE(?, budget_json),
                      budget_usage_percent = COALESCE(?, budget_usage_percent),
                      budget_warning_level = COALESCE(?, budget_warning_level),
                      continuation_ref_json = NULL,
                      delivery_state_json = COALESCE(?, delivery_state_json),
                      proof_refs_json = ?,
                      checkins_json = ?, criteria_json = ?,
                      learning_refs_json = COALESCE(?, learning_refs_json),
                      checkpoint_refs_json = '{"cleanBaseCheckpointId":null,"suspensionCheckpointId":null}',
                      revision = revision + 1, updated_at = ?
                WHERE task_id = ? AND revision = ? AND run_id = ?
                  AND status = ? AND execution_binding_json = ?`,
            ).run(
              projectionStatus,
              interactionState,
              null,
              serializeWorkflowJson(resumableActions, 'terminal_resumable_actions_json'),
              input.taskType || null,
              input.module || null,
              input.budget ? serializeWorkflowJson(input.budget, 'terminal_budget_json') : null,
              input.budgetUsagePercent ?? null,
              input.budgetWarningLevel || null,
              input.deliveryState
                ? serializeWorkflowJson(input.deliveryState, 'terminal_delivery_state_json')
                : null,
              serializeWorkflowJson(input.terminalQualityPatch.proofRefs, 'terminal_proof_refs_json'),
              serializeWorkflowJson(input.terminalQualityPatch.checkins, 'terminal_checkins_json'),
              serializeWorkflowJson(input.terminalQualityPatch.criteria, 'terminal_criteria_json'),
              input.terminalQualityPatch.learningRefs
                ? serializeWorkflowJson(input.terminalQualityPatch.learningRefs, 'terminal_learning_refs_json')
                : null,
              now,
              parent.taskId,
              parent.revision,
              input.ownerRunId,
              parentWinner.status,
              parentWinner.execution_binding_json,
            )
          : db.prepare(
              `UPDATE task_projections
                  SET status = ?, interaction_state = ?, waiting_for = 'none',
                      blocked_reason = ?, resumable_actions_json = ?,
                      task_type = COALESCE(?, task_type), module = COALESCE(?, module),
                      budget_json = COALESCE(?, budget_json),
                      budget_usage_percent = COALESCE(?, budget_usage_percent),
                      budget_warning_level = COALESCE(?, budget_warning_level),
                      continuation_ref_json = NULL,
                      delivery_state_json = COALESCE(?, delivery_state_json),
                      checkpoint_refs_json = '{"cleanBaseCheckpointId":null,"suspensionCheckpointId":null}',
                      revision = revision + 1, updated_at = ?
                WHERE task_id = ? AND revision = ? AND run_id = ?
                  AND status = ? AND execution_binding_json = ?`,
            ).run(
              projectionStatus,
              interactionState,
              null,
              serializeWorkflowJson(resumableActions, 'terminal_resumable_actions_json'),
              input.taskType || null,
              input.module || null,
              input.budget ? serializeWorkflowJson(input.budget, 'terminal_budget_json') : null,
              input.budgetUsagePercent ?? null,
              input.budgetWarningLevel || null,
              input.deliveryState
                ? serializeWorkflowJson(input.deliveryState, 'terminal_delivery_state_json')
                : null,
              now,
              parent.taskId,
              parent.revision,
              input.ownerRunId,
              parentWinner.status,
              parentWinner.execution_binding_json,
            )
        if (changed(parentUpdate) !== 1) throw new Error('core_closeout_parent_revision_conflict')

        if (browserTaskId) {
          const browserStatus = input.status === 'done'
            ? 'completed'
            : input.status === 'error'
              ? 'failed'
              : 'cancelled'
          const childUpdate = db.prepare(
            `UPDATE browser_tasks
                SET status = ?, result_json = ?, error = ?, finished_at = ?,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow'
                AND revision = ? AND status = ? AND active_execution_binding_json = ?`,
          ).run(
            browserStatus,
            serializeWorkflowJson({
              terminalReason: input.terminalReason,
              canonicalMessageId: canonicalMessage.id,
              canonicalMessageDigest,
              ...(input.completionVerifierReceipt
                ? { completionVerifierReceipt: input.completionVerifierReceipt }
                : {}),
            }, 'browser_workflow_terminal_result_json'),
            input.status === 'error' ? input.terminalReason : null,
            now,
            now,
            browserTaskId,
            parent.taskId,
            childWinner!.revision,
            childWinner!.status,
            childWinner!.active_execution_binding_json,
          )
          if (changed(childUpdate) !== 1) throw new Error('core_closeout_browser_child_mismatch')
        }

        releaseHeldBrowserTargetClaims(db, input.ownerRunId, persistedNowMs)

        db.prepare(
          'DELETE FROM agent_session_checkpoints WHERE parent_task_id = ?',
        ).run(parent.taskId)

        const runReadback = db.prepare(
          `SELECT status, terminal_reason, continuation_ref_json
             FROM run_meta WHERE run_id = ? AND task_id = ? LIMIT 1`,
        ).get<{
          status: string
          terminal_reason: string | null
          continuation_ref_json: string | null
        }>(input.ownerRunId, parent.taskId)
        if (
          !runReadback
          || runReadback.status !== runMetaStatus
          || runReadback.terminal_reason !== input.terminalReason
          || runReadback.continuation_ref_json !== null
        ) {
          throw new Error('core_closeout_run_meta_readback_failed')
        }
        this.transactionParticipant?.complete({
          readyRunId: input.ownerRunId,
          productTerminalDigest: canonicalMessageDigest,
          closeoutAt: readbackCanonical.timestamp,
        })
        return {
          parent: readParent(db, parent.taskId),
          browserTaskId,
          canonicalMessage: readbackCanonical,
          canonicalMessageDigest,
        }
      },
      repairDerived: input.repairDerivedState,
    })
  }
}
