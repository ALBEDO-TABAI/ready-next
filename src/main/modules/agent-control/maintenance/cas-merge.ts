/**
 * EP3-C4 — user-picture CAS merge (03 §4, contract v3 P1-②).
 *
 * The CAS protocol acts on DB TRUTH, never on a file: snapshot-read the
 * picture row → in-memory merge (≤40 lines) → conditional write inside ONE
 * transaction where the live row hash must still equal the snapshot hash.
 * A mismatch is a BENIGN skip (exit-0 semantics + audit row) — two
 * interleaved writers commit exactly one merge, the loser leaves no
 * half-state. The 03 §4 temp-file→rename protocol survives ONLY in the
 * USER.md mirror-sync fallback substep (DB has no profile row, so loadUSER
 * would fall back to the file) — it is never the main write path.
 *
 * Truth alignment (HEAD: loadUSER reads user_profiles → resident_user
 * memories → USER.md fallback): the merge writes the picture content row
 * (agent_knowledge, fixed contentKey) plus its resident_user metadata row,
 * which is exactly what the DB-first loadUSER path renders. 写了但主路径
 * 不读 = 违约，由行为测试钉住。
 *
 * Decision gate is CODE: pure project-work observations never enter the
 * picture, and an all-rejected round touches ZERO database state
 * (不为了写而抢锁).
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { logAgentMetric } from '../metrics'

export const PICTURE_LINE_CAP = 40

export function userPictureContentKey(userId: string): string {
  return `user-picture:${userId}`
}

export function userPictureMemoryId(userId: string): string {
  return `mem-user-picture-${userId}`
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

// ---------------------------------------------------------------- gate

export type PictureObservationKind = 'preference' | 'habit' | 'communication_style' | 'identity'

export interface PictureObservation {
  text: string
  kind: PictureObservationKind | string
}

const PICTURE_KINDS: ReadonlyArray<string> = ['preference', 'habit', 'communication_style', 'identity']

// High-precision project-work signals: file paths, commit hashes, work-item
// ids, build/verify commands. Anything matching stays OUT of the picture
// regardless of its declared kind.
const PROJECT_SIGNALS: ReadonlyArray<RegExp> = [
  /(^|[\s（(])(src|docs|assets|scripts|node_modules)\//,
  /[\w-]+\.(ts|tsx|js|cjs|mjs|json|md|sql)(\b|$)/i,
  /\b[0-9a-f]{8,40}\b/,
  /\bEP\d+-[A-Za-z]+\d*/,
  /npm run |typecheck|verify:|git (commit|push|rebase)/,
]

export interface PictureGateResult {
  accepted: PictureObservation[]
  rejected: Array<{ observation: PictureObservation; reason: string }>
}

/** 纯项目工作不进画像 — code judgment, not a model call. */
export function filterPictureObservations(observations: ReadonlyArray<PictureObservation>): PictureGateResult {
  const accepted: PictureObservation[] = []
  const rejected: PictureGateResult['rejected'] = []
  for (const observation of observations) {
    const text = String(observation?.text || '').trim()
    if (!text) {
      rejected.push({ observation, reason: 'empty' })
      continue
    }
    if (!PICTURE_KINDS.includes(String(observation.kind))) {
      rejected.push({ observation, reason: `kind_not_picture:${String(observation.kind)}` })
      continue
    }
    const signal = PROJECT_SIGNALS.find((pattern) => pattern.test(text))
    if (signal) {
      rejected.push({ observation, reason: 'project_work_signal' })
      continue
    }
    accepted.push({ ...observation, text })
  }
  return { accepted, rejected }
}

// ---------------------------------------------------------------- merge

/** Dedup-append merge with the hard line cap. Existing lines keep priority
 *  (画像稳定优先), overflow is dropped and reported. */
