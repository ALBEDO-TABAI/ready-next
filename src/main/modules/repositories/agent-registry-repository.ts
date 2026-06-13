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

/** The migration-055 seeded main-agent row id — the only row until A4
 *  adoption / phase-4 derivation add more. */
export const MAIN_AGENT_ID = 'butler'
export type AgentRegistryStatus = 'active' | 'retired' | 'merged'

export interface AgentRegistryRecord {
  id: string
  name: string
  charter: string | null
  personaRef: string | null
  status: AgentRegistryStatus
  parentAgentId: string | null
  derivationReason: string | null
  mergedIntoAgentId: string | null
  createdAt: string
}

interface AgentsRow {
  id: string
  name: string
  charter: string | null
  persona_ref: string | null
  status: string
  parent_agent_id?: string | null
  derivation_reason?: string | null
  merged_into_agent_id?: string | null
  created_at: string
}

function normalizeStatus(status: string | null | undefined): AgentRegistryStatus {
  return status === 'retired' || status === 'merged' ? status : 'active'
}

function mapRow(row: AgentsRow): AgentRegistryRecord {
  return {
    id: row.id,
    name: row.name,
    charter: row.charter ?? null,
    personaRef: row.persona_ref ?? null,
    status: normalizeStatus(row.status),
    parentAgentId: row.parent_agent_id ?? null,
    derivationReason: row.derivation_reason ?? null,
    mergedIntoAgentId: row.merged_into_agent_id ?? null,
    createdAt: row.created_at,
  }
}

export class AgentRegistryRepository {
  constructor(private readonly dbManager: AgentsDatabaseAccessor) {}

  list(): AgentRegistryRecord[] {
    try {
      const db = this.dbManager.getRawDb()
      if (!db) return []
      return db.prepare('SELECT id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at FROM agents ORDER BY created_at ASC')
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
      const row = db.prepare('SELECT id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at FROM agents WHERE id = ? LIMIT 1')
        .get<AgentsRow>(normalized)
      return row ? mapRow(row) : null
    } catch {
      return null
    }
  }

  create(input: {
    id: string
    name: string
    charter?: string | null
    personaRef?: string | null
    parentAgentId?: string | null
    derivationReason?: string | null
  }): AgentRegistryRecord {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const record: AgentRegistryRecord = {
      id: String(input.id).trim(),
      name: String(input.name).trim(),
      charter: input.charter ?? null,
      personaRef: input.personaRef ?? null,
      status: 'active',
      parentAgentId: input.parentAgentId ?? null,
      derivationReason: input.derivationReason ?? null,
      mergedIntoAgentId: null,
      createdAt: new Date().toISOString(),
    }
    if (!record.id || !record.name) throw new Error('[agent-registry] id and name are required')
    db.prepare('INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.name,
        record.charter,
        record.personaRef,
        record.status,
        record.parentAgentId,
        record.derivationReason,
        record.mergedIntoAgentId,
        record.createdAt,
      )
    return record
  }

  updateStatus(
    id: string,
    status: Exclude<AgentRegistryStatus, 'active'>,
    options: { mergedIntoAgentId?: string | null } = {},
  ): AgentRegistryRecord {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) throw new Error('[agent-registry] id is required')
    if (normalizedId === MAIN_AGENT_ID) throw new Error('[agent-registry] main agent cannot be retired or merged')
    if (status !== 'retired' && status !== 'merged') throw new Error('[agent-registry] unsupported lifecycle status')

    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const current = this.get(normalizedId)
    if (!current) throw new Error('[agent-registry] agent not found')
    if (current.status !== 'active') throw new Error('[agent-registry] only active agents can change lifecycle status')

    const targetId = String(options.mergedIntoAgentId || '').trim()
    let mergedIntoAgentId: string | null = null
    if (status === 'merged') {
      if (!targetId) throw new Error('[agent-registry] merged agent requires a target')
      if (targetId === normalizedId) throw new Error('[agent-registry] merged target must be another agent')
      const target = this.get(targetId)
      if (!target || target.status !== 'active') throw new Error('[agent-registry] merged target must be active')
      mergedIntoAgentId = targetId
    }

    db.prepare('UPDATE agents SET status = ?, merged_into_agent_id = ? WHERE id = ?')
      .run(status, mergedIntoAgentId, normalizedId)

    return {
      ...current,
      status,
      mergedIntoAgentId,
    }
  }
}
