import type { DatabaseConnection } from '../main/modules/database/connection'
/**
 * Multi-root search & reindex integration test.
 *
 * Locks the three contracts introduced by the pinned-folder multi-root fix:
 *   1. `SearchEngine.search` honours `opts.workspaceRoots` (list filter)
 *      and ranks across all chosen workspace_ids in a SINGLE SQL pass —
 *      no per-root loop that could starve later roots when an earlier
 *      one saturates the limit.
 *   2. Cross-root BM25 fairness: when rootA dilutes the term ranking with
 *      many low-quality long documents that match, and rootB has a single
 *      short precise match, rootB must appear in the limit=10 result set.
 *      This is the regression test for "loop-by-root would push rootB out".
 *   3. Reindex shared-source uniqueness: in the GlobalSearchPanel multi-root
 *      flow (first root → `reindexAllSources`, rest → `reindexWorkspace`),
 *      the SHARED workspace row is touched EXACTLY ONCE — never N times.
 *
 * Plus a small unit assertion that `validateWorkspaceRoot` flags the unsafe
 * paths the IPC defense-in-depth gates rely on.
 *
 * Uses real better-sqlite3 + the actual `SearchEngine`. Falls back to
 * `[ABI-SKIP]` when the native binding isn't available (host-Node ABI
 * mismatch) — SQLite-backed acceptance is covered by `npm run verify:native`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'

import { SearchEngine, probeFts5Availability } from '../main/modules/search-engine/indexer'
import { SearchRepository } from '../main/modules/search-engine/repository'
import { validateWorkspaceRoot } from '../shared/workspace-validation'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

function loadSqliteCtor(): SqliteCtor | null {
  try {
    const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
    const Sqlite = mod.default || mod
    const probe = new Sqlite(':memory:')
    probe.close()
    return Sqlite
  } catch {
    return null
  }
}

function openSchemaDb(Sqlite: SqliteCtor): DatabaseConnection {
  const db = new Sqlite(':memory:')
  runMigrations(db as unknown as MigrationDatabase)
  return db
}

function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ready-search-multiroot-'))
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    })
}

/** Write a single markdown file under `dir`. Returns the absolute path. */
function writeMd(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body, 'utf-8')
  return path
}

// ---------------------------------------------------------------------------
// Plain unit: workspace validation gates the IPC defense.
// ---------------------------------------------------------------------------

test('validateWorkspaceRoot rejects the paths the IPC defense gates against', (t) => {
  if (skipIfSqliteUnavailable(t, 'search-multi-root: validation unit guard')) return
  // The reindex IPC handlers (search-engine/ipc-handler.ts) now re-validate
  // every root path before touching the worker bridge / fallback engine.
  // Whether or not better-sqlite3 is available, this synchronous check must
  // refuse home-like and root-like trees — that's the contract the gate relies on.
  const home = validateWorkspaceRoot('/Users/test')
  assert.equal(home.ok, false, '/Users/<x> must be rejected')
  const root = validateWorkspaceRoot('/')
  assert.equal(root.ok, false, '/ must be rejected')
  const tilde = validateWorkspaceRoot('~')
  assert.equal(tilde.ok, false, '~ must be rejected')
})

// ---------------------------------------------------------------------------
// Multi-root search behavior.
// ---------------------------------------------------------------------------

test('search with workspaceRoots: [] returns no results — never falls back to unscoped', async (t) => {
  // Code review #3: passing `workspaceRoots: []` previously fell through to
  // the unscoped branch (`length > 0` was the only positive condition), so an
  // empty desired set silently broadened the scan to every workspace ever
  // indexed — including stale rows from prior sessions. This locks the
  // explicit-empty-list semantics.
  if (skipIfSqliteUnavailable(t, 'search-multi-root: empty list does not fall back')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    const dir = join(tmp, 'leftover'); mkdirSync(dir)
    writeMd(dir, 'note.md', '# leftover\n\nshould-not-appear keyword\n')

    const db = openSchemaDb(Sqlite)
    try {
      const engine = new SearchEngine(db, { fts5Available: probeFts5Availability(db) })
      await engine.reindexWorkspace({ root: dir })

      // Sanity: with no scope arg, the doc IS findable (legacy unscoped).
      const unscoped = await engine.search('should-not-appear', {})
      assert.ok(
        unscoped.items.some((h) => h.path === join(dir, 'note.md')),
        'unscoped legacy fallback should still find the doc (sanity)',
      )

      // The fix: explicit empty array means "no scope".
      const empty = await engine.search('should-not-appear', { workspaceRoots: [] })
      assert.equal(empty.items.length, 0, 'workspaceRoots: [] must NOT fall back to unscoped')
    } finally {
      db.close()
    }
  })
})