export function mergePictureLines(
  current: string | null,
  accepted: ReadonlyArray<PictureObservation>,
): { text: string; addedCount: number; droppedCount: number } {
  const lines = (current ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  const seen = new Set(lines)
  let added = 0
  let dropped = 0
  for (const observation of accepted) {
    const line = `- [${observation.kind}] ${observation.text.replace(/\n+/g, ' ')}`
    if (seen.has(line)) continue
    if (lines.length >= PICTURE_LINE_CAP) {
      dropped += 1
      continue
    }
    lines.push(line)
    seen.add(line)
    added += 1
  }
  return { text: lines.join('\n'), addedCount: added, droppedCount: dropped }
}

// ---------------------------------------------------------------- store

/** Minimal raw-db port (better-sqlite3 shaped; fake-db paradigm in tests). */
export interface CasMergeDb {
  exec(sql: string): void
  prepare(sql: string): {
    get<R>(...params: unknown[]): R | undefined
    run(...params: unknown[]): unknown
    all<R>(...params: unknown[]): R[]
  }
}

export interface UserMdMirrorPort {
  read(): string
  /** MUST implement the 03 §4 temp-file→rename protocol. */
  writeAtomic(text: string): void
}

export interface CasMergeDeps {
  db: CasMergeDb
  userId: string
  observations: ReadonlyArray<PictureObservation>
  now: Date
  /** USER.md mirror — consulted ONLY when user_profiles has no row. */
  mirror?: UserMdMirrorPort
}

export interface CasMergeReport {
  decision: 'merged' | 'cas_skip' | 'gate_skip' | 'error'
  reason: string
  accepted: number
  rejected: number
  addedCount: number
  droppedCount: number
  mirrorSynced: boolean
}

/** agent_knowledge is keyed (agent_name, key) — the CAS snapshot/live reads
 *  MUST address the exact row the conditional write targets, or the hash
 *  comparison guards the wrong truth. */
const PICTURE_AGENT_NAME = 'memory'

function readPictureValue(db: CasMergeDb, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM agent_knowledge WHERE agent_name = ? AND key = ?')
    .get<{ value: string }>(PICTURE_AGENT_NAME, key)
  return row?.value ?? null
}

const MIRROR_BEGIN = '<!-- READY:USER-PICTURE:BEGIN -->'
const MIRROR_END = '<!-- READY:USER-PICTURE:END -->'

/** Replace (or append) the marked picture section — never the whole file:
 *  USER.md may carry user-authored content outside the markers. */
export function renderMirrorDocument(existing: string, pictureText: string): string {
  const block = `${MIRROR_BEGIN}\n## 用户画像（维护回合合并）\n${pictureText}\n${MIRROR_END}`
  const begin = existing.indexOf(MIRROR_BEGIN)
  const end = existing.indexOf(MIRROR_END)
  if (begin >= 0 && end > begin) {
    return existing.slice(0, begin) + block + existing.slice(end + MIRROR_END.length)
  }
  return existing.trim().length > 0 ? `${existing.replace(/\n+$/, '')}\n\n${block}\n` : `${block}\n`
}

/** Default USER.md mirror — 03 §4 temp-file→rename, fallback substep only. */
export function createUserMdMirrorPort(memoryRoot: string): UserMdMirrorPort {
  const target = join(memoryRoot, 'USER.md')
  return {
    read(): string {
      return existsSync(target) ? readFileSync(target, 'utf-8') : ''
    },
    writeAtomic(text: string): void {
      const tmp = `${target}.tmp-${randomUUID()}`
      writeFileSync(tmp, text, 'utf-8')
      renameSync(tmp, target)
    },
  }
}

export function runUserPictureCasMerge(deps: CasMergeDeps): CasMergeReport {
  const gate = filterPictureObservations(deps.observations)
  const base = {
    accepted: gate.accepted.length,
    rejected: gate.rejected.length,
    addedCount: 0,
    droppedCount: 0,
    mirrorSynced: false,
  }
  // 不为了写而抢锁: nothing picture-worthy → zero DB access of any kind.
  if (gate.accepted.length === 0) {
    const report: CasMergeReport = { decision: 'gate_skip', reason: 'no_picture_observations', ...base }
    logAgentMetric('cas_merge_audit', { ...report })
    return report
  }

  const key = userPictureContentKey(deps.userId)
  const nowSec = Math.floor(deps.now.getTime() / 1000)
  let report: CasMergeReport
  try {
    // snapshot OUTSIDE the transaction — the conditional write re-reads.
    const snapshotValue = readPictureValue(deps.db, key)
    const snapshotHash = sha256(snapshotValue ?? '')
    const merged = mergePictureLines(snapshotValue, gate.accepted)

    if (merged.addedCount === 0) {
      report = { decision: 'gate_skip', reason: 'all_duplicates', ...base, droppedCount: merged.droppedCount }
      logAgentMetric('cas_merge_audit', { ...report })
      return report
    }

    deps.db.exec('BEGIN IMMEDIATE')
    try {
      const liveValue = readPictureValue(deps.db, key)
      if (sha256(liveValue ?? '') !== snapshotHash) {
        deps.db.exec('ROLLBACK')
        report = { decision: 'cas_skip', reason: 'row_hash_moved', ...base }
        logAgentMetric('cas_merge_audit', { ...report })
        return report
      }
      deps.db.prepare(
        `INSERT INTO agent_knowledge (id, agent_name, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(`kn-${randomUUID()}`, PICTURE_AGENT_NAME, key, merged.text, nowSec, nowSec)
      const metadataExists = deps.db
        .prepare('SELECT id FROM agent_memory_metadata WHERE id = ?')
        .get<{ id: string }>(userPictureMemoryId(deps.userId))
      if (metadataExists) {
        deps.db.prepare('UPDATE agent_memory_metadata SET summary = ?, updated_at = ? WHERE id = ?')
          .run(merged.text.split('\n')[0]?.slice(0, 100) ?? '', nowSec, userPictureMemoryId(deps.userId))
      } else {
        deps.db.prepare(
          `INSERT INTO agent_memory_metadata (
            id, layer, scope_id, user_id, source_type, category, title, summary, content_key,
            priority, access_count, last_accessed_at, created_at, updated_at,
            expires_at, archived_at, tags, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          userPictureMemoryId(deps.userId), 'l0', null, deps.userId, 'resident_user', 'summary',
          '用户画像', merged.text.split('\n')[0]?.slice(0, 100) ?? '', key,
          1, 0, null, nowSec, nowSec, null, null, null, '{}',
        )
      }
      deps.db.exec('COMMIT')
    } catch (error) {
      try { deps.db.exec('ROLLBACK') } catch { /* already closed */ }
      throw error
    }

    // mirror fallback: ONLY when the DB-first loadUSER path has no profile
    // row to render (it would fall back to reading USER.md).
    let mirrorSynced = false
    if (deps.mirror) {
      const profileRow = deps.db
        .prepare('SELECT id FROM user_profiles WHERE id = ?')
        .get<{ id: string }>(deps.userId)
      if (!profileRow) {
        deps.mirror.writeAtomic(renderMirrorDocument(deps.mirror.read(), merged.text))
        mirrorSynced = true
      }
    }

    report = {
      decision: 'merged', reason: 'cas_ok', ...base,
      addedCount: merged.addedCount, droppedCount: merged.droppedCount, mirrorSynced,
    }
  } catch (error) {
    // maintenance must not crash the caller — audit and exit-0.
    report = {
      decision: 'error',
      reason: `db_error:${error instanceof Error ? error.message : String(error)}`,
      ...base,
    }
  }
  logAgentMetric('cas_merge_audit', { ...report })
  return report
}
