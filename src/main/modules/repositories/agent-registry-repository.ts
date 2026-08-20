/**
 * EP3-A1 — agents registry (migration 055). Read/write convergence point for
 * the agents table. The table carries ONLY the main-agent row until A4
 * adoption (and, in phase 4, the A6 derivation flow) adds more — an empty or
 * main-only table means the system behaves exactly as before (存量零感知).
 * A dead DB degrades to empty reads; it never throws into callers.
 */

import {
  MAIN_AGENT_ID as SHARED_MAIN_AGENT_ID,
  type LegacyAgentLifecycleStatus,
  normalizeAgentLifecycleStatus,
} from '../../../shared/agent-identity'

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

/** The migration-055 seeded main-agent row id. */
export const MAIN_AGENT_ID = SHARED_MAIN_AGENT_ID
export type AgentRegistryStatus = LegacyAgentLifecycleStatus

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
  return normalizeAgentLifecycleStatus(status)
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

}
