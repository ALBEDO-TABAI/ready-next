import type { DatabaseConnection } from '../database'

export const DOCUMENT_GRAPH_MAX_DOCUMENTS = 5000

const DOCUMENT_GRAPH_SQL_CHUNK = 800

export interface DocumentGraphQuery {
  workspaceRoot?: string
  centerPath?: string
  depth?: number
  limit?: number
  mode?: 'full' | 'focus'
}

export interface DocumentGraphNode {
  id: string
  type: 'doc' | 'tag' | 'ghost'
  label: string
  sourceType?: string
  path?: string
}

export interface DocumentGraphEdge {
  source: string
  target: string
  kind: string
}

export interface DocumentGraphResult {
  nodes: DocumentGraphNode[]
  edges: DocumentGraphEdge[]
  totalDocs: number
  truncated: boolean
  note?: string
}

interface DocumentRow {
  id: number
  workspaceId: number
  path: string
  name: string
  sourceType: string
}

interface LinkRow {
  src: number
  tgt: number | null
  kind: string
  label: string
}

function chunks<T>(items: T[], size = DOCUMENT_GRAPH_SQL_CHUNK): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size))
  }
  return result
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

function countDocuments(db: DatabaseConnection, workspaceRoot: string | null): number {
  const row = workspaceRoot
    ? db
        .prepare(`SELECT COUNT(*) AS n FROM documents WHERE workspace_id = (SELECT id FROM workspaces WHERE root = ?)`)
        .get<{ n: number }>(workspaceRoot)
    : db.prepare(`SELECT COUNT(*) AS n FROM documents`).get<{ n: number }>()
  return row?.n ?? 0
}

function findCenterDocument(
  db: DatabaseConnection,
  centerPath: string,
  workspaceRoot: string | null,
): DocumentRow | undefined {
  const fields = `d.id, d.workspace_id AS workspaceId, d.path, d.name, d.source_type AS sourceType`
  if (workspaceRoot) {
    return db
      .prepare(
        `SELECT ${fields}
         FROM documents d
         JOIN workspaces w ON w.id = d.workspace_id
         WHERE w.root = ? AND d.path = ?
         LIMIT 1`,
      )
      .get<DocumentRow>(workspaceRoot, centerPath)
  }
  return db
    .prepare(`SELECT ${fields} FROM documents d WHERE d.path = ? ORDER BY d.id LIMIT 1`)
    .get<DocumentRow>(centerPath)
}

function collectRelatedDocumentIds(
  db: DatabaseConnection,
  center: DocumentRow,
  depth: number,
  limit: number,
): { ids: Set<number>; truncated: boolean } {
  const ids = new Set<number>([center.id])
  let frontier = [center.id]
  let truncated = false

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next = new Set<number>()
    for (const batch of chunks(frontier)) {
      const marks = placeholders(batch.length)
      const outgoing = db
        .prepare(
          `SELECT dl.src_doc_id AS a, dl.target_doc_id AS b
           FROM doc_links dl
           JOIN documents target ON target.id = dl.target_doc_id
           WHERE dl.target_doc_id IS NOT NULL
             AND target.workspace_id = ?
             AND dl.src_doc_id IN (${marks})`,
        )
        .all<{ a: number; b: number }>(center.workspaceId, ...batch)
      const incoming = db
        .prepare(
          `SELECT dl.src_doc_id AS a, dl.target_doc_id AS b
           FROM doc_links dl
           JOIN documents source ON source.id = dl.src_doc_id
           WHERE dl.target_doc_id IN (${marks})
             AND source.workspace_id = ?`,
        )
        .all<{ a: number; b: number }>(...batch, center.workspaceId)

      for (const edge of [...outgoing, ...incoming]) {
        for (const id of [edge.a, edge.b]) {
          if (!id || ids.has(id) || next.has(id)) continue
          if (ids.size + next.size >= limit) {
            truncated = true
            continue
          }
          next.add(id)
        }
      }
    }
    for (const id of next) ids.add(id)
    frontier = [...next]
  }

  return { ids, truncated }
}

