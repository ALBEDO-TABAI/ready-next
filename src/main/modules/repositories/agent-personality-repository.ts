/**
 * Repository for managing agent personalities (SOUL.md data).
 * Each agent can have a custom personality definition that shapes its behavior.
 */

export interface AgentPersonality {
  id: string
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  metaJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface AgentPersonalityRow {
  id: string
  agent_name: string
  display_name: string | null
  personality_text: string
  tone: string | null
  meta_json: string | null
  created_at: number
  updated_at: number
}

export class AgentPersonalityRepository {
  private async getDatabase() {
    const { getRepositoryDatabase } = await import('./database-accessor')
    const dbManager = getRepositoryDatabase()
    const db = dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db
  }

  /**
   * Get agent personality by agent name
   */
  async getPersonality(agentName: string): Promise<AgentPersonality | null> {
    const db = await this.getDatabase()
    const row = db
      .prepare(`SELECT * FROM agent_personalities WHERE agent_name = ?`)
      .get(agentName) as AgentPersonalityRow | undefined

    if (!row) {
      return null
    }

    return this.rowToPersonality(row)
  }

  /**
   * Create a new agent personality
   */
  async createPersonality(personality: Partial<AgentPersonality>): Promise<AgentPersonality> {
    const db = await this.getDatabase()
    if (!personality.agentName) {
      throw new Error('agentName is required')
    }
    if (!personality.personalityText) {
      throw new Error('personalityText is required')
    }

    const id = personality.id || `personality-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const now = Date.now()

    const metaJson = personality.metaJson ? JSON.stringify(personality.metaJson) : null

    db
      .prepare(
        `INSERT INTO agent_personalities (
          id, agent_name, display_name, personality_text, tone,
          meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        personality.agentName,
        personality.displayName || null,
        personality.personalityText,
        personality.tone || null,
        metaJson,
        personality.createdAt || now,
        personality.updatedAt || now
      )

    const created = await this.getPersonality(personality.agentName)
    if (!created) {
      throw new Error(`Failed to create agent personality: ${personality.agentName}`)
    }

    return created
  }

  /**
   * Update an existing agent personality
   */
  async updatePersonality(agentName: string, updates: Partial<AgentPersonality>): Promise<void> {
    const db = await this.getDatabase()
    const existing = await this.getPersonality(agentName)
    if (!existing) {
      throw new Error(`Agent personality not found: ${agentName}`)
    }

    const metaJson = updates.metaJson ? JSON.stringify(updates.metaJson) : undefined

    const fields: string[] = []
    const values: unknown[] = []

    if (updates.displayName !== undefined) {
      fields.push('display_name = ?')
      values.push(updates.displayName)
    }
    if (updates.personalityText !== undefined) {
      fields.push('personality_text = ?')
      values.push(updates.personalityText)
    }
    if (updates.tone !== undefined) {
      fields.push('tone = ?')
      values.push(updates.tone)
    }
    if (metaJson !== undefined) {
      fields.push('meta_json = ?')
      values.push(metaJson)
    }

    fields.push('updated_at = ?')
    values.push(Date.now())

    values.push(agentName)

    db
      .prepare(`UPDATE agent_personalities SET ${fields.join(', ')} WHERE agent_name = ?`)
      .run(...values)
  }

  /**
   * List all agent personalities
   */
  async listPersonalities(): Promise<AgentPersonality[]> {
    const db = await this.getDatabase()
    const rows = db
      .prepare(`SELECT * FROM agent_personalities ORDER BY agent_name ASC`)
      .all() as AgentPersonalityRow[]

    return rows.map((row) => this.rowToPersonality(row))
  }

  /**
   * Delete an agent personality
   */
  async deletePersonality(agentName: string): Promise<void> {
    const db = await this.getDatabase()
    db.prepare(`DELETE FROM agent_personalities WHERE agent_name = ?`).run(agentName)
  }

  /**
   * Convert database row to AgentPersonality object
   */
  private rowToPersonality(row: AgentPersonalityRow): AgentPersonality {
    return {
      id: row.id,
      agentName: row.agent_name,
      displayName: row.display_name || undefined,
      personalityText: row.personality_text,
      tone: row.tone || undefined,
      metaJson: row.meta_json ? JSON.parse(row.meta_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}
