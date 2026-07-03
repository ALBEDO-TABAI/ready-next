import { createHash } from 'crypto'
import type { BeliefCardStore } from './belief-card-store'

/**
 * Belief card DB mirror (EP1-K2). The cards are FILE-truth; this is a one-way
 * file → DB index projection into agent_memory_metadata (belief rows). The
 * mirror exists for indexing / access-count / future recall — it is never the
 * source of truth, and a content_hash detects drift so re-sync recomputes
 * from the file. Invalid (unparseable) cards are recorded as `status:invalid`
 * rows and NEVER dropped.
 *
 * Operates on a minimal db interface so it unit-tests with a fake (host-node
 * cannot load the electron-ABI better-sqlite3).
 */

export interface MirrorStatement {
  run(...params: unknown[]): unknown
  get<R = unknown>(...params: unknown[]): R | undefined
  all<R = unknown>(...params: unknown[]): R[]
}

export interface MirrorDb {
  prepare(sql: string): MirrorStatement
}

export interface BeliefCardMirrorRow {
  id: string
  slug: string | null
  confidence: string | null
  file_path: string | null
  status: string | null
  content_hash: string | null
  title: string
  summary: string | null
  scope_id: string | null
}

/** slug = filename without `.md`; mirror id namespaced to avoid collisions. */
function slugFromRelPath(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/, '')
}

function mirrorId(relPath: string): string {
  return `belief:${relPath}`
}

export function hashCardContent(title: string, description: string, body: string): string {
  return createHash('sha256').update(`${title}\n${description}\n${body}`).digest('hex')
}

const UPSERT_SQL = `
  INSERT INTO agent_memory_metadata
    (id, layer, scope_id, category, title, summary, content_key,
     slug, confidence, file_path, status, content_hash, updated_at)
  VALUES
    (@id, 'l2', @scope_id, 'belief', @title, @summary, @content_key,
     @slug, @confidence, @file_path, @status, @content_hash, unixepoch())
  ON CONFLICT(id) DO UPDATE SET
    scope_id = excluded.scope_id,
    title = excluded.title,
    summary = excluded.summary,
    content_key = excluded.content_key,
    slug = excluded.slug,
    confidence = excluded.confidence,
    file_path = excluded.file_path,
    status = excluded.status,
    content_hash = excluded.content_hash,
    updated_at = unixepoch()
`

/** Upsert a single belief mirror row keyed by file path. */
export function upsertBeliefCardMirror(
  db: MirrorDb,
  params: {
    relPath: string
    scopeId?: string | null
    title: string
    summary: string | null
    confidence: string | null
    status: string
    contentHash: string | null
  },
): void {
  db.prepare(UPSERT_SQL).run({
    id: mirrorId(params.relPath),
    scope_id: params.scopeId ?? 'global',
    title: params.title,
    summary: params.summary,
    content_key: params.relPath,
    slug: slugFromRelPath(params.relPath),
    confidence: params.confidence,
    file_path: params.relPath,
    status: params.status,
    content_hash: params.contentHash,
  })
}

/** Query a belief mirror row by its full relPath (the mirror primary key
 *  derives from relPath — basename slugs can collide across dirs, EP2-K6). */
export function getBeliefCardMirrorByRelPath(db: MirrorDb, relPath: string): BeliefCardMirrorRow | null {
  const row = db
    .prepare(
      `SELECT id, slug, confidence, file_path, status, content_hash, title, summary, scope_id
       FROM agent_memory_metadata WHERE category = 'belief' AND file_path = ? LIMIT 1`,
    )
    .get<BeliefCardMirrorRow>(relPath)
  return row ?? null
}

/**
 * P2-4 (2026-07-03) — bump access_count (+ last_accessed_at) for the belief
 * mirror rows that were just injected into a prompt. Without this the mirror's
 * access_count stays 0, so decay signals (belief-decay.ts) and "is this belief
 * ever used?" metrics can't be computed. Bounded to category='belief' rows;
 * missing relPaths are silently ignored (file exists but not yet mirrored).
 * Returns the number of rows updated.
 */
export function bumpBeliefCardAccess(db: MirrorDb, relPaths: readonly string[]): number {
  const unique = Array.from(new Set(relPaths.map((p) => String(p || '').trim()).filter(Boolean)))
  if (unique.length === 0) return 0
  const stmt = db.prepare(
    `UPDATE agent_memory_metadata
       SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = unixepoch()
     WHERE category = 'belief' AND file_path = ?`,
  )
  let updated = 0
  for (const relPath of unique) {
    const info = stmt.run(relPath) as { changes?: number }
    updated += Number(info?.changes || 0)
  }
  return updated
}

/**
 * P5d (2026-07-03) — read a belief card's usage stats for the decay round.
 * access_count is bumped at injection (P2-4). was_useful_count has no mirror
 * column yet, so it is reported as 0 (decay still works: it decays only on the
 * conjunction stale+no-backlinks+no-access, and access_count is real).
 */
export function readBeliefCardAccessStats(db: MirrorDb, relPath: string): { accessCount: number; wasUsefulCount: number } | null {
  const row = db
    .prepare(`SELECT access_count FROM agent_memory_metadata WHERE category = 'belief' AND file_path = ? LIMIT 1`)
    .get<{ access_count: number | null }>(relPath)
  if (!row) return null
  return { accessCount: Number(row.access_count || 0), wasUsefulCount: 0 }
}

/** Query a belief mirror row by slug (filename without `.md`). */
export function getBeliefCardMirrorBySlug(db: MirrorDb, slug: string): BeliefCardMirrorRow | null {
  const row = db
    .prepare(
      `SELECT id, slug, confidence, file_path, status, content_hash, title, summary, scope_id
       FROM agent_memory_metadata WHERE category = 'belief' AND slug = ? LIMIT 1`,
    )
    .get<BeliefCardMirrorRow>(slug)
  return row ?? null
}

/**
 * Re-project every card file under the store into DB mirror rows. File wins:
 * row title/summary/status/content_hash always recomputed from the file.
 * Unparseable files become `status:invalid` rows (kept, not dropped).
 * Returns counts. Does NOT touch startup wiring (K6, phase 2).
 */
export function syncBeliefCards(
  db: MirrorDb,
  store: BeliefCardStore,
): { synced: number; invalid: number } {
  let synced = 0
  let invalid = 0
  // EP4-K-mirror — every scope syncs, and the scope is WRITTEN THROUGH:
  // agent cards land as scope_id 'agent:<id>' (04 §2), never 'global'.
  for (const { relPath, card, scopeId } of store.listAllCardFilesAllScopes()) {
    if (!card) {
      upsertBeliefCardMirror(db, {
        relPath,
        scopeId,
        title: relPath,
        summary: null,
        confidence: null,
        status: 'invalid',
        contentHash: null,
      })
      invalid += 1
      continue
    }
    upsertBeliefCardMirror(db, {
      relPath,
      scopeId,
      title: card.frontmatter.title,
      summary: card.frontmatter.description,
      confidence: card.frontmatter.confidence,
      status: card.frontmatter.status,
      contentHash: hashCardContent(
        card.frontmatter.title,
        card.frontmatter.description,
        card.body,
      ),
    })
    synced += 1
  }
  return { synced, invalid }
}
