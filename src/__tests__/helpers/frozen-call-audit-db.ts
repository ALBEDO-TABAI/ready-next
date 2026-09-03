import type { FrozenCallDb } from '../../main/modules/agent-control/safety/frozen-call-store'

type AuditRow = {
  id: unknown
  run_id: unknown
  task_id: unknown
  scope_id: unknown
  tool_name: unknown
  params_json: unknown
  created_at: unknown
  expires_at: unknown
  status: unknown
  released_at: unknown
}

export interface FrozenCallAuditDb extends FrozenCallDb {
  settleLatest(status: 'released' | 'denied' | 'expired'): void
}

export function createFrozenCallAuditDb(): FrozenCallAuditDb {
  const rows = new Map<string, AuditRow>()
  return {
    settleLatest(status) {
      const row = [...rows.values()].find((candidate) => candidate.status === 'pending')
      if (!row) throw new Error('no pending frozen-call audit row')
      row.status = status
      row.released_at = status === 'released' ? new Date().toISOString() : null
    },
    prepare(sql: string) {
      return {
        get(...params: unknown[]) {
          if (/FROM pending_confirmations WHERE id = \? LIMIT 1/i.test(sql)) {
            return rows.get(String(params[0]))
          }
          if (/FROM pending_confirmations[\s\S]*status = 'pending'/i.test(sql)) {
            const [scopeId, runId] = params
            return [...rows.values()].some((row) => row.status === 'pending'
              && (row.scope_id === scopeId || row.run_id === runId))
              ? { present: 1 }
              : undefined
          }
          return undefined
        },
        run(...params: unknown[]) {
          if (/INSERT INTO pending_confirmations/i.test(sql)) {
            const [id, runId, taskId, scopeId, toolName, paramsJson, createdAt, expiresAt, status] = params
            rows.set(String(id), {
              id,
              run_id: runId,
              task_id: taskId,
              scope_id: scopeId,
              tool_name: toolName,
              params_json: paramsJson,
              created_at: createdAt,
              expires_at: expiresAt,
              status,
              released_at: null,
            })
            return { changes: 1 }
          }
          if (/UPDATE pending_confirmations SET status = \?, released_at = \? WHERE id = \? AND status = 'pending'/i.test(sql)) {
            const [status, releasedAt, id] = params
            const row = rows.get(String(id))
            if (row?.status !== 'pending') return { changes: 0 }
            row.status = status
            row.released_at = releasedAt
            return { changes: 1 }
          }
          if (/UPDATE pending_confirmations SET status = 'expired' WHERE status = 'pending'/i.test(sql)) {
            let changes = 0
            for (const row of rows.values()) {
              if (row.status !== 'pending') continue
              row.status = 'expired'
              changes += 1
            }
            return { changes }
          }
          throw new Error(`unexpected frozen-call audit SQL: ${sql}`)
        },
      }
    },
  }
}
