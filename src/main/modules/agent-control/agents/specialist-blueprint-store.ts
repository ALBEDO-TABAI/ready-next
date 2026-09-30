import type { DatabaseConnection } from '../../database/connection'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintStatus,
} from '../../../../shared/agent-specialist-blueprint'


interface SpecialistBlueprintStoreOptions {
  getRawDb?: () => DatabaseConnection | null
}

interface SpecialistBlueprintRow {
  blueprint_id: string
  content_json: string
}

function cloneBlueprint(blueprint: SpecialistAgentBlueprint): SpecialistAgentBlueprint {
  return JSON.parse(JSON.stringify(blueprint)) as SpecialistAgentBlueprint
}

export class SpecialistBlueprintStore {
  private readonly blueprints = new Map<string, SpecialistAgentBlueprint>()
  private readonly getRawDb?: () => DatabaseConnection | null

  constructor(options: SpecialistBlueprintStoreOptions = {}) {
    this.getRawDb = options.getRawDb
  }

  list(statuses?: readonly SpecialistBlueprintStatus[]): SpecialistAgentBlueprint[] {
    if (statuses && statuses.length === 0) return []
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) return []
      const rows = statuses?.length
        ? db.prepare(
          `SELECT blueprint_id, content_json
           FROM specialist_blueprints
           WHERE status IN (${statuses.map(() => '?').join(', ')})
           ORDER BY blueprint_id ASC`,
        ).all<SpecialistBlueprintRow>(...statuses)
        : db.prepare(
          `SELECT blueprint_id, content_json
           FROM specialist_blueprints
           ORDER BY blueprint_id ASC`,
        ).all<SpecialistBlueprintRow>()
      return rows.map((row) => this.parseBlueprint(row))
    }

    const allowed = statuses ? new Set(statuses) : null
    return [...this.blueprints.values()]
      .filter((blueprint) => !allowed || allowed.has(blueprint.status))
      .map(cloneBlueprint)
      .sort((a, b) => a.blueprintId.localeCompare(b.blueprintId))
  }

  get(blueprintId: string): SpecialistAgentBlueprint | null {
    const id = String(blueprintId || '').trim()
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) return null
      const row = db.prepare(
        `SELECT blueprint_id, content_json
         FROM specialist_blueprints
         WHERE blueprint_id = ?`,
      ).get<SpecialistBlueprintRow>(id)
      return row ? this.parseBlueprint(row) : null
    }

    const blueprint = this.blueprints.get(id)
    return blueprint ? cloneBlueprint(blueprint) : null
  }

  upsert(blueprint: SpecialistAgentBlueprint): SpecialistAgentBlueprint {
    const blueprintId = String(blueprint.blueprintId || '').trim()
    if (!blueprintId) throw new Error('[specialist-blueprint-store] blueprintId is required')
    const next = cloneBlueprint({ ...blueprint, blueprintId })

    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) throw new Error('[specialist-blueprint-store] database not available')
      db.prepare(
        `INSERT INTO specialist_blueprints (
          blueprint_id,
          status,
          specialist_id,
          source,
          content_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(blueprint_id) DO UPDATE SET
          status = excluded.status,
          specialist_id = excluded.specialist_id,
          source = excluded.source,
          content_json = excluded.content_json,
          updated_at = excluded.updated_at`,
      ).run(
        next.blueprintId,
        next.status,
        next.specialistId,
        next.source,
        JSON.stringify(next),
        new Date().toISOString(),
      )
      return cloneBlueprint(next)
    }

    this.blueprints.set(blueprintId, next)
    return cloneBlueprint(next)
  }

  patch(
    blueprintId: string,
    patch: Partial<SpecialistAgentBlueprint>,
  ): SpecialistAgentBlueprint {
    const id = String(blueprintId || '').trim()
    const db = this.resolveDb()
    if (this.getRawDb && !db) {
      throw new Error('[specialist-blueprint-store] database not available')
    }
    const current = this.get(id)
    if (!current) throw new Error('[specialist-blueprint-store] blueprint not found')
    const next = cloneBlueprint({
      ...current,
      ...patch,
      blueprintId: id,
    })
    if (this.getRawDb) {
      return this.upsert(next)
    }

    this.blueprints.set(id, next)
    return cloneBlueprint(next)
  }

  private resolveDb(): DatabaseConnection | null {
    return this.getRawDb ? this.getRawDb() : null
  }

  private parseBlueprint(row: SpecialistBlueprintRow): SpecialistAgentBlueprint {
    try {
      return cloneBlueprint(JSON.parse(row.content_json) as SpecialistAgentBlueprint)
    } catch (error) {
      throw new Error(
        `[specialist-blueprint-store] invalid stored blueprint ${row.blueprint_id}: ${(error as Error).message}`,
      )
    }
  }
}
