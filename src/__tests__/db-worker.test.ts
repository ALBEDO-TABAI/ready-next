/**
 * perf-rescue B1 — DB worker integration test.
 *
 * Spawns a real worker_thread against an in-memory SQLite DB to verify the
 * end-to-end request/response flow. SKIPPED when:
 *   - better-sqlite3 native binding is unavailable (ABI mismatch with system
 *     Node — same skip pattern as `database-pragmas.test.ts`); or
 *   - the bundled worker entry isn't present (we run against the source `.ts`
 *     via tsx where possible; production runs against `out/main/db-worker.js`
 *     produced by `electron-vite build`).
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

import {
  WorkerDbBridgeImpl,
  type WorkerFactory,
} from '../main/modules/database/worker-bridge'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const nodeRequire = createRequire(import.meta.url)

function resolveWorkerEntry(): string | null {
  // 1) bundled output (real production layout)
  const builtPath = resolve(process.cwd(), 'out', 'main', 'db-worker.js')
  if (existsSync(builtPath)) return builtPath
  // 2) source path under tsx — only works if node can resolve TS, which it
  //    can't here. We deliberately don't fall back to the .ts file because
  //    Worker(string) needs a JS-runnable file.
  return null
}

test('db-worker integration: end-to-end query/response', async (t) => {
  if (skipIfSqliteUnavailable(t, 'db-worker: end-to-end')) return
  const workerEntry = resolveWorkerEntry()
  if (!workerEntry) {
    t.skip('bundled db-worker.js not found at out/main/db-worker.js (run `npm run build` first)')
    return
  }

  // Build a real DB on disk with a minimal schema so the worker can run a
  // graph query against it.
  const sqlMod = nodeRequire('better-sqlite3') as (new (path: string) => { exec: (sql: string) => void; close: () => void; pragma: (s: string, opts?: { simple?: boolean }) => unknown }) & { default?: new (path: string) => { exec: (sql: string) => void; close: () => void; pragma: (s: string, opts?: { simple?: boolean }) => unknown } }
  const Sqlite = (sqlMod as { default?: new (path: string) => { exec: (sql: string) => void; close: () => void; pragma: (s: string, opts?: { simple?: boolean }) => unknown } }).default || sqlMod

  const tmpDir = await mkdtemp(join(tmpdir(), 'db-worker-itest-'))
  const dbPath = join(tmpDir, 'test.db')

  try {
    const seed = new (Sqlite as new (path: string) => { exec: (sql: string) => void; close: () => void; pragma: (s: string, opts?: { simple?: boolean }) => unknown })(dbPath)
    seed.pragma('journal_mode = WAL')
    seed.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT UNIQUE NOT NULL,
        last_indexed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        ext TEXT,
        size INTEGER,
        mtime INTEGER,
        content_hash TEXT,
        frontmatter_json TEXT,
        indexed_at INTEGER,
        source_type TEXT,
        source_id TEXT,
        source_meta_json TEXT,
        object_id TEXT
      );
      CREATE TABLE IF NOT EXISTS object_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT, source_ref TEXT, target_ref TEXT,
        kind TEXT NOT NULL,
        target_text TEXT,
        target_id TEXT,
        resolved INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tags (
        doc_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (doc_id, tag)
      );
      INSERT INTO workspaces (root) VALUES ('/work');
      INSERT INTO documents (workspace_id, path, name, source_type) VALUES (1, '/work/a.md', 'a.md', 'document');
      INSERT INTO documents (workspace_id, path, name, source_type) VALUES (1, '/work/b.md', 'b.md', 'document');
      UPDATE documents SET object_id=CAST(id AS TEXT);
      INSERT INTO object_links (source_id, kind, target_text, target_id,resolved) VALUES ('1', 'wikilink', 'b', '2',1);
      INSERT INTO tags (doc_id, tag) VALUES (1, 'note');
    `)
    seed.close()

    // Use the production factory but pointed at our test entry.
    const factory: WorkerFactory = ({ dbPath: p }) => new Worker(workerEntry, { workerData: { dbPath: p } }) as unknown as ReturnType<WorkerFactory>
    const bridge = new WorkerDbBridgeImpl(dbPath, factory)

    try {
      const graph = await bridge.getDocumentGraph({ workspaceRoot: '/work', depth: 2 })
      // 2 docs, 1 tag node. 1 link edge + 1 tag edge.
      assert.equal(graph.nodes.length, 3, `expected 3 nodes, got ${graph.nodes.length}: ${JSON.stringify(graph.nodes)}`)
      assert.ok(graph.nodes.some((n) => n.type === 'doc' && n.label === 'a.md' && n.path === '/work/a.md'))
      assert.ok(graph.nodes.some((n) => n.type === 'doc' && n.label === 'b.md' && n.path === '/work/b.md'))
      assert.ok(graph.nodes.some((n) => n.type === 'tag' && n.label === 'note'))
      assert.ok(graph.edges.some((e) => e.kind === 'wikilink'))
      assert.ok(graph.edges.some((e) => e.kind === 'tag-of'))
      assert.equal(graph.totalDocs, 2)
      assert.equal(graph.truncated, false)
    } finally {
      await bridge.shutdown()
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
})

// Suppress unused import warning
void writeFile
