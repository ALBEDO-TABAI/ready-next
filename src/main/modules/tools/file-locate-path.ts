export interface IndexedDocumentRow {
  id: number
  path: string
  source_type: string
}

interface PreparedIndexedDocumentStatement {
  get?: <T = IndexedDocumentRow>(...params: unknown[]) => T | undefined
  all?: <T = IndexedDocumentRow>(...params: unknown[]) => T[]
}

export interface IndexedDocumentConnection {
  prepare: (sql: string) => PreparedIndexedDocumentStatement
}

export type IndexedDocumentResolution =
  | { kind: 'found'; row: IndexedDocumentRow }
  | { kind: 'ambiguous'; candidates: Array<{ path: string; sourceType: string }> }
  | { kind: 'missing' }

function basenameFromPathLike(value: string): string {
  const parts = value.trim().split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? value.trim()
}

function normalizeRelativeSuffix(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function dedupeRows(rows: IndexedDocumentRow[]): IndexedDocumentRow[] {
  const seen = new Set<string>()
  const out: IndexedDocumentRow[] = []
  for (const row of rows) {
    if (seen.has(row.path)) continue
    seen.add(row.path)
    out.push(row)
  }
  return out
}

export function resolveIndexedDocumentCandidate(
  db: IndexedDocumentConnection,
  rawPath: string,
): IndexedDocumentResolution {
  const path = rawPath.trim()
  if (!path) return { kind: 'missing' }

  const exact = db
    .prepare('SELECT id, path, source_type FROM documents WHERE path = ? LIMIT 1')
    .get?.<IndexedDocumentRow>(path)
  if (exact) return { kind: 'found', row: exact }
  if (/^ready:\/\//i.test(path)) return { kind: 'missing' }

  const name = basenameFromPathLike(path)
  const suffix = normalizeRelativeSuffix(path)
  const suffixLike = `%/${escapeSqlLike(suffix)}`
  const matchName = name === suffix ? 1 : 0
  const rows = dedupeRows(
    db
      .prepare(
        `SELECT id, path, source_type
         FROM documents
         WHERE (? = 1 AND name = ?)
            OR path LIKE ? ESCAPE '\\'
         ORDER BY CASE
           WHEN path LIKE ? ESCAPE '\\' THEN 0
           WHEN ? = 1 AND name = ? THEN 1
           ELSE 2
         END, length(path), path
         LIMIT 6`,
      )
      .all?.<IndexedDocumentRow>(matchName, name, suffixLike, suffixLike, matchName, name) ?? [],
  )

  if (rows.length === 1) return { kind: 'found', row: rows[0] }
  if (rows.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: rows.map((row) => ({ path: row.path, sourceType: row.source_type || 'document' })),
    }
  }
  return { kind: 'missing' }
}
