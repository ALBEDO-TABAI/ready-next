import type { FrozenCallDb } from '../../main/modules/agent-control/safety/frozen-call-store'

type AuditRow = {
  status: unknown
  releasedAt: unknown
}

export function createFrozenCallAuditDb(): FrozenCallDb {
  const rows = new Map<string, AuditRow>()
  return {
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          if (/INSERT INTO pending_confirmations/i.test(sql)) {
            const [id, , , , , , , , status] = params
            rows.set(String(id), { status, releasedAt: null })
            return { changes: 1 }
          }
          if (/UPDATE pending_confirmations SET status = \?, released_at = \? WHERE id = \? AND status = 'pending'/i.test(sql)) {
            const [status, releasedAt, id] = params
            const row = rows.get(String(id))
            if (row?.status !== 'pending') return { changes: 0 }
            row.status = status
            row.releasedAt = releasedAt
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
