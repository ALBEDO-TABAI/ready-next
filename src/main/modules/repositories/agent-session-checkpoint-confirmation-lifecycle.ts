import type {
  BrowserConfirmationSuspensionRequest, BrowserPowerConfirmationSuspensionRequest
} from '../../../shared/browser-workflow-control'
import {
  parseObjectStrict,
  serializeWorkflowJson
} from './browser-workflow-codec'
import type {
  WorkflowDatabaseAccessor
} from './browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork } from './browser-workflow-unit-of-work'
import {
  readWorkflowParent
} from './browser-workflow-row-mapping'
import {
  permissionConfirmationRequestFromContinuation,
  powerConfirmationRequestFromContinuation
} from './agent-session-checkpoint-confirmations'

const readParent = readWorkflowParent

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export class AgentSessionCheckpointConfirmationLifecycleRepository {
  constructor(
    private readonly accessor: WorkflowDatabaseAccessor,
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
  ) {}

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
    excludedRunIds?: ReadonlySet<string>
  } = {}): Promise<string[]> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const now = input.now || new Date().toISOString()
      const rows = db.prepare(
        `SELECT task_id, run_id, continuation_ref_json, revision
           FROM task_projections
          WHERE status = 'recoverable_paused'
            AND waiting_for = 'confirmation'
            AND blocked_reason IN ('browser_power_confirmation_checkpoint', 'browser_permission_checkpoint')
            AND (? IS NULL OR scope_id = ?)
          ORDER BY updated_at ASC`,
      ).all<{ task_id: string; run_id: string | null; continuation_ref_json: string | null; revision: number }>(
        input.scopeId || null,
        input.scopeId || null,
      )
      const expiredTaskIds: string[] = []
      for (const row of rows) {
        if (row.run_id && input.excludedRunIds?.has(row.run_id)) continue
        let continuation: Record<string, unknown> = {}
        try {
          continuation = parseObjectStrict<Record<string, unknown>>(
            row.continuation_ref_json,
            'browser_confirmation_expiration_continuation_ref_json',
          )
        } catch {
          // A persisted confirmation with no readable request can never be
          // safely released after restart. Expire it with the valid rows so
          // one corrupt historical row cannot abort the whole startup fence.
        }
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


}
