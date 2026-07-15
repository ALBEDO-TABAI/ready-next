import { resolveCanonicalRSSItemIdentity } from './item-identity'

export interface RSSItemIdentityMigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<T = unknown>(...params: unknown[]): T[]
  }
}

interface RSSIdentityRow {
  id: string
  source_id: string
  guid: string
  title: string
  link: string
  summary: string | null
  cover_image: string | null
  author: string | null
  published_at: number | null
  fetched_at: number
  inbox_visible: number
  read: number
  starred: number
  ai_score: number | null
  ai_tags: string | null
}

interface CanonicalizedRow {
  row: RSSIdentityRow
  identity: NonNullable<ReturnType<typeof resolveCanonicalRSSItemIdentity>>
}

function preferredRow(group: CanonicalizedRow[]): CanonicalizedRow {
  return group.find((entry) => entry.row.id === entry.identity.id)
    ?? group.find((entry) => entry.row.link === entry.identity.link)
    ?? [...group].sort((left, right) => right.row.fetched_at - left.row.fetched_at)[0]
}

function firstValue<K extends keyof RSSIdentityRow>(
  group: CanonicalizedRow[],
  preferred: CanonicalizedRow,
  key: K,
): RSSIdentityRow[K] {
  const preferredValue = preferred.row[key]
  if (preferredValue !== null && preferredValue !== '') return preferredValue
  for (const entry of [...group].sort((left, right) => right.row.fetched_at - left.row.fetched_at)) {
    const value = entry.row[key]
    if (value !== null && value !== '') return value
  }
  return preferredValue
}

export function migrateCanonicalRSSItemIdentities(
  db: RSSItemIdentityMigrationDatabase,
): void {
  const rows = db.prepare(`
    SELECT i.*
    FROM rss_items i
    JOIN rss_sources s ON s.id = i.source_id
    WHERE i.link LIKE '%bilibili.com/video/%'
       OR i.guid LIKE '%bilibili.com/video/%'
       OR i.summary LIKE '%bilibili.com/video/%'
       OR i.link LIKE '%twitter.com/%/status/%'
       OR i.guid LIKE '%twitter.com/%/status/%'
       OR i.link LIKE '%x.com/%/status/%'
       OR i.guid LIKE '%x.com/%/status/%'
  `).all<RSSIdentityRow>()

  const groups = new Map<string, CanonicalizedRow[]>()
  for (const row of rows) {
    const identity = resolveCanonicalRSSItemIdentity({
      link: row.link,
      guid: row.guid,
      description: row.summary,
    })
    if (!identity) continue
    const group = groups.get(identity.link) ?? []
    group.push({ row, identity })
    groups.set(identity.link, group)
  }

  const updateAnalysis = db.prepare(`
    UPDATE rss_analysis_jobs SET item_id = ?, source_url = ? WHERE item_id = ?
  `)
  const insertItem = db.prepare(`
    INSERT INTO rss_items (
      id, source_id, guid, title, link, summary, cover_image, author,
      published_at, fetched_at, inbox_visible, read, starred, ai_score, ai_tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const group of groups.values()) {
    const preferred = preferredRow(group)
    const identity = preferred.identity
    const aliases = group.map((entry) => entry.row.id)
    for (const alias of aliases) {
      updateAnalysis.run(identity.id, identity.link, alias)
    }

    const placeholders = aliases.map(() => '?').join(', ')
    db.prepare(`DELETE FROM rss_items WHERE id IN (${placeholders})`).run(...aliases)
    insertItem.run(
      identity.id,
      preferred.row.source_id,
      identity.guid,
      preferred.row.title,
      identity.link,
      firstValue(group, preferred, 'summary'),
      firstValue(group, preferred, 'cover_image'),
      firstValue(group, preferred, 'author'),
      firstValue(group, preferred, 'published_at'),
      Math.max(...group.map((entry) => entry.row.fetched_at)),
      Math.max(...group.map((entry) => entry.row.inbox_visible ?? 1)),
      Math.min(...group.map((entry) => entry.row.read ?? 0)),
      Math.max(...group.map((entry) => entry.row.starred ?? 0)),
      firstValue(group, preferred, 'ai_score'),
      firstValue(group, preferred, 'ai_tags'),
    )
  }
}
