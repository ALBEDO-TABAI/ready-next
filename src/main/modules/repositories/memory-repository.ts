import { randomUUID } from 'crypto'

export type MemoryLayer = 'l0' | 'l1' | 'l2'
export type MemoryCategory = 'summary' | 'learning' | 'trigger' | 'rule'

export interface MemoryEntry {
  id: string
  layer: MemoryLayer
  scopeId: string | null
  category: MemoryCategory
  title: string
  summary: string | null
  contentKey: string
  priority: number
  accessCount: number
  lastAccessedAt: number | null
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  archivedAt: number | null
  tags: string[] | null
  meta: Record<string, unknown>
}

export interface TriggerDefinition {
  id: string
  label: string
  module: string | null
  pattern: string
  patternFlags: string
  blocking: boolean
  priority: number
  enabled: boolean
  hitCount: number
  lastHitAt: number | null
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

export interface MemoryQueryFilters {
  layer?: MemoryLayer
  scopeId?: string | null
  category?: MemoryCategory
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export interface TriggerFilters {
  enabled?: boolean
  module?: string
  limit?: number
}

export interface MemoryStats {
  totalMemories: number
  byLayer: Record<MemoryLayer, number>
  byCategory: Record<MemoryCategory, number>
  archivedCount: number
  avgAccessCount: number
}

export interface TriggerStats {
  id: string
  label: string
  hitCount: number
  lastHitAt: number | null
  memoryCount: number
}

export class MemoryRepository {
  private async getDatabase() {
    const { getRepositoryDatabase } = await import('./database-accessor')
    const dbManager = getRepositoryDatabase()
    const db = dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db
  }

  // ============================================================
  // Memory CRUD Operations
  // ============================================================

  async createMemory(entry: Partial<MemoryEntry>): Promise<MemoryEntry> {
    const db = await this.getDatabase()
    const id = entry.id || `mem-${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    db.prepare(`
      INSERT INTO agent_memory_metadata (
        id, layer, scope_id, category, title, summary, content_key,
        priority, access_count, last_accessed_at, created_at, updated_at,
        expires_at, archived_at, tags, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.layer || 'l1',
      entry.scopeId ?? null,
      entry.category || 'summary',
      entry.title || 'Untitled',
      entry.summary ?? null,
      entry.contentKey || id,
      entry.priority ?? 0,
      entry.accessCount ?? 0,
      entry.lastAccessedAt ?? null,
      entry.createdAt ?? now,
      entry.updatedAt ?? now,
      entry.expiresAt ?? null,
      entry.archivedAt ?? null,
      entry.tags ? JSON.stringify(entry.tags) : null,
      JSON.stringify(entry.meta || {})
    )

    const created = await this.getMemory(id)
    if (!created) throw new Error(`Failed to create memory: ${id}`)
    return created
  }

  async getMemory(id: string): Promise<MemoryEntry | null> {
    const db = await this.getDatabase()
    const row = db.prepare(`
      SELECT * FROM agent_memory_metadata WHERE id = ?
    `).get<{
      id: string
      layer: MemoryLayer
      scope_id: string | null
      category: MemoryCategory
      title: string
      summary: string | null
      content_key: string
      priority: number
      access_count: number
      last_accessed_at: number | null
      created_at: number
      updated_at: number
      expires_at: number | null
      archived_at: number | null
      tags: string | null
      meta_json: string
    }>(id)

    if (!row) return null
    return this.mapMemoryRow(row)
  }

  async updateMemory(id: string, updates: Partial<MemoryEntry>): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    const fields: string[] = []
    const values: unknown[] = []

    if (updates.title !== undefined) {
      fields.push('title = ?')
      values.push(updates.title)
    }
    if (updates.summary !== undefined) {
      fields.push('summary = ?')
      values.push(updates.summary)
    }
    if (updates.contentKey !== undefined) {
      fields.push('content_key = ?')
      values.push(updates.contentKey)
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?')
      values.push(updates.priority)
    }
    if (updates.expiresAt !== undefined) {
      fields.push('expires_at = ?')
      values.push(updates.expiresAt)
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?')
      values.push(updates.tags ? JSON.stringify(updates.tags) : null)
    }
    if (updates.meta !== undefined) {
      fields.push('meta_json = ?')
      values.push(JSON.stringify(updates.meta))
    }