test('search matches Chinese CJK terms after workspace reindex', async (t) => {
  if (skipIfSqliteUnavailable(t, 'search-multi-root: CJK FTS terms')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    const dir = join(tmp, 'events'); mkdirSync(dir)
    const notePath = writeMd(
      dir,
      '北岸夜跑.md',
      '# 北岸夜跑\n\n## 预算\n北岸夜跑预算共 4.0 万元，主要用于报备、物料、安保、摄影和应急。\n',
    )

    const db = openSchemaDb(Sqlite)
    try {
      const fts5Available = probeFts5Availability(db)
      if (!fts5Available) {
        t.skip('[ABI-SKIP][sqlite_runtime_error] search-multi-root: FTS5 unavailable; covered by npm run verify:native')
        return
      }
      const engine = new SearchEngine(db, { fts5Available })
      await engine.reindexWorkspace({ root: dir })

      const result = await engine.search('北岸夜跑预算', { workspaceRoot: dir })
      assert.ok(
        result.items.some((item) => item.path === notePath),
        'CJK query should find the indexed markdown note',
      )
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Defense-in-depth: search never returns content from unsafe DB rows.
// ---------------------------------------------------------------------------

const UNSAFE_LEGACY_ROOT = '/Users/test'

/** Seed an unsafe legacy row + its docs by going around the engine's reindex
 *  path (which expects real disk). Mimics what a pre-validation install would
 *  have left behind in the workspaces / documents tables. */
function seedUnsafeLegacyWorkspace(db: DatabaseConnection, root: string, body: string): void {
  const repo = new SearchRepository(db, false)
  db.prepare('INSERT OR IGNORE INTO workspaces (root) VALUES (?)').run(root)
  const row = db.prepare('SELECT id FROM workspaces WHERE root = ?').get<{ id: number }>(root)!
  repo.upsertDocument({
    workspaceId: row.id,
    path: `${root}/legacy.md`,
    name: 'legacy.md',
    ext: '.md',
    size: 64,
    mtime: Math.floor(Date.now() / 1000),
    contentHash: `hash-${root}`,
    frontmatterJson: null,
    body,
    sourceType: 'document',
  })
}

test('search defense-in-depth: stale unsafe workspace rows never leak through unscoped search', async (t) => {
  if (skipIfSqliteUnavailable(t, 'search-multi-root: unscoped does not leak unsafe legacy rows')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    const safeDir = join(tmp, 'safe'); mkdirSync(safeDir)
    writeMd(safeDir, 'note.md', '# safe\n\nleak-test-marker safe-keyword\n')

    const db = openSchemaDb(Sqlite)
    try {
      const engine = new SearchEngine(db, { fts5Available: probeFts5Availability(db) })
      await engine.reindexWorkspace({ root: safeDir })
      // Seed a legacy unsafe row directly into the DB — bypasses the engine's
      // reindex path (which would also need disk access). This simulates the
      // state left over from a pre-validation install: a `~` / `/Users/<x>`
      // workspace row with indexed docs still living in `documents`.
      seedUnsafeLegacyWorkspace(db, UNSAFE_LEGACY_ROOT, 'leak-test-marker unsafe-legacy-content')

      // Sanity check: the unsafe row really is in the DB.
      const allWorkspaces = db
        .prepare('SELECT root FROM workspaces')
        .all<{ root: string }>()
      assert.ok(
        allWorkspaces.some((r) => r.root === UNSAFE_LEGACY_ROOT),
        'sanity: unsafe legacy row must be present in workspaces table',
      )

      // The fix: even when no scope is provided (unscoped fallback), the
      // engine must filter out unsafe roots so the legacy doc never surfaces.
      const result = await engine.search('leak-test-marker', {})
      const safeHits = result.items.filter((h) => h.path.startsWith(safeDir))
      const unsafeHits = result.items.filter((h) => h.path.startsWith(UNSAFE_LEGACY_ROOT))
      assert.ok(safeHits.length > 0, 'safe root content must still be findable')
      assert.equal(unsafeHits.length, 0, 'unsafe legacy content must NEVER leak through unscoped search')
    } finally {
      db.close()
    }
  })
})

test('search defense-in-depth: explicit unsafe workspaceRoot returns no results (and no SHARED bleed)', async (t) => {
  if (skipIfSqliteUnavailable(t, 'search-multi-root: explicit unsafe workspaceRoot blocked')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    void tmp
    const db = openSchemaDb(Sqlite)
    try {
      const engine = new SearchEngine(db, { fts5Available: probeFts5Availability(db) })
      seedUnsafeLegacyWorkspace(db, UNSAFE_LEGACY_ROOT, 'leak-test-marker unsafe-legacy-content')

      const result = await engine.search('leak-test-marker', { workspaceRoot: UNSAFE_LEGACY_ROOT })
      assert.equal(result.items.length, 0, 'unsafe workspaceRoot must produce empty results')
    } finally {
      db.close()
    }
  })
})

test('search defense-in-depth: unsafe entry in workspaceRoots list returns empty — no SHARED bleed', async (t) => {
  if (skipIfSqliteUnavailable(t, 'search-multi-root: unsafe workspaceRoots list blocked')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    void tmp
    const db = openSchemaDb(Sqlite)
    try {
      const engine = new SearchEngine(db, { fts5Available: probeFts5Availability(db) })
      seedUnsafeLegacyWorkspace(db, UNSAFE_LEGACY_ROOT, 'leak-test-marker unsafe-legacy-content')

      // Even though the request "explicitly names" the unsafe root, the
      // engine must strip it from the safe-requested set. With no safe roots
      // left, the result must be empty — SHARED must NOT silently take over
      // and return shared-source hits.
      const result = await engine.search('leak-test-marker', {
        workspaceRoots: [UNSAFE_LEGACY_ROOT],
      })
      assert.equal(result.items.length, 0, 'all-unsafe workspaceRoots must produce empty results without SHARED bleed')
    } finally {
      db.close()
    }
  })
})

test('search honours workspaceRoots list — rootA hit, rootB-only excluded', async (t) => {
  if (skipIfSqliteUnavailable(t, 'search-multi-root: list filter')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    const dirA = join(tmp, 'a'); mkdirSync(dirA)
    const dirB = join(tmp, 'b'); mkdirSync(dirB)
    writeMd(dirA, 'note.md', '# alphahit\n\nthe term alphahit only lives in rootA.\n')
    writeMd(dirB, 'note.md', '# betahit\n\nthe term betahit only lives in rootB.\n')

    const db = openSchemaDb(Sqlite)
    try {
      const fts5 = probeFts5Availability(db)
      const engine = new SearchEngine(db, { fts5Available: fts5 })

      await engine.reindexWorkspace({ root: dirA })
      await engine.reindexWorkspace({ root: dirB })

      // workspaceRoots = [dirA, dirB] → alphahit comes back
      const both = await engine.search('alphahit', { workspaceRoots: [dirA, dirB] })
      assert.ok(
        both.items.some((h) => h.path === join(dirA, 'note.md')),
        'alphahit in rootA should be hit when both roots are scoped',
      )

      // workspaceRoots = [dirB] → alphahit does NOT come back (scoped out)
      const onlyB = await engine.search('alphahit', { workspaceRoots: [dirB] })
      assert.ok(
        !onlyB.items.some((h) => h.path === join(dirA, 'note.md')),
        'alphahit in rootA must be excluded when only rootB is scoped',
      )
    } finally {
      db.close()
    }
  })
})

