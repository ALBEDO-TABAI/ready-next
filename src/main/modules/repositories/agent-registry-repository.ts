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
  isValidAgentSlug,
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

function defaultPersonalityText(id: string, name: string, charter: string | null): string {
  return [
    `# ${name}`,
    '',
    '你是 Ready 工作台中的一个完整 Agent。',
    charter ? `职责范围：${charter}` : `请围绕 ${id} 的职责稳定协助用户完成任务。`,
    '请用清晰、稳定、可复盘的方式工作；遇到边界不清时先向用户确认。',
  ].join('\n')
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

  create(input: {
    id: string
    name: string
    charter?: string | null
    personalityText?: string | null
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
    if (!isValidAgentSlug(record.id)) throw new Error('[agent-registry] id must be a valid agent slug')
    record.personaRef = record.personaRef || record.id
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
    const personalityText = String(input.personalityText || '').trim()
      || defaultPersonalityText(record.id, record.name, record.charter)
    db.prepare(`
      INSERT OR IGNORE INTO agent_personalities (
        id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `personality-${record.id}`,
      record.id,
      record.name,
      personalityText,
      null,
      JSON.stringify({ emoji: '🤖' }),
      Date.now(),
      Date.now(),
    )
    return record
  }

  updateName(id: string, name: string): AgentRegistryRecord {
    const normalizedId = String(id || '').trim()
    const normalizedName = String(name || '').trim()
    if (!normalizedId) throw new Error('[agent-registry] id is required')
    if (!normalizedName) throw new Error('[agent-registry] name is required')
    if (normalizedId === MAIN_AGENT_ID) throw new Error('[agent-registry] main agent display name is managed separately')

    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const current = this.get(normalizedId)
    if (!current) throw new Error('[agent-registry] agent not found')
    if (current.status !== 'active') throw new Error('[agent-registry] only active agents can be renamed')

    db.prepare('UPDATE agents SET name = ? WHERE id = ?')
      .run(normalizedName, normalizedId)
    db.prepare('UPDATE agent_personalities SET display_name = ?, updated_at = ? WHERE agent_name = ?')
      .run(normalizedName, Date.now(), normalizedId)

    return {
      ...current,
      name: normalizedName,
    }
  }

  updateStatus(
    id: string,
    status: AgentRegistryStatus,
    options: { mergedIntoAgentId?: string | null } = {},
  ): AgentRegistryRecord {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) throw new Error('[agent-registry] id is required')
    if (status === 'retired') throw new Error('[agent-registry] retired is legacy read-only; use disabled')
    const normalizedStatus = normalizeStatus(status)
    if (normalizedId === MAIN_AGENT_ID && normalizedStatus !== 'active') {
      throw new Error('[agent-registry] main agent cannot be disabled or merged')
    }
    if (normalizedStatus !== 'active' && normalizedStatus !== 'disabled' && normalizedStatus !== 'merged') {
      throw new Error('[agent-registry] unsupported lifecycle status')
    }

    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const current = this.get(normalizedId)
    if (!current) throw new Error('[agent-registry] agent not found')
    if (current.status === 'merged') throw new Error('[agent-registry] merged agents cannot change lifecycle status')

    const targetId = String(options.mergedIntoAgentId || '').trim()
    let mergedIntoAgentId: string | null = null
    if (normalizedStatus === 'merged') {
      if (current.status !== 'active') throw new Error('[agent-registry] only active agents can be merged')
      if (!targetId) throw new Error('[agent-registry] merged agent requires a target')
      if (targetId === normalizedId) throw new Error('[agent-registry] merged target must be another agent')
      const target = this.get(targetId)
      if (!target || target.status !== 'active') throw new Error('[agent-registry] merged target must be active')
      mergedIntoAgentId = targetId
    } else if (normalizedStatus === 'disabled') {
      if (current.status !== 'active') throw new Error('[agent-registry] only active agents can be disabled')
    } else if (normalizedStatus === 'active') {
      if (current.status !== 'disabled') return current
    }

    if (normalizedStatus === 'merged' && mergedIntoAgentId) {
      db.prepare('UPDATE agents SET merged_into_agent_id = ? WHERE status = ? AND merged_into_agent_id = ?')
        .run(mergedIntoAgentId, 'merged', normalizedId)
    }
    db.prepare('UPDATE agents SET status = ?, merged_into_agent_id = ? WHERE id = ?')
      .run(normalizedStatus, mergedIntoAgentId, normalizedId)

    return {
      ...current,
      status: normalizedStatus,
      mergedIntoAgentId,
    }
  }

  deleteAgent(id: string): AgentRegistryRecord {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) throw new Error('[agent-registry] id is required')
    if (normalizedId === MAIN_AGENT_ID) throw new Error('[agent-registry] main agent cannot be deleted')
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const current = this.get(normalizedId)
    if (!current) throw new Error('[agent-registry] agent not found')

    db.prepare("UPDATE specialist_content_edit_proposals SET status = 'rejected' WHERE agent_id = ? AND status = 'staged'")
      .run(normalizedId)
    db.prepare(`
      UPDATE specialist_blueprints
      SET status = 'rejected'
      WHERE specialist_id = ?
        AND status IN ('draft', 'needs_clarification', 'staged', 'confirmed')
        AND content_json NOT LIKE '%"adoption"%'
    `).run(normalizedId)
    db.prepare('DELETE FROM agent_personalities WHERE agent_name = ?').run(normalizedId)
    db.prepare('DELETE FROM agents WHERE id = ?').run(normalizedId)
    return current
  }
}