    if (fields.length === 0) return

    fields.push('updated_at = ?')
    values.push(now)
    values.push(id)

    db.prepare(`
      UPDATE agent_memory_metadata SET ${fields.join(', ')} WHERE id = ?
    `).run(...values)
  }

  async deleteMemory(id: string): Promise<void> {
    const db = await this.getDatabase()
    db.prepare('DELETE FROM agent_memory_metadata WHERE id = ?').run(id)
  }

  async archiveMemory(id: string): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      UPDATE agent_memory_metadata SET archived_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id)
  }

  // ============================================================
  // Query Operations
  // ============================================================

  async queryMemories(filters: MemoryQueryFilters): Promise<MemoryEntry[]> {
    const db = await this.getDatabase()
    const conditions: string[] = []
    const values: unknown[] = []

    if (filters.layer) {
      conditions.push('layer = ?')
      values.push(filters.layer)
    }

    if (filters.scopeId !== undefined) {
      if (filters.scopeId === null) {
        conditions.push('scope_id IS NULL')
      } else {
        conditions.push('scope_id = ?')
        values.push(filters.scopeId)
      }
    }

    if (filters.category) {
      conditions.push('category = ?')
      values.push(filters.category)
    }

    if (!filters.includeArchived) {
      conditions.push('archived_at IS NULL')
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limitClause = filters.limit ? `LIMIT ${filters.limit}` : ''
    const offsetClause = filters.offset ? `OFFSET ${filters.offset}` : ''

    const rows = db.prepare(`
      SELECT * FROM agent_memory_metadata
      ${whereClause}
      ORDER BY priority DESC, last_accessed_at DESC, created_at DESC
      ${limitClause} ${offsetClause}
    `).all<{
      id: string
      layer: MemoryLayer
      scope_id: string | null
      category: MemoryCategory
      title: string
      summary: string | null
      content_key: string
      priority: number
      access_count: number
      last_accessed_at: number | null
      created_at: number
      updated_at: number
      expires_at: number | null
      archived_at: number | null
      tags: string | null
      meta_json: string
    }>(...values)

    return rows.map((row) => this.mapMemoryRow(row))
  }

  async searchMemories(query: string, filters?: MemoryQueryFilters): Promise<MemoryEntry[]> {
    const db = await this.getDatabase()
    const conditions: string[] = ['(title LIKE ? OR summary LIKE ?)']
    const values: unknown[] = [`%${query}%`, `%${query}%`]

    if (filters?.layer) {
      conditions.push('layer = ?')
      values.push(filters.layer)
    }

    if (filters?.scopeId !== undefined) {
      if (filters.scopeId === null) {
        conditions.push('scope_id IS NULL')
      } else {
        conditions.push('scope_id = ?')
        values.push(filters.scopeId)
      }
    }

    if (filters?.category) {
      conditions.push('category = ?')
      values.push(filters.category)
    }

    if (!filters?.includeArchived) {
      conditions.push('archived_at IS NULL')
    }

    const limitClause = filters?.limit ? `LIMIT ${filters.limit}` : 'LIMIT 50'

    const rows = db.prepare(`
      SELECT * FROM agent_memory_metadata
      WHERE ${conditions.join(' AND ')}
      ORDER BY priority DESC, last_accessed_at DESC
      ${limitClause}
    `).all<{
      id: string
      layer: MemoryLayer
      scope_id: string | null
      category: MemoryCategory
      title: string
      summary: string | null
      content_key: string
      priority: number
      access_count: number
      last_accessed_at: number | null
      created_at: number
      updated_at: number
      expires_at: number | null
      archived_at: number | null
      tags: string | null
      meta_json: string
    }>(...values)

    return rows.map((row) => this.mapMemoryRow(row))
  }

  // ============================================================
  // Trigger CRUD Operations
  // ============================================================

  async createTrigger(trigger: Partial<TriggerDefinition>): Promise<TriggerDefinition> {
    const db = await this.getDatabase()
    const id = trigger.id || `trigger-${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    db.prepare(`
      INSERT INTO agent_triggers (
        id, label, module, pattern, pattern_flags, blocking, priority,
        enabled, hit_count, last_hit_at, created_at, updated_at, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      trigger.label || 'Untitled Trigger',
      trigger.module ?? null,
      trigger.pattern || '.*',
      trigger.patternFlags || 'i',
      trigger.blocking ? 1 : 0,
      trigger.priority ?? 0,
      trigger.enabled !== false ? 1 : 0,
      trigger.hitCount ?? 0,
      trigger.lastHitAt ?? null,
      trigger.createdAt ?? now,
      trigger.updatedAt ?? now,
      JSON.stringify(trigger.meta || {})
    )

    const created = await this.getTrigger(id)
    if (!created) throw new Error(`Failed to create trigger: ${id}`)
    return created
  }

  async getTrigger(id: string): Promise<TriggerDefinition | null> {
    const db = await this.getDatabase()
    const row = db.prepare(`
      SELECT * FROM agent_triggers WHERE id = ?
    `).get<{
      id: string
      label: string
      module: string | null
      pattern: string
      pattern_flags: string
      blocking: number
      priority: number
      enabled: number
      hit_count: number
      last_hit_at: number | null
      created_at: number
      updated_at: number
      meta_json: string
    }>(id)

    if (!row) return null
    return this.mapTriggerRow(row)
  }

  async updateTrigger(id: string, updates: Partial<TriggerDefinition>): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    const fields: string[] = []
    const values: unknown[] = []

    if (updates.label !== undefined) {
      fields.push('label = ?')
      values.push(updates.label)
    }
    if (updates.module !== undefined) {
      fields.push('module = ?')
      values.push(updates.module)
    }
    if (updates.pattern !== undefined) {
      fields.push('pattern = ?')
      values.push(updates.pattern)
    }
    if (updates.patternFlags !== undefined) {
      fields.push('pattern_flags = ?')
      values.push(updates.patternFlags)
    }
    if (updates.blocking !== undefined) {
      fields.push('blocking = ?')
      values.push(updates.blocking ? 1 : 0)
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?')
      values.push(updates.priority)
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?')
      values.push(updates.enabled ? 1 : 0)
    }
    if (updates.meta !== undefined) {
      fields.push('meta_json = ?')
      values.push(JSON.stringify(updates.meta))
    }

    if (fields.length === 0) return

    fields.push('updated_at = ?')
    values.push(now)
    values.push(id)

    db.prepare(`
      UPDATE agent_triggers SET ${fields.join(', ')} WHERE id = ?
    `).run(...values)
  }

  async deleteTrigger(id: string): Promise<void> {
    const db = await this.getDatabase()
    db.prepare('DELETE FROM agent_triggers WHERE id = ?').run(id)
  }

  async listTriggers(filters?: TriggerFilters): Promise<TriggerDefinition[]> {
    const db = await this.getDatabase()
    const conditions: string[] = []
    const values: unknown[] = []

    if (filters?.enabled !== undefined) {
      conditions.push('enabled = ?')
      values.push(filters.enabled ? 1 : 0)
    }

    if (filters?.module) {
      conditions.push('module = ?')
      values.push(filters.module)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limitClause = filters?.limit ? `LIMIT ${filters.limit}` : ''

    const rows = db.prepare(`
      SELECT * FROM agent_triggers
      ${whereClause}
      ORDER BY priority DESC, hit_count DESC
      ${limitClause}
    `).all<{
      id: string
      label: string
      module: string | null
      pattern: string
      pattern_flags: string
      blocking: number
      priority: number
      enabled: number
      hit_count: number
      last_hit_at: number | null
      created_at: number
      updated_at: number
      meta_json: string
    }>(...values)

    return rows.map((row) => this.mapTriggerRow(row))
  }

  // ============================================================
  // Trigger-Memory Associations
  // ============================================================

  async addTriggerRef(triggerId: string, memoryId: string, priority = 0): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    db.prepare(`
      INSERT INTO agent_trigger_refs (trigger_id, memory_id, priority, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(trigger_id, memory_id) DO UPDATE SET priority = excluded.priority
    `).run(triggerId, memoryId, priority, now)
  }

  async removeTriggerRef(triggerId: string, memoryId: string): Promise<void> {
    const db = await this.getDatabase()
    db.prepare(`
      DELETE FROM agent_trigger_refs WHERE trigger_id = ? AND memory_id = ?
    `).run(triggerId, memoryId)
  }

  async getTriggerRefs(triggerId: string): Promise<MemoryEntry[]> {
    const db = await this.getDatabase()
    const rows = db.prepare(`
      SELECT m.* FROM agent_memory_metadata m
      INNER JOIN agent_trigger_refs r ON m.id = r.memory_id
      WHERE r.trigger_id = ?
      ORDER BY r.priority DESC, m.priority DESC
    `).all<{
      id: string
      layer: MemoryLayer
      scope_id: string | null
      category: MemoryCategory
      title: string
      summary: string | null
      content_key: string
      priority: number
      access_count: number
      last_accessed_at: number | null
      created_at: number
      updated_at: number
      expires_at: number | null
      archived_at: number | null
      tags: string | null
      meta_json: string
    }>(triggerId)

    return rows.map((row) => this.mapMemoryRow(row))
  }

  // ============================================================
  // Access Tracking
  // ============================================================

  async recordAccess(memoryId: string, scopeId?: string, contextChars?: number): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const id = `access-${randomUUID()}`

    db.prepare(`
      INSERT INTO agent_memory_access_log (id, memory_id, scope_id, accessed_at, context_chars, was_useful)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, memoryId, scopeId ?? null, now, contextChars ?? null, 0)
  }

  async incrementAccessCount(memoryId: string): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    db.prepare(`
      UPDATE agent_memory_metadata
      SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, memoryId)
  }

  async incrementTriggerHitCount(triggerId: string): Promise<void> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    db.prepare(`
      UPDATE agent_triggers
      SET hit_count = hit_count + 1, last_hit_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, triggerId)
  }

  // ============================================================
  // Lifecycle Management
  // ============================================================

  async getExpiredMemories(): Promise<MemoryEntry[]> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    const rows = db.prepare(`
      SELECT * FROM agent_memory_metadata
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND archived_at IS NULL
    `).all<{
      id: string
      layer: MemoryLayer
      scope_id: string | null
      category: MemoryCategory
      title: string
      summary: string | null
      content_key: string
      priority: number
      access_count: number
      last_accessed_at: number | null
      created_at: number
      updated_at: number
      expires_at: number | null
      archived_at: number | null
      tags: string | null
      meta_json: string
    }>(now)

    return rows.map((row) => this.mapMemoryRow(row))
  }

  async archiveExpiredMemories(): Promise<number> {
    const db = await this.getDatabase()
    const now = Math.floor(Date.now() / 1000)

    const result = db.prepare(`
      UPDATE agent_memory_metadata
      SET archived_at = ?, updated_at = ?
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND archived_at IS NULL
    `).run(now, now, now)

    return (result as { changes?: number }).changes || 0
  }

  async pruneArchivedMemories(olderThanDays: number): Promise<number> {
    const db = await this.getDatabase()
    const cutoffTime = Math.floor(Date.now() / 1000) - (olderThanDays * 86400)

    const result = db.prepare(`
      DELETE FROM agent_memory_metadata
      WHERE archived_at IS NOT NULL AND archived_at <= ?
    `).run(cutoffTime)

    return (result as { changes?: number }).changes || 0
  }

  // ============================================================
  // Analytics
  // ============================================================

  async getMemoryStats(): Promise<MemoryStats> {
    const db = await this.getDatabase()

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM agent_memory_metadata WHERE archived_at IS NULL
    `).get<{ count: number }>()

    const byLayer = db.prepare(`
      SELECT layer, COUNT(*) as count FROM agent_memory_metadata
      WHERE archived_at IS NULL GROUP BY layer
    `).all<{ layer: MemoryLayer; count: number }>()

    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count FROM agent_memory_metadata
      WHERE archived_at IS NULL GROUP BY category
    `).all<{ category: MemoryCategory; count: number }>()

    const archived = db.prepare(`
      SELECT COUNT(*) as count FROM agent_memory_metadata WHERE archived_at IS NOT NULL
    `).get<{ count: number }>()

    const avgAccess = db.prepare(`
      SELECT AVG(access_count) as avg FROM agent_memory_metadata WHERE archived_at IS NULL
    `).get<{ avg: number }>()

    return {
      totalMemories: total?.count || 0,
      byLayer: {
        l0: byLayer.find((r) => r.layer === 'l0')?.count || 0,
        l1: byLayer.find((r) => r.layer === 'l1')?.count || 0,
        l2: byLayer.find((r) => r.layer === 'l2')?.count || 0,
      },
      byCategory: {
        summary: byCategory.find((r) => r.category === 'summary')?.count || 0,
        learning: byCategory.find((r) => r.category === 'learning')?.count || 0,
        trigger: byCategory.find((r) => r.category === 'trigger')?.count || 0,
        rule: byCategory.find((r) => r.category === 'rule')?.count || 0,
      },
      archivedCount: archived?.count || 0,
      avgAccessCount: avgAccess?.avg || 0,
    }
  }

  async getTriggerStats(): Promise<TriggerStats[]> {
    const db = await this.getDatabase()

    const rows = db.prepare(`
      SELECT
        t.id,
        t.label,
        t.hit_count as hitCount,
        t.last_hit_at as lastHitAt,
        COUNT(r.memory_id) as memoryCount
      FROM agent_triggers t
      LEFT JOIN agent_trigger_refs r ON t.id = r.trigger_id
      WHERE t.enabled = 1
      GROUP BY t.id
      ORDER BY t.hit_count DESC
    `).all<TriggerStats>()

    return rows
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  private mapMemoryRow(row: {
    id: string
    layer: MemoryLayer
    scope_id: string | null
    category: MemoryCategory
    title: string
    summary: string | null
    content_key: string
    priority: number
    access_count: number
    last_accessed_at: number | null
    created_at: number
    updated_at: number
    expires_at: number | null
    archived_at: number | null
    tags: string | null
    meta_json: string
  }): MemoryEntry {
    return {
      id: row.id,
      layer: row.layer,
      scopeId: row.scope_id,
      category: row.category,
      title: row.title,
      summary: row.summary,
      contentKey: row.content_key,
      priority: row.priority,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      archivedAt: row.archived_at,
      tags: row.tags ? JSON.parse(row.tags) : null,
      meta: JSON.parse(row.meta_json),
    }
  }

  private mapTriggerRow(row: {
    id: string
    label: string
    module: string | null
    pattern: string
    pattern_flags: string
    blocking: number
    priority: number
    enabled: number
    hit_count: number
    last_hit_at: number | null
    created_at: number
    updated_at: number
    meta_json: string
  }): TriggerDefinition {
    return {
      id: row.id,
      label: row.label,
      module: row.module,
      pattern: row.pattern,
      patternFlags: row.pattern_flags,
      blocking: Boolean(row.blocking),
      priority: row.priority,
      enabled: Boolean(row.enabled),
      hitCount: row.hit_count,
      lastHitAt: row.last_hit_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      meta: JSON.parse(row.meta_json),
    }
  }
}
