import type { HumanTakeoverRef } from '../../../shared/browser-workflow-control'
import { parseObjectStrict, serializeWorkflowJson } from './browser-workflow-codec'
import { BrowserWorkflowUnitOfWork } from './browser-workflow-unit-of-work'

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export class AgentSessionCheckpointTakeoverExpiryRepository {
  constructor(readonly unitOfWork: BrowserWorkflowUnitOfWork) {}

  async expirePendingHumanTakeovers(input: {
    scopeId?: string | null
    now?: string
  } = {}): Promise<string[]> {
    return this.unitOfWork.runImmediateWithRetry((db) => {
      const now = input.now || new Date().toISOString()
      const rows = db.prepare(
        `SELECT task_id, human_takeover_ref_json, revision
           FROM task_projections
          WHERE human_takeover_ref_json IS NOT NULL
            AND interaction_state = 'human_takeover'
            AND waiting_for = 'confirmation'
            AND (? IS NULL OR scope_id = ?)
          ORDER BY updated_at ASC`,
      ).all<{ task_id: string; human_takeover_ref_json: string; revision: number }>(
        input.scopeId || null,
        input.scopeId || null,
      )
      const expiredTaskIds: string[] = []
      for (const row of rows) {
        const takeover = parseObjectStrict<HumanTakeoverRef>(
          row.human_takeover_ref_json,
          'human_takeover_expiration_ref_json',
        )
        if (takeover.state !== 'pending') continue
        const result = db.prepare(
          `UPDATE task_projections
              SET human_takeover_ref_json = NULL,
                  interaction_state = 'suspended',
                  waiting_for = 'none',
                  blocked_reason = 'human_takeover_expired_on_restart',
                  degradation_reason = 'human_takeover_expired_on_restart',
                  resumable_actions_json = ?,
                  revision = revision + 1,
                  updated_at = ?
            WHERE task_id = ? AND revision = ?
              AND interaction_state = 'human_takeover'
              AND waiting_for = 'confirmation'`,
        ).run(
          serializeWorkflowJson(['continue', 'cancel'], 'human_takeover_expiration_actions'),
          now,
          row.task_id,
          row.revision,
        )
        if (changed(result) !== 1) throw new Error('human_takeover_expiration_cas_failed')
        expiredTaskIds.push(row.task_id)
      }
      return expiredTaskIds
    })
  }
}
