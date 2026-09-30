import type { DatabaseConnection } from '../../database/connection'
import { randomUUID } from 'node:crypto'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'

import { hashSpecialistBlueprintReviewContent } from './specialist-blueprint-review-content'

interface SpecialistBlueprintConfirmationStoreOptions {
  getRawDb?: () => DatabaseConnection | null
}

export interface SpecialistBlueprintConfirmationToken {
  id: string
  blueprintId: string
  sessionId: string
  runId: string | null
  blueprintHash: string
  createdAt: string
  usedAt: string | null
}

interface SpecialistBlueprintConfirmationRow {
  token_id: string
  blueprint_id: string
  session_id: string
  run_id: string | null
  blueprint_hash: string
  created_at: string
  used_at: string | null
}

export function hashSpecialistBlueprintForConfirmation(blueprint: SpecialistAgentBlueprint): string {
  return hashSpecialistBlueprintReviewContent(blueprint)
}

export class SpecialistBlueprintConfirmationStore {
  private readonly tokens = new Map<string, SpecialistBlueprintConfirmationToken>()
  private readonly getRawDb?: () => DatabaseConnection | null

  constructor(options: SpecialistBlueprintConfirmationStoreOptions = {}) {
    this.getRawDb = options.getRawDb
  }

  issue(input: {
    blueprintId: string
    sessionId: string
    blueprintHash: string
    runId?: string | null
    now?: Date
  }): SpecialistBlueprintConfirmationToken {
    const blueprintId = String(input.blueprintId || '').trim()
    const sessionId = String(input.sessionId || '').trim()
    if (!blueprintId) throw new Error('[specialist-blueprint-confirmation] blueprintId is required')
    if (!sessionId) throw new Error('[specialist-blueprint-confirmation] sessionId is required')
    const token: SpecialistBlueprintConfirmationToken = {
      id: randomUUID(),
      blueprintId,
      sessionId,
      runId: input.runId ? String(input.runId).trim() : null,
      blueprintHash: String(input.blueprintHash || '').trim(),
      createdAt: (input.now ?? new Date()).toISOString(),
      usedAt: null,
    }
    if (!token.blueprintHash) throw new Error('[specialist-blueprint-confirmation] blueprintHash is required')

    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) throw new Error('[specialist-blueprint-confirmation] database not available')
      db.prepare(
        `INSERT INTO specialist_blueprint_confirmations (
          token_id,
          blueprint_id,
          session_id,
          run_id,
          blueprint_hash,
          created_at,
          used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        token.id,
        token.blueprintId,
        token.sessionId,
        token.runId,
        token.blueprintHash,
        token.createdAt,
        token.usedAt,
      )
      return { ...token }
    }

    this.tokens.set(token.id, token)
    return token
  }

  validate(input: {
    tokenId: string
    blueprintId: string
    sessionId: string
    blueprintHash: string
    runId?: string | null
  }): SpecialistBlueprintConfirmationToken {
    const token = this.readToken(String(input.tokenId || '').trim())
    if (!token) throw new Error('[specialist-blueprint-confirmation] token not found')
    if (token.usedAt) throw new Error('[specialist-blueprint-confirmation] token already used')
    if (token.blueprintId !== String(input.blueprintId || '').trim()) {
      throw new Error('[specialist-blueprint-confirmation] token blueprint mismatch')
    }
    if (token.sessionId !== String(input.sessionId || '').trim()) {
      throw new Error('[specialist-blueprint-confirmation] token session mismatch')
    }
    const runId = input.runId ? String(input.runId).trim() : null
    if (token.runId !== runId) throw new Error('[specialist-blueprint-confirmation] token run mismatch')
    if (token.blueprintHash !== String(input.blueprintHash || '').trim()) {
      throw new Error('[specialist-blueprint-confirmation] token blueprint content mismatch')
    }
    return { ...token }
  }

  consume(input: {
    tokenId: string
    blueprintId: string
    sessionId: string
    blueprintHash: string
    runId?: string | null
    now?: Date
  }): SpecialistBlueprintConfirmationToken {
    if (this.getRawDb && !this.resolveDb()) {
      throw new Error('[specialist-blueprint-confirmation] database not available')
    }
    const token = this.validate(input)
    const used = { ...token, usedAt: (input.now ?? new Date()).toISOString() }
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) throw new Error('[specialist-blueprint-confirmation] database not available')
      const result = db.prepare(
        `UPDATE specialist_blueprint_confirmations
         SET used_at = ?
         WHERE token_id = ? AND used_at IS NULL`,
      ).run(used.usedAt, token.id) as { changes?: number } | undefined
      if ((result?.changes ?? 0) !== 1) {
        throw new Error('[specialist-blueprint-confirmation] token already used')
      }
      return { ...used }
    }

    this.tokens.set(token.id, used)
    return used
  }

  private resolveDb(): DatabaseConnection | null {
    return this.getRawDb ? this.getRawDb() : null
  }

  private readToken(tokenId: string): SpecialistBlueprintConfirmationToken | null {
    const db = this.resolveDb()
    if (this.getRawDb) {
      if (!db) return null
      const row = db.prepare(
        `SELECT token_id, blueprint_id, session_id, run_id, blueprint_hash, created_at, used_at
         FROM specialist_blueprint_confirmations
         WHERE token_id = ?`,
      ).get<SpecialistBlueprintConfirmationRow>(tokenId)
      return row ? {
        id: row.token_id,
        blueprintId: row.blueprint_id,
        sessionId: row.session_id,
        runId: row.run_id,
        blueprintHash: row.blueprint_hash,
        createdAt: row.created_at,
        usedAt: row.used_at,
      } : null
    }
    return this.tokens.get(tokenId) ?? null
  }
}
