import { randomUUID } from 'node:crypto'
import type {
  BrowserHumanTakeoverPhysicalTarget,
  BrowserWorkflowCloseoutSeal,
  DurableRequestAnchor,
} from '../../../shared/browser-workflow-control'
import type { TaskExecutionBinding } from '../../../shared/agent-execution-profile'
import {
  parseObjectStrict,
  serializeWorkflowJson,
  workflowDigest,
} from './browser-workflow-codec'
import type {
  WorkflowDatabaseAccessor,
  WorkflowRawDatabase,
} from './browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork } from './browser-workflow-unit-of-work'
import { readWorkflowParent } from './browser-workflow-row-mapping'
import type {
  BindBrowserWorkflowRouteInput,
  BrowserWorkflowCloseoutInspection,
  BrowserWorkflowRouteBinding,
  BrowserWorkflowVerifierBundle,
  BrowserWorkflowVerifierInspection,
} from './agent-session-checkpoint-types'
import { readVerifiedBrowserWorkflowEvidence } from '../browser-engine/browser-workflow-evidence'

interface ChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json?: string | null
}

const readParent = readWorkflowParent

export function inspectWorkflowCloseoutFromDb(
  db: WorkflowRawDatabase,
  parentTaskId: string,
): BrowserWorkflowCloseoutInspection {
  const parent = readParent(db, parentTaskId)
  const child = db.prepare(
    `SELECT id, revision, status, payload_json, checkpoint_json, result_json,
            progress_total, progress_completed, progress_failed, current_label, error
       FROM browser_tasks
      WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
  ).get<{
    id: string
    revision: number | null
    status: string
    payload_json: string | null
    checkpoint_json: string | null
    result_json: string | null
    progress_total: number | null
    progress_completed: number | null
    progress_failed: number | null
    current_label: string | null
    error: string | null
  }>(parentTaskId)
  if (!child) {
    return {
      state: 'absent',
      browserTaskId: null,
      childRevision: null,
      evidence: null,
      seal: null,
    }
  }
  const payload = child.payload_json
    ? parseObjectStrict<Record<string, unknown>>(child.payload_json, 'closeout_browser_payload_json')
    : {}
  const verifiedEvidence = readVerifiedBrowserWorkflowEvidence(child.id, payload)
  const childRevision = Math.max(0, Math.floor(Number(child.revision || 0)))
  const blocked = (state: Exclude<BrowserWorkflowCloseoutInspection['state'], 'absent' | 'sealable'>) => ({
    state,
    browserTaskId: child.id,
    childRevision,
    evidence: verifiedEvidence,
    seal: null,
  } as BrowserWorkflowCloseoutInspection)
  if (verifiedEvidence.journal.activeAction) return blocked('action_in_flight')
  if (verifiedEvidence.unresolvedActions.length > 0) {
    return blocked('observation_required')
  }
  if (verifiedEvidence.researchState === 'incomplete') {
    return blocked('research_incomplete')
  }
  if (!parent.requestAnchor?.snapshotDigest) throw new Error('core_closeout_request_anchor_missing')
  const seal: BrowserWorkflowCloseoutSeal = {
    parentRevision: parent.revision,
    requestAnchorSnapshotDigest: parent.requestAnchor.snapshotDigest,
    browserTaskId: child.id,
    childRevision,
    childPayloadDigest: workflowDigest(payload),
    childEvidenceDigest: workflowDigest({
      verifiedEvidence,
      status: child.status,
      checkpointJson: child.checkpoint_json,
      resultJson: child.result_json,
      progressTotal: child.progress_total,
      progressCompleted: child.progress_completed,
      progressFailed: child.progress_failed,
      currentLabel: child.current_label,
      error: child.error,
    }),
  }
  return {
    state: 'sealable',
    browserTaskId: child.id,
    childRevision,
    evidence: verifiedEvidence,
    seal,
  }
}

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export class AgentSessionCheckpointRouteRepository {
  constructor(
    private readonly accessor: WorkflowDatabaseAccessor,
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
  ) {}

  inspectWorkflowCloseout(parentTaskId: string): BrowserWorkflowCloseoutInspection {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    return inspectWorkflowCloseoutFromDb(db, parentTaskId)
  }

  isBrowserWorkflowBound(parentTaskId: string, ownerRunId: string): boolean {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const parent = readParent(db, parentTaskId)
    if (parent.runId !== ownerRunId || !parent.requestAnchor?.snapshotDigest) return false
    const child = db.prepare(
      `SELECT id FROM browser_tasks
        WHERE parent_task_id = ? AND kind = 'browser_workflow'
          AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`,
    ).get<{ id: string }>(parentTaskId)
    return Boolean(child?.id)
  }

  readWorkflowVerifierBundle(parentTaskId: string): BrowserWorkflowVerifierInspection {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    const inspection = inspectWorkflowCloseoutFromDb(db, parentTaskId)
    if (inspection.state !== 'sealable') return { inspection, bundle: null }
    const parent = readParent(db, parentTaskId)
    const anchor = parent.requestAnchor
    if (!anchor) throw new Error('browser_verifier_request_anchor_missing')
    const source = db.prepare(
      `SELECT id, conversation_id, role, content, timestamp
         FROM chat_messages WHERE id = ? LIMIT 1`,
    ).get<ChatMessageRow>(anchor.messageId)
    if (!source || source.role !== 'user' || source.conversation_id !== parent.scopeId) {
      throw new Error('browser_verifier_source_message_missing')
    }
    const sourceDigest = workflowDigest({
      id: source.id,
      conversationId: source.conversation_id,
      role: source.role,
      content: source.content,
      timestamp: source.timestamp,
    })
    if (sourceDigest !== anchor.messageDigest) throw new Error('browser_verifier_source_message_drift')
    const steering = parent.steeringReceipts
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((receipt) => {
        if (!receipt.contentCheckpointId) throw new Error('browser_verifier_pending_steering')
        const row = db.prepare(
          `SELECT id, conversation_id, role, content, timestamp
             FROM chat_messages WHERE id = ? LIMIT 1`,
        ).get<ChatMessageRow>(receipt.messageId)
        if (!row || row.role !== 'user' || row.conversation_id !== parent.scopeId) {
          throw new Error('browser_verifier_steering_message_missing')
        }
        const digest = workflowDigest({
          id: row.id,
          conversationId: row.conversation_id,
          role: row.role,
          content: row.content,
          timestamp: row.timestamp,
        })
        if (digest !== receipt.messageDigest) throw new Error('browser_verifier_steering_message_drift')
        return { sequence: receipt.sequence, messageId: row.id, content: row.content, digest }
      })
    const child = db.prepare(
      `SELECT id, revision, status, payload_json, checkpoint_json, result_json,
              progress_total, progress_completed, progress_failed, current_label, error
         FROM browser_tasks
        WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1`,
    ).get<Record<string, unknown>>(parentTaskId)
    if (!child || typeof child.id !== 'string') throw new Error('browser_verifier_child_missing')
    const requestText = [
      anchor.canonicalMessageSnapshot.content,
      ...steering.map((item) => `[用户补充 ${item.sequence}]\n${item.content}`),
    ].join('\n\n')
    const bundle: BrowserWorkflowVerifierBundle = {
      requestText,
      requestDigest: workflowDigest({ anchor, steering }),
      browserTaskId: child.id,
      seal: inspection.seal,
      evidence: inspection.evidence,
    }
    return { inspection, bundle }
  }

  async bindBrowserWorkflowRoute(
    input: BindBrowserWorkflowRouteInput,
  ): Promise<BrowserWorkflowRouteBinding> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const parent = readParent(db, input.parentTaskId)
      if (parent.runId !== input.ownerRunId) throw new Error('browser_route_owner_mismatch')
      if (input.executionBinding.runId !== input.ownerRunId) {
        throw new Error('browser_route_execution_binding_run_mismatch')
      }
      const parentBindingRow = db.prepare(
        'SELECT execution_binding_json FROM task_projections WHERE task_id = ? LIMIT 1',
      ).get<{ execution_binding_json: string | null }>(input.parentTaskId)
      if (parentBindingRow?.execution_binding_json) {
        const parentBinding = parseObjectStrict<TaskExecutionBinding>(
          parentBindingRow.execution_binding_json,
          'parent_execution_binding_json',
        )
        if (workflowDigest(parentBinding) !== workflowDigest(input.executionBinding)) {
          throw new Error('browser_route_execution_binding_mismatch')
        }
      }

      let requestAnchor = parent.requestAnchor
      if (!requestAnchor) {
        const sourceMessageId = String(input.sourceMessageId || '').trim()
        if (!sourceMessageId) throw new Error('browser_route_source_message_required')
        const source = db.prepare(
          `SELECT id, conversation_id, role, content, timestamp
             FROM chat_messages WHERE id = ? LIMIT 1`,
        ).get<ChatMessageRow>(sourceMessageId)
        if (!source || source.role !== 'user' || source.conversation_id !== parent.scopeId) {
          throw new Error('browser_route_canonical_source_message_missing')
        }
        const canonicalMessageSnapshot: DurableRequestAnchor['canonicalMessageSnapshot'] = {
          role: 'user',
          content: source.content,
          timestamp: source.timestamp,
        }
        const messageDigest = workflowDigest({
          id: source.id,
          conversationId: source.conversation_id,
          ...canonicalMessageSnapshot,
        })
        const resourceAnchors = [...(input.resourceAnchors || [])]
          .sort((left, right) => left.resourceId.localeCompare(right.resourceId))
        const createdAt = input.now || new Date().toISOString()
        const snapshotDigest = workflowDigest({
          messageId: source.id,
          messageDigest,
          canonicalMessageSnapshot,
          resourceAnchors,
        })
        requestAnchor = {
          messageId: source.id,
          messageDigest,
          canonicalMessageSnapshot,
          resourceAnchors,
          snapshotDigest,
          createdAt,
        }
      }

      const existingChild = db.prepare(
        `SELECT id, active_execution_binding_json
           FROM browser_tasks
          WHERE parent_task_id = ? AND kind = 'browser_workflow'
          LIMIT 1`,
      ).get<{ id: string; active_execution_binding_json: string | null }>(parent.taskId)
      const now = input.now || new Date().toISOString()
      let browserTaskId = existingChild?.id || `browser-task-${randomUUID()}`
      let dependencyChanged = false
      if (!existingChild) {
        const payload = {
          parentTaskId: parent.taskId,
          ownerRunId: input.ownerRunId,
          scopeId: parent.scopeId,
          executionBinding: input.executionBinding,
          requestAnchorSnapshotDigest: requestAnchor.snapshotDigest,
          browserWorkflowActionJournal: {
            nextActionSeq: 1,
            nextObservationSeq: 1,
            activeAction: null,
            settledOutcomes: [],
            observationReceipts: [],
          },
          browserWorkflowObservationResources: [],
        }
        db.prepare(
          `INSERT INTO browser_tasks (
             id, kind, status, payload_json, checkpoint_json, result_json,
             progress_total, progress_completed, progress_failed, current_label, error,
             created_at, started_at, updated_at, finished_at, revision,
             created_by_run_id, active_execution_binding_json, parent_task_id,
             projection_revision, projection_sync_json
           ) VALUES (?, 'browser_workflow', 'running', ?, NULL, NULL,
                     0, 0, 0, NULL, NULL, ?, ?, ?, NULL, 0, ?, ?, ?, 0, NULL)`,
        ).run(
          browserTaskId,
          serializeWorkflowJson(payload, 'browser_workflow_payload'),
          now,
          now,
          now,
          input.ownerRunId,
          serializeWorkflowJson(input.executionBinding, 'browser_workflow_execution_binding'),
          parent.taskId,
        )
        dependencyChanged = true
      } else {
        const existingBinding = existingChild.active_execution_binding_json
          ? parseObjectStrict<TaskExecutionBinding>(
              existingChild.active_execution_binding_json,
              'browser_workflow_execution_binding_json',
            )
          : null
        if (!existingBinding || workflowDigest(existingBinding) !== workflowDigest(input.executionBinding)) {
          const updated = db.prepare(
            `UPDATE browser_tasks
                SET active_execution_binding_json = ?, created_by_run_id = ?,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND parent_task_id = ? AND kind = 'browser_workflow'`,
          ).run(
            serializeWorkflowJson(input.executionBinding, 'browser_workflow_execution_binding'),
            input.ownerRunId,
            now,
            existingChild.id,
            parent.taskId,
          )
          if (changed(updated) !== 1) throw new Error('browser_route_child_binding_conflict')
          dependencyChanged = true
        }
      }

      const anchorChanged = parent.requestAnchor === null
      if (anchorChanged || dependencyChanged) {
        const parentUpdate = db.prepare(
          `UPDATE task_projections
              SET request_anchor_json = ?, dependency_generation = ?,
                  revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND revision = ? AND run_id = ?`,
        ).run(
          serializeWorkflowJson(requestAnchor, 'request_anchor_json'),
          parent.dependencyGeneration + (dependencyChanged ? 1 : 0),
          now,
          parent.taskId,
          parent.revision,
          input.ownerRunId,
        )
        if (changed(parentUpdate) !== 1) throw new Error('browser_route_parent_revision_conflict')
      }

      const childReadback = db.prepare(
        `SELECT id, kind, parent_task_id, active_execution_binding_json
           FROM browser_tasks WHERE id = ? LIMIT 1`,
      ).get<{
        id: string
        kind: string
        parent_task_id: string | null
        active_execution_binding_json: string | null
      }>(browserTaskId)
      if (
        !childReadback
        || childReadback.kind !== 'browser_workflow'
        || childReadback.parent_task_id !== parent.taskId
      ) {
        throw new Error('browser_route_child_readback_failed')
      }
      const bound = childReadback.active_execution_binding_json
        ? parseObjectStrict<TaskExecutionBinding>(
            childReadback.active_execution_binding_json,
            'browser_workflow_execution_binding_json',
          )
        : null
      if (!bound || workflowDigest(bound) !== workflowDigest(input.executionBinding)) {
        throw new Error('browser_route_child_binding_readback_failed')
      }
      const updatedParent = readParent(db, parent.taskId)
      if (updatedParent.requestAnchor?.snapshotDigest !== requestAnchor.snapshotDigest) {
        throw new Error('browser_route_parent_anchor_readback_failed')
      }
      return {
        browserTaskId,
        requestAnchorSnapshotDigest: requestAnchor.snapshotDigest,
        parentRevision: updatedParent.revision,
        dependencyGeneration: updatedParent.dependencyGeneration,
      }
    })
  }

  isBrowserWorkflowWriteAdmitted(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId: string
    physicalTarget: BrowserHumanTakeoverPhysicalTarget
  }): boolean {
    const db = this.accessor.getRawDb()
    if (!db) return false
    try {
      const parent = readParent(db, input.parentTaskId)
      if (!this.isBrowserWorkflowOwnerAdmitted(input)) return false
      if (
        !input.physicalTarget.tabId.trim()
        || !input.physicalTarget.physicalTargetToken.trim()
        || (
          input.physicalTarget.scopeId !== null
          && input.physicalTarget.scopeId !== parent.scopeId
        )
      ) return false
      return true
    } catch {
      return false
    }
  }

  isBrowserWorkflowOwnerAdmitted(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId: string
  }): boolean {
    const db = this.accessor.getRawDb()
    if (!db) return false
    try {
      const parent = readParent(db, input.parentTaskId)
      if (
        parent.runId !== input.ownerRunId
        || parent.status !== 'running'
        || parent.humanTakeoverRef?.state === 'pending'
      ) return false
      const parentBindingRaw = db.prepare(
        'SELECT execution_binding_json FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1',
      ).get<{ execution_binding_json: string | null }>(
        parent.taskId,
        input.ownerRunId,
      )?.execution_binding_json
      const child = db.prepare(
        `SELECT parent_task_id, kind, status, active_execution_binding_json
           FROM browser_tasks WHERE id = ? LIMIT 1`,
      ).get<{
        parent_task_id: string | null
        kind: string
        status: string
        active_execution_binding_json: string | null
      }>(input.browserTaskId)
      const run = db.prepare(
        `SELECT status, execution_binding_json FROM run_meta
          WHERE run_id = ? AND task_id = ? AND scope_id = ? LIMIT 1`,
      ).get<{ status: string; execution_binding_json: string | null }>(
        input.ownerRunId,
        parent.taskId,
        parent.scopeId,
      )
      if (
        !parentBindingRaw
        || !child
        || child.parent_task_id !== parent.taskId
        || child.kind !== 'browser_workflow'
        || child.status !== 'running'
        || !child.active_execution_binding_json
        || run?.status !== 'running'
        || !run.execution_binding_json
      ) return false
      const parentBinding = parseObjectStrict<TaskExecutionBinding>(
        parentBindingRaw,
        'browser_workflow_write_parent_execution_binding_json',
      )
      const childBinding = parseObjectStrict<TaskExecutionBinding>(
        child.active_execution_binding_json,
        'browser_workflow_write_child_execution_binding_json',
      )
      const runBinding = parseObjectStrict<TaskExecutionBinding>(
        run.execution_binding_json,
        'browser_workflow_write_run_execution_binding_json',
      )
      return parentBinding.runId === input.ownerRunId
        && workflowDigest(parentBinding) === workflowDigest(childBinding)
        && workflowDigest(parentBinding) === workflowDigest(runBinding)
    } catch {
      return false
    }
  }

  isBrowserWorkflowSettlementAdmitted(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId: string
  }): boolean {
    const db = this.accessor.getRawDb()
    if (!db) return false
    try {
      const parent = readParent(db, input.parentTaskId)
      const child = db.prepare(
        `SELECT parent_task_id, kind, payload_json FROM browser_tasks
          WHERE id = ? LIMIT 1`,
      ).get<{
        parent_task_id: string | null
        kind: string
        payload_json: string | null
      }>(input.browserTaskId)
      const run = db.prepare(
        `SELECT task_id, scope_id, execution_binding_json FROM run_meta
          WHERE run_id = ? LIMIT 1`,
      ).get<{
        task_id: string | null
        scope_id: string | null
        execution_binding_json: string | null
      }>(input.ownerRunId)
      if (
        !child
        || child.parent_task_id !== parent.taskId
        || child.kind !== 'browser_workflow'
        || !child.payload_json
        || run?.task_id !== parent.taskId
        || run.scope_id !== parent.scopeId
        || !run.execution_binding_json
      ) return false
      const runBinding = parseObjectStrict<TaskExecutionBinding>(
        run.execution_binding_json,
        'browser_workflow_settlement_run_execution_binding_json',
      )
      if (runBinding.runId !== input.ownerRunId) return false
      const payload = parseObjectStrict<Record<string, unknown>>(
        child.payload_json,
        'browser_workflow_settlement_payload_json',
      )
      const journal = payload.browserWorkflowActionJournal
      if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return false
      const activeAction = (journal as Record<string, unknown>).activeAction
      const activeActionRecord = activeAction && typeof activeAction === 'object' && !Array.isArray(activeAction)
        ? activeAction as Record<string, unknown>
        : null
      return Boolean(
        activeActionRecord
        && activeActionRecord.ownerRunId === input.ownerRunId
        && typeof activeActionRecord.actionId === 'string'
        && activeActionRecord.actionId.trim().length > 0
        && typeof activeActionRecord.actionSeq === 'number'
        && Number.isInteger(activeActionRecord.actionSeq)
        && activeActionRecord.actionSeq > 0
      )
    } catch {
      return false
    }
  }

  async updateBrowserWorkflowCompletionDeclaration(input: {
    parentTaskId: string
    browserTaskId: string
    ownerRunId: string
    modelCriteria: string[]
    expectedOutputs: string[]
    now?: string
  }): Promise<void> {
    await this.unitOfWork.runImmediateWithRetry((db) => {
      const child = db.prepare(`
        SELECT parent_task_id, kind, active_execution_binding_json
          FROM browser_tasks WHERE id = ? LIMIT 1
      `).get<{
        parent_task_id: string | null
        kind: string
        active_execution_binding_json: string | null
      }>(input.browserTaskId)
      const binding = child?.active_execution_binding_json
        ? JSON.parse(child.active_execution_binding_json) as { runId?: string }
        : null
      if (
        !child
        || child.parent_task_id !== input.parentTaskId
        || child.kind !== 'browser_workflow'
        || binding?.runId !== input.ownerRunId
      ) throw new Error('browser_completion_declaration_binding_mismatch')
      const updated = db.prepare(`
        UPDATE task_projections
           SET model_criteria_json = ?, expected_outputs_json = ?,
               revision = revision + 1, updated_at = ?
         WHERE task_id = ? AND run_id = ?
      `).run(
        JSON.stringify(input.modelCriteria),
        JSON.stringify(input.expectedOutputs),
        input.now || new Date().toISOString(),
        input.parentTaskId,
        input.ownerRunId,
      ) as { changes?: number }
      if (Number(updated.changes || 0) !== 1) {
        throw new Error('browser_completion_declaration_parent_conflict')
      }
    })
  }

  async settleHandoffTakeoverContinuation(input: {
    parentTaskId: string
    handoffGeneration: number
    outcome: 'consumed' | 'recovery_failed' | 'recovery_terminal'
    attempts?: number
    error?: string
    now?: string
  }): Promise<void> {
    await this.unitOfWork.runImmediateWithRetry((db) => {
      const row = db.prepare(`
        SELECT revision, continuation_ref_json, request_anchor_json
          FROM task_projections WHERE task_id = ? LIMIT 1
      `).get<{
        revision: number
        continuation_ref_json: string | null
        request_anchor_json: string | null
      }>(input.parentTaskId)
      if (!row) throw new Error('handoff_recovery_parent_not_found')
      if (!row.request_anchor_json) throw new Error('handoff_recovery_browser_parent_not_bound')
      if (!row.continuation_ref_json) return
      const continuation = parseObjectStrict<Record<string, unknown>>(
        row.continuation_ref_json,
        'handoff_recovery_continuation_ref_json',
      )
      if (
        continuation.kind !== 'handoff_takeover'
        || Number(continuation.handoffGeneration) !== input.handoffGeneration
      ) throw new Error('handoff_recovery_continuation_changed')
      if (continuation.consumed === true) return

      const nextContinuation: Record<string, unknown> = { ...continuation }
      let status: string | null = null
      let interactionState: string | null = null
      let blockedReason: string | null = null
      let resumableActions: string | null = null
      if (input.outcome === 'consumed') {
        nextContinuation.consumed = true
      } else if (input.outcome === 'recovery_failed') {
        nextContinuation.startupRecoveryAttempts = Math.max(1, Number(input.attempts || 1))
        nextContinuation.startupRecoveryError = String(input.error || 'handoff takeover failed')
      } else {
        const error = String(input.error || 'startup_recovery_exhausted')
        nextContinuation.consumed = true
        nextContinuation.startupRecoveryAttempts = Math.max(
          3,
          Number(input.attempts || continuation.startupRecoveryAttempts || 0),
        )
        nextContinuation.startupRecoveryTerminal = true
        nextContinuation.startupRecoveryError = error
        status = 'failed'
        interactionState = 'suspended'
        blockedReason = error
        resumableActions = '[]'
      }

      const now = input.now || new Date().toISOString()
      const updated = input.outcome === 'recovery_terminal'
        ? db.prepare(`
            UPDATE task_projections
               SET continuation_ref_json = ?, status = ?, interaction_state = ?,
                   blocked_reason = ?, resumable_actions_json = ?, waiting_for = 'none',
                   revision = revision + 1, updated_at = ?
             WHERE task_id = ? AND revision = ? AND request_anchor_json IS NOT NULL
               AND continuation_ref_json = ?
          `).run(
            serializeWorkflowJson(nextContinuation, 'handoff_recovery_continuation_ref_json'),
            status,
            interactionState,
            blockedReason,
            resumableActions,
            now,
            input.parentTaskId,
            row.revision,
            row.continuation_ref_json,
          )
        : db.prepare(`
            UPDATE task_projections
               SET continuation_ref_json = ?, revision = revision + 1, updated_at = ?
             WHERE task_id = ? AND revision = ? AND request_anchor_json IS NOT NULL
               AND continuation_ref_json = ?
          `).run(
            serializeWorkflowJson(nextContinuation, 'handoff_recovery_continuation_ref_json'),
            now,
            input.parentTaskId,
            row.revision,
            row.continuation_ref_json,
          )
      if (changed(updated) !== 1) throw new Error('handoff_recovery_parent_conflict')
    })
  }
}
