import { parseReadyUri, ReadyRefSchema, toReadyUri } from '../../../shared/ready-ref'
import { originalFromSeconds } from '../calendar-engine/calendar-row-codec'
import type { MigrationDatabase } from '../migrations'

interface IndexRow {
  id: number
  workspace_id: number
  path: string
  source_type: string
  source_id: string | null
  source_meta_json: string | null
}

function migratedPath(row: IndexRow): string {
  const kinds: Record<string, string> = { rss: 'rss-item', calendar: 'event', agent: 'conversation', bookmark: 'web' }
  if (row.path.startsWith('ready://')) {
    const parsed = parseReadyUri(row.path)
    if (!parsed.ok || parsed.ref.kind !== kinds[row.source_type]) throw new Error('invalid ReadyRef')
    if (parsed.ref.kind === 'event' && parsed.ref.occurrence !== undefined) {
      const value = parsed.ref.occurrence
      if (/^-?\d+$/.test(value)) {
        if (!Number.isSafeInteger(Number(value))) throw new Error('invalid occurrence time')
      } else ReadyRefSchema.parse({ kind: 'day', date: value })
    }
    return toReadyUri(parsed.ref)
  }
  const meta: unknown = row.source_meta_json ? JSON.parse(row.source_meta_json) : {}
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('invalid metadata')
  if (row.source_type === 'bookmark') {
    const url = 'url' in meta && typeof meta.url === 'string' ? meta.url : row.path
    return toReadyUri({ kind: 'web', url })
  }
  const prefix = `${row.source_type}://`
  let id = row.source_id || (row.path.startsWith(prefix) ? row.path.slice(prefix.length) : '')
  if (row.source_type === 'calendar' && !id.includes('#') && row.path.startsWith(`${prefix}${id}#`)) {
    id = row.path.slice(prefix.length)
  }
  if (row.source_type === 'rss') return toReadyUri({ kind: 'rss-item', id })
  if (row.source_type === 'agent') return toReadyUri({ kind: 'conversation', id })
  const [seriesId, seconds, extra] = id.split('#')
  if (seconds === undefined) return toReadyUri({ kind: 'event', id: seriesId })
  if (extra !== undefined || !/^-?\d+$/.test(seconds) || !('allDay' in meta) || typeof meta.allDay !== 'boolean') {
    throw new Error('invalid original occurrence')
  }
  const value = Number(seconds)
  if (!Number.isSafeInteger(value * 1000) || (meta.allDay && value % 86400 !== 0)) throw new Error('invalid occurrence time')
  const occurrence = String(originalFromSeconds(value, meta.allDay))
  if (meta.allDay) ReadyRefSchema.parse({ kind: 'day', date: occurrence })
  return toReadyUri({ kind: 'event', id: seriesId, occurrence })
}

/** Index-only migration: never modifies domain records or invents missing instances. */
export function migrateSearchReadyRefs(db: MigrationDatabase): void {
  db.exec('SAVEPOINT search_ready_refs')
  try {
    const rows = db.prepare(`SELECT id, workspace_id, path, source_type, source_id, source_meta_json
      FROM documents WHERE source_type IN ('rss', 'calendar', 'agent', 'bookmark')`).all<IndexRow>()
    const rejected: Array<{ id: number; reason: string }> = []
    const planned: Array<{ row: IndexRow; path: string | null }> = rows.map(row => {
      try { return { row, path: migratedPath(row) } }
      catch (error) {
        rejected.push({ id: row.id, reason: error instanceof Error ? error.message : String(error) })
        return { row, path: null }
      }
    })
    const targets = new Map<string, number>()
    for (const plan of planned) {
      if (plan.path === null) continue
      const key = JSON.stringify([plan.row.workspace_id, plan.path])
      const existing = db.prepare('SELECT id FROM documents WHERE workspace_id = ? AND path = ?')
        .get<{ id: number }>(plan.row.workspace_id, plan.path)
      const owner = targets.get(key) ?? (existing && existing.id !== plan.row.id ? existing.id : undefined)
      if (owner !== undefined) {
        // Two index rows describe the same object. The index is derived and the
        // adapters resync it, so the duplicate is dropped instead of blocking startup.
        rejected.push({ id: plan.row.id, reason: `duplicate of document ${owner}` })
        plan.path = null
        continue
      }
      targets.set(key, plan.row.id)
    }
    let expected = 0
    let affected = 0
    // Deletions first, so an update never collides with a duplicate still holding its path.
    for (const { row, path } of [...planned.filter(p => p.path === null), ...planned.filter(p => p.path !== null)]) {
      if (path === row.path) continue
      expected += 1
      if (path === null) db.prepare('DELETE FROM documents WHERE id = ? AND path = ?').run(row.id, row.path)
      else db.prepare('UPDATE documents SET path = ? WHERE id = ? AND path = ?').run(path, row.id, row.path)
      affected += db.prepare('SELECT changes() AS n').get<{ n: number }>()!.n
    }
    if (affected !== expected) throw new Error(`search ReadyRef row count mismatch: ${affected}/${expected}`)
    db.exec('RELEASE search_ready_refs')
    if (rejected.length) console.warn('[search ReadyRef] removed invalid index rows', rejected)
  } catch (error) {
    db.exec('ROLLBACK TO search_ready_refs')
    db.exec('RELEASE search_ready_refs')
    throw error
  }
}
