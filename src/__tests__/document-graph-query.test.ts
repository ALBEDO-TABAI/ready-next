import type { DatabaseConnection, DatabaseStatement } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import test from 'node:test'


import {
  DOCUMENT_GRAPH_MAX_DOCUMENTS,
  queryDocumentGraph,
} from '../main/modules/database/document-graph-query'

interface RecordedQuery {
  sql: string
  method: 'get' | 'all'
  params: unknown[]
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function fakeConnection(
  respond: (query: RecordedQuery) => unknown,
): { db: DatabaseConnection; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = []
  const db = {
    exec() {},
    close() {},
    prepare(sql: string): DatabaseStatement {
      return {
        run: () => undefined,
        get<T>(...params: unknown[]): T | undefined {
          const query: RecordedQuery = { sql: normalized(sql), method: 'get', params }
          queries.push(query)
          return respond(query) as T | undefined
        },
        all<T>(...params: unknown[]): T[] {
          const query: RecordedQuery = { sql: normalized(sql), method: 'all', params }
          queries.push(query)
          return respond(query) as T[]
        },
      }
    },
  } as DatabaseConnection
  return { db, queries }
}

test('full graph returns truncation metadata, uses the 5000-document cap, and deduplicates edges', () => {
  const { db, queries } = fakeConnection((query) => {
    if (query.sql.startsWith('SELECT COUNT(*)')) return { n: 6000 }
    if (query.sql.includes('FROM documents d') && query.sql.includes('ORDER BY d.id')) {
      return [
        { id: 1, workspaceId: 7, path: '/work/a.md', name: 'a.md', sourceType: 'document' },
        { id: 2, workspaceId: 7, path: '/work/b.md', name: 'b.md', sourceType: 'document' },
      ]
    }
    if (query.sql.includes('FROM object_links') && query.sql.includes('source.id AS src')) {
      return [
        { src: 1, tgt: 2, kind: 'wikilink', label: 'b' },
        { src: 1, tgt: 2, kind: 'wikilink', label: 'b' },
        { src: 2, tgt: null, kind: 'wikilink', label: 'missing' },
        { src: 2, tgt: null, kind: 'wikilink', label: 'missing' },
      ]
    }
    if (query.sql.includes('FROM tags')) {
      return [
        { src: 1, tag: 'Note' },
        { src: 1, tag: 'note' },
      ]
    }
    throw new Error(`unexpected query: ${query.sql}`)
  })

  const graph = queryDocumentGraph(db, { workspaceRoot: '/work', limit: 999_999 })

  assert.equal(graph.totalDocs, 6000)
  assert.equal(graph.truncated, true)
  assert.equal(graph.edges.length, 3)
  assert.equal(new Set(graph.edges.map((edge) => JSON.stringify(edge))).size, graph.edges.length)
  assert.ok(graph.nodes.some((node) => node.path === '/work/a.md'))
  const documentRead = queries.find((query) =>
    query.method === 'all'
    && query.sql.includes('FROM documents d')
    && query.sql.includes('ORDER BY d.id'),
  )
  assert.equal(documentRead?.params.at(-1), DOCUMENT_GRAPH_MAX_DOCUMENTS)
})

test('focus graph expands from the center with SQL BFS and loads only the matched document ids', () => {
  const { db, queries } = fakeConnection((query) => {
    if (query.method === 'get' && query.sql.includes('WHERE w.root = ? AND d.path = ?')) {
      return { id: 1, workspaceId: 7, path: '/work/a.md', name: 'a.md', sourceType: 'document' }
    }
    if (query.sql.includes('AND source.id IN')) {
      return [{ a: 1, b: 2 }]
    }
    if (query.sql.includes('WHERE target.id IN')) {
      return [{ a: 3, b: 1 }]
    }
    if (query.sql.includes('WHERE workspace_id = ? AND id IN')) {
      const ids = new Set(query.params.slice(1))
      return [
        { id: 1, workspaceId: 7, path: '/work/a.md', name: 'a.md', sourceType: 'document' },
        { id: 2, workspaceId: 7, path: '/work/b.md', name: 'b.md', sourceType: 'document' },
        { id: 3, workspaceId: 7, path: '/work/c.md', name: 'c.md', sourceType: 'document' },
      ].filter((row) => ids.has(row.id))
    }
    if (query.sql.includes('FROM object_links') && query.sql.includes('source.id AS src')) {
      return [
        { src: 1, tgt: 2, kind: 'wikilink', label: 'b' },
        { src: 3, tgt: 1, kind: 'wikilink', label: 'a' },
      ]
    }
    if (query.sql.includes('FROM tags')) return []
    throw new Error(`unexpected query: ${query.sql}`)
  })

  const graph = queryDocumentGraph(db, {
    workspaceRoot: '/work',
    centerPath: '/work/a.md',
    depth: 1,
  })

  assert.deepEqual(
    graph.nodes.filter((node) => node.type === 'doc').map((node) => node.path).sort(),
    ['/work/a.md', '/work/b.md', '/work/c.md'],
  )
  assert.equal(graph.totalDocs, 3)
  assert.equal(graph.truncated, false)
  assert.equal(
    queries.some((query) => query.sql.includes('FROM documents d ORDER BY d.id')),
    false,
    'focus mode must not load the workspace document table before BFS',
  )
  assert.ok(queries.some((query) => query.sql.includes('WHERE workspace_id = ? AND id IN')))
})