function loadDocumentsByIds(
  db: DatabaseConnection,
  workspaceId: number,
  ids: Set<number>,
): DocumentRow[] {
  const result: DocumentRow[] = []
  for (const batch of chunks([...ids])) {
    result.push(...db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, path, name, source_type AS sourceType
         FROM documents
         WHERE workspace_id = ? AND id IN (${placeholders(batch.length)})`,
      )
      .all<DocumentRow>(workspaceId, ...batch))
  }
  return result
}

function loadGraphRows(
  db: DatabaseConnection,
  documentIds: number[],
): { links: LinkRow[]; tags: Array<{ src: number; tag: string }> } {
  const links: LinkRow[] = []
  const tags: Array<{ src: number; tag: string }> = []
  for (const batch of chunks(documentIds)) {
    const marks = placeholders(batch.length)
    links.push(...db
      .prepare(
        `SELECT src_doc_id AS src, target_doc_id AS tgt, kind, target_text AS label
         FROM doc_links
         WHERE src_doc_id IN (${marks})`,
      )
      .all<LinkRow>(...batch))
    tags.push(...db
      .prepare(`SELECT doc_id AS src, tag FROM tags WHERE doc_id IN (${marks})`)
      .all<{ src: number; tag: string }>(...batch))
  }
  return { links, tags }
}

function appendEdge(
  edges: DocumentGraphEdge[],
  seen: Set<string>,
  edge: DocumentGraphEdge,
): void {
  const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`
  if (seen.has(key)) return
  seen.add(key)
  edges.push(edge)
}

function buildGraph(
  db: DatabaseConnection,
  documents: DocumentRow[],
  totalDocs: number,
  truncated: boolean,
): DocumentGraphResult {
  const nodes: DocumentGraphNode[] = documents.map((document) => ({
    id: `doc:${document.id}`,
    type: 'doc',
    label: document.name,
    sourceType: document.sourceType,
    path: document.path,
  }))
  if (documents.length === 0) return { nodes, edges: [], totalDocs, truncated }

  const documentIds = documents.map((document) => document.id)
  const allowedIds = new Set(documentIds)
  const { links, tags } = loadGraphRows(db, documentIds)
  const edges: DocumentGraphEdge[] = []
  const seenEdges = new Set<string>()
  const ghostLabels = new Map<string, string>()
  const tagLabels = new Map<string, string>()

  for (const link of links) {
    if (link.tgt && allowedIds.has(link.tgt)) {
      appendEdge(edges, seenEdges, {
        source: `doc:${link.src}`,
        target: `doc:${link.tgt}`,
        kind: link.kind,
      })
    } else if (!link.tgt && link.kind === 'wikilink') {
      const ghostId = `ghost:${link.label}`
      ghostLabels.set(ghostId, link.label)
      appendEdge(edges, seenEdges, {
        source: `doc:${link.src}`,
        target: ghostId,
        kind: 'wikilink',
      })
    }
  }
  for (const row of tags) {
    const tagId = `tag:${row.tag.toLowerCase()}`
    if (!tagLabels.has(tagId)) tagLabels.set(tagId, row.tag)
    appendEdge(edges, seenEdges, {
      source: `doc:${row.src}`,
      target: tagId,
      kind: 'tag-of',
    })
  }
  for (const [id, label] of tagLabels) nodes.push({ id, type: 'tag', label })
  for (const [id, label] of ghostLabels) nodes.push({ id, type: 'ghost', label })

  return { nodes, edges, totalDocs, truncated }
}

export function queryDocumentGraph(
  db: DatabaseConnection,
  args: DocumentGraphQuery = {},
): DocumentGraphResult {
  const workspaceRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot : null
  const centerPath = typeof args.centerPath === 'string' ? args.centerPath : null
  const mode = args.mode === 'focus' || centerPath ? 'focus' : 'full'
  const requestedDepth = typeof args.depth === 'number' && Number.isFinite(args.depth) ? Math.floor(args.depth) : 2
  const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.floor(args.limit)
    : DOCUMENT_GRAPH_MAX_DOCUMENTS
  const depth = Math.max(1, Math.min(6, requestedDepth))
  const limit = Math.max(
    1,
    Math.min(DOCUMENT_GRAPH_MAX_DOCUMENTS, requestedLimit),
  )

  if (mode === 'focus') {
    if (!centerPath) {
      return {
        nodes: [],
        edges: [],
        totalDocs: 0,
        truncated: false,
        note: 'centerPath_required_in_focus',
      }
    }
    const center = findCenterDocument(db, centerPath, workspaceRoot)
    if (!center) {
      return {
        nodes: [],
        edges: [],
        totalDocs: 0,
        truncated: false,
        note: 'centerPath not in index',
      }
    }
    const related = collectRelatedDocumentIds(db, center, depth, limit)
    const documents = loadDocumentsByIds(db, center.workspaceId, related.ids)
    return buildGraph(db, documents, documents.length, related.truncated)
  }

  const totalDocs = countDocuments(db, workspaceRoot)
  const fields = `d.id, d.workspace_id AS workspaceId, d.path, d.name, d.source_type AS sourceType`
  const documents = workspaceRoot
    ? db
        .prepare(
          `SELECT ${fields}
           FROM documents d
           JOIN workspaces w ON w.id = d.workspace_id
           WHERE w.root = ?
           ORDER BY d.id
           LIMIT ?`,
        )
        .all<DocumentRow>(workspaceRoot, limit)
    : db
        .prepare(`SELECT ${fields} FROM documents d ORDER BY d.id LIMIT ?`)
        .all<DocumentRow>(limit)
  return buildGraph(db, documents, totalDocs, totalDocs > documents.length)
}
