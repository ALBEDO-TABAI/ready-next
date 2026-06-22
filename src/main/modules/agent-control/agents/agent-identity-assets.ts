import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { dirname, resolve, sep } from 'path'

import type { BeliefCardStore } from '../knowledge/belief-card-store'
import { isValidAgentSlug } from '../../../../shared/agent-identity'

interface AgentIdentityDbStatement {
  all<T = unknown>(...params: unknown[]): T[]
  run(...params: unknown[]): unknown
}

interface AgentIdentityDb {
  prepare(sql: string): AgentIdentityDbStatement
}

interface AgentIdentityMigrationRow {
  id: string
  old_agent_id: string | null
  new_agent_id: string | null
}

function absInside(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`[agent-identity-assets] path escapes memory root: ${relPath}`)
  }
  return abs
}

function moveIfPossible(root: string, fromRelPath: string, toRelPath: string): void {
  const from = absInside(root, fromRelPath)
  const to = absInside(root, toRelPath)
  if (!existsSync(from) || existsSync(to)) return
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

export function reconcileAgentIdentityAssets(db: AgentIdentityDb, store: BeliefCardStore): number {
  const rows = db.prepare(`
    SELECT id, old_agent_id, new_agent_id
    FROM agent_identity_migration
    WHERE kind = 'reserved_slug_reassigned'
      AND asset_reconciled_at IS NULL
  `).all<AgentIdentityMigrationRow>()
  let reconciled = 0
  for (const row of rows) {
    const oldId = String(row.old_agent_id || '').trim()
    const newId = String(row.new_agent_id || '').trim()
    if (!isValidAgentSlug(oldId) || !isValidAgentSlug(newId)) continue
    moveIfPossible(store.rootPath, `agents/${oldId}`, `agents/${newId}`)
    moveIfPossible(store.rootPath, `knowledge/routing-${oldId}.md`, `knowledge/routing-${newId}.md`)
    db.prepare('UPDATE agent_identity_migration SET asset_reconciled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id)
    reconciled += 1
  }
  return reconciled
}

export function deleteAgentIdentityAssets(store: BeliefCardStore, agentId: string): void {
  const id = String(agentId || '').trim()
  if (!isValidAgentSlug(id)) throw new Error('[agent-identity-assets] invalid agent id')
  rmSync(absInside(store.rootPath, `agents/${id}`), { recursive: true, force: true })
  rmSync(absInside(store.rootPath, `knowledge/routing-${id}.md`), { force: true })
}
