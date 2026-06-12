/**
 * EP3-A1 — agents registry (migration 055). Read/write convergence point for
 * the agents table. The table carries ONLY the main-agent row until A4
 * adoption (and, in phase 4, the A6 derivation flow) adds more — an empty or
 * main-only table means the system behaves exactly as before (存量零感知).
 * A dead DB degrades to empty reads; it never throws into callers.
 */

interface AgentsStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface AgentsRawDatabase {
  prepare(sql: string): AgentsStatement
}

interface AgentsDatabaseAccessor {
  getRawDb(): AgentsRawDatabase | null
}

export interface AgentRegistryRecord {
  id: string
  name: string
  charter: string | null
  personaRef: string | null
  status: string
  createdAt: string
}

interface AgentsRow {
  id: string
  name: string
  charter: string | null
  persona_ref: string | null
  status: string
  created_at: string
}

function mapRow(row: AgentsRow): AgentRegistryRecord {
  return {
    id: row.id,
    name: row.name,
    charter: row.charter ?? null,
    personaRef: row.persona_ref ?? null,
    status: row.status || 'active',
    createdAt: row.created_at,
  }
}

export class AgentRegistryRepository {
  constructor(private readonly dbManager: AgentsDatabaseAccessor) {}

  list(): AgentRegistryRecord[] {
    try {
      const db = this.dbManager.getRawDb()
      if (!db) return []
      return db.prepare('SELECT id, name, charter, persona_ref, status, created_at FROM agents ORDER BY created_at ASC')
        .all<AgentsRow>()
        .map(mapRow)
    } catch {
      return []
    }
  }

  get(id: string): AgentRegistryRecord | null {
    const normalized = String(id || '').trim()
    if (!normalized) return null
    try {
      const db = this.dbManager.getRawDb()
      if (!db) return null
      const row = db.prepare('SELECT id, name, charter, persona_ref, status, created_at FROM agents WHERE id = ? LIMIT 1')
        .get<AgentsRow>(normalized)
      return row ? mapRow(row) : null
    } catch {
      return null
    }
  }

  create(input: { id: string; name: string; charter?: string | null; personaRef?: string | null }): AgentRegistryRecord {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const record: AgentRegistryRecord = {
      id: String(input.id).trim(),
      name: String(input.name).trim(),
      charter: input.charter ?? null,
      personaRef: input.personaRef ?? null,
      status: 'active',
      createdAt: new Date().toISOString(),
    }
    if (!record.id || !record.name) throw new Error('[agent-registry] id and name are required')
    db.prepare('INSERT INTO agents (id, name, charter, persona_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.name, record.charter, record.personaRef, record.status, record.createdAt)
    return record
  }
}