test('star: cross-root BM25 fair ranking — rootB precise match survives rootA noise saturation', async (t) => {
  // Regression test for the v2-plan bug where `search` looped over chosenRoots
  // and broke out of the loop once `limit` was reached. rootA saturated the
  // slice with 50 long noisy docs, starving rootB. With the single-SQL
  // `workspace_id IN (?, ?, ...)` + global `ORDER BY rank ASC LIMIT N`, rootB's
  // short precise match wins by BM25 even though rootA also matches.
  if (skipIfSqliteUnavailable(t, 'search-multi-root: fair-ranking star')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    const dirA = join(tmp, 'a'); mkdirSync(dirA)
    const dirB = join(tmp, 'b'); mkdirSync(dirB)

    // rootA: 50 long documents that all contain "foo bar" but are otherwise
    // diluted with hundreds of unrelated tokens. BM25 will score these poorly
    // because the term frequency is dwarfed by the document length.
    const noiseFiller = Array.from({ length: 400 }, (_, i) => `noise-token-${i}`).join(' ')
    for (let i = 0; i < 50; i++) {
      writeMd(dirA, `noise-${String(i).padStart(2, '0')}.md`, `# Note ${i}\n\nfoo bar ${noiseFiller}\n`)
    }
    // rootB: 1 short document with "foo bar" tightly clustered with no noise.
    // BM25 favors this — short, dense match.
    writeMd(dirB, 'precise.md', '# Precise\n\nfoo bar\n')

    const db = openSchemaDb(Sqlite)
    try {
      const fts5 = probeFts5Availability(db)
      if (!fts5) {
        t.skip('FTS5 unavailable — BM25 ranking cannot be exercised; '
          + 'this test is a no-op without FTS5 (covered by verify:native).')
        return
      }
      const engine = new SearchEngine(db, { fts5Available: true })

      await engine.reindexWorkspace({ root: dirA })
      await engine.reindexWorkspace({ root: dirB })

      const result = await engine.search('foo bar', { workspaceRoots: [dirA, dirB], limit: 10 })
      // The single SQL pass + global ORDER BY rank means rootB's precise
      // document MUST appear in the top 10 even though rootA has 50 matches.
      // If the search code regressed to per-root loop-and-break, rootB would
      // be entirely missing — limit=10 would be filled by rootA before rootB
      // got a chance.
      const hasPrecise = result.items.some((h) => h.path === join(dirB, 'precise.md'))
      assert.ok(
        hasPrecise,
        `rootB's short precise match must appear in top 10 (got ${result.items.length} hits, paths: ${result.items.map((h) => h.path).join(', ')})`,
      )
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Reindex shared-source uniqueness — spy on touchWorkspace.
// ---------------------------------------------------------------------------

test('shared sources are touched exactly once across a multi-root reindex flow', async (t) => {
  // Mirrors GlobalSearchPanel.runReindex: first root → reindexAllSources
  // (which scans FS + 4 shared adapters under SHARED workspace_id), subsequent
  // roots → reindexWorkspace (FS only). The SHARED workspace's touchWorkspace
  // call must happen exactly once — never N times. We verify this without
  // relying on the second-precision `last_indexed_at` column by instrumenting
  // the repository's touchWorkspace method directly.
  if (skipIfSqliteUnavailable(t, 'search-multi-root: shared source uniqueness')) return
  const Sqlite = loadSqliteCtor()!
  await withTempRoot(async (tmp) => {
    const dirA = join(tmp, 'a'); mkdirSync(dirA)
    const dirB = join(tmp, 'b'); mkdirSync(dirB)
    const dirC = join(tmp, 'c'); mkdirSync(dirC)
    writeMd(dirA, 'a.md', '# a\n')
    writeMd(dirB, 'b.md', '# b\n')
    writeMd(dirC, 'c.md', '# c\n')

    const db = openSchemaDb(Sqlite)
    try {
      const engine = new SearchEngine(db, { fts5Available: probeFts5Availability(db) })
      const repo = engine.getRepository()

      // Find SHARED workspace id (it's created on first reindexAllSources).
      // We'll resolve it after the first call.
      const touchCalls: Array<{ workspaceId: number; ts: number }> = []
      const originalTouch = repo.touchWorkspace.bind(repo)
      repo.touchWorkspace = ((workspaceId: number, ts: number) => {
        touchCalls.push({ workspaceId, ts })
        originalTouch(workspaceId, ts)
      }) as typeof repo.touchWorkspace

      // First root → reindexAllSources (FS + shared adapters).
      await engine.reindexAllSources({ root: dirA })
      // Subsequent roots → reindexWorkspace (FS only).
      await engine.reindexWorkspace({ root: dirB })
      await engine.reindexWorkspace({ root: dirC })

      // Resolve workspace IDs from the `workspaces` table.
      const allWorkspaces = db
        .prepare('SELECT id, root FROM workspaces')
        .all<{ id: number; root: string }>()
      const sharedRow = allWorkspaces.find((r) => r.root === '@shared')
      assert.ok(sharedRow, 'SHARED workspace row should exist after reindexAllSources')
      const sharedId = sharedRow.id
      const dirA_id = allWorkspaces.find((r) => r.root === dirA)?.id
      const dirB_id = allWorkspaces.find((r) => r.root === dirB)?.id
      const dirC_id = allWorkspaces.find((r) => r.root === dirC)?.id

      const sharedTouches = touchCalls.filter((c) => c.workspaceId === sharedId).length
      const aTouches = touchCalls.filter((c) => c.workspaceId === dirA_id).length
      const bTouches = touchCalls.filter((c) => c.workspaceId === dirB_id).length
      const cTouches = touchCalls.filter((c) => c.workspaceId === dirC_id).length

      // The contract: SHARED touched exactly once (during reindexAllSources),
      // each FS root touched at least once (each reindex call touches its own).
      assert.equal(sharedTouches, 1, `SHARED touchWorkspace expected 1, got ${sharedTouches} (full counts: ${JSON.stringify(touchCalls)})`)
      assert.ok(aTouches >= 1, 'rootA touched at least once')
      assert.ok(bTouches >= 1, 'rootB touched at least once')
      assert.ok(cTouches >= 1, 'rootC touched at least once')
    } finally {
      db.close()
    }
  })
})
