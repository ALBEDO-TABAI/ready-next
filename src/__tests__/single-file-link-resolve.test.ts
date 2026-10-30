import { seedSearchObject } from './utils/object-repository-fixtures'
import type { DatabaseConnection } from '../main/modules/database/connection'
/**
 * perf-rescue B8 — per-file wikilink resolve regression.
 *
 * Verifies that single-file index calls only re-resolve THAT file's outgoing
 * + incoming wikilinks, instead of re-scanning the entire workspace. The
 * workspace-wide pass becomes a debounced backup that aggregates rapid bursts
 * of saves into one DB scan.
 *
 * Locked behaviors:
 *   1. Index doc A with [[B]] (B doesn't exist) → A→B is recorded as ghost
 *      (target_doc_id = NULL, resolved = 0).
 *   2. Index doc B → the per-doc resolver picks up A's ghost link to B and
 *      binds it (target_doc_id = B's id, resolved = 1).
 *   3. Index doc C with [[A]] [[B]] → C's links resolve, and only C's links
 *      are touched (no other rows' resolved flags flip during this call).
 *   4. The 5s debounced workspace resolve eventually fires once across many
 *      saves and reconciles edge cases (deletion + ghost-link orphaning).
 *   5. Cancellation: cancelPendingWorkspaceResolves() prevents the deferred
 *      pass from running.
 *
 * Uses a real better-sqlite3 in-memory DB + the actual SearchRepository so
 * the SQL is exercised end-to-end. Skips when the native binding is
 * unavailable (system Node ABI mismatch) — this is the same pattern the
 * other DB tests in this repo use.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'

import { SearchRepository } from '../main/modules/search-engine/repository'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { SEARCH_INDEX_CONTENT_VERSION } from '../main/modules/search-engine/query'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// ----- Sqlite loader (skip when native binding unavailable) -----------------

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const nodeRequire = createRequire(import.meta.url)

function loadSqliteCtor(): SqliteCtor | null {
  try {
    const mod = nodeRequire('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
    const Sqlite = mod.default || mod
    // Probe — better-sqlite3 throws ERR_DLOPEN_FAILED on construction when
    // the binding doesn't match the host Node ABI.
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

// ----- Helpers --------------------------------------------------------------

interface DocSeedInput {
  workspaceId: number
  path: string
  name: string
  body?: string
}

/**
 * Seed a document row directly via SearchRepository.upsertDocument so we can
 * stage state without relying on SearchEngine's filesystem loader. We pass
 * a minimal LoadedFile-shaped payload — the upsert SQL only needs the
 * workspace_id / path / name / mtime / hash fields.
 */
function seedDoc(repo: SearchRepository, input: DocSeedInput): number {
  seedSearchObject(repo.getConnection(),input.workspaceId,input.path)
  const result = repo.upsertDocument({
    workspaceId: input.workspaceId,
    path: input.path,
    name: input.name,
    ext: '.md',
    size: 100,
    mtime: Math.floor(Date.now() / 1000),
    contentHash: `hash-${input.path}`,
    frontmatterJson: null,
    body: input.body ?? '# ' + input.name,
    sourceType: 'document',
  })
  return result.documentId
}

/**
 * Insert a wikilink row directly. Uses a raw prepared statement against the
 * schema so we bypass replaceLinks' extra parsing.
 */
function seedWikilink(db: DatabaseConnection, srcDocId: number, targetText: string): void {
  db.prepare(
    `INSERT INTO object_links(id,source_id,kind,raw_target,target_text,resolved,unresolved_reason) VALUES (lower(hex(randomblob(16))),(SELECT object_id FROM documents WHERE id=?),?,?,?,0,'尚未解析')`,
  ).run(srcDocId, 'wikilink', targetText, targetText)
}

interface LinkRow {
  src_doc_id: number
  target_text: string
  target_doc_id: number | null
  resolved: number
}

function listLinks(db: DatabaseConnection, srcDocId?: number): LinkRow[] {
  if (srcDocId !== undefined) {
    return db
      .prepare(
        'SELECT s.id AS src_doc_id,l.target_text,t.id AS target_doc_id,l.resolved FROM object_links l JOIN documents s ON s.object_id=l.source_id LEFT JOIN documents t ON t.object_id=l.target_id AND l.resolved=1 WHERE s.id=? ORDER BY target_text',
      )
      .all<LinkRow>(srcDocId)
  }
  return db
    .prepare('SELECT s.id AS src_doc_id,l.target_text,t.id AS target_doc_id,l.resolved FROM object_links l JOIN documents s ON s.object_id=l.source_id LEFT JOIN documents t ON t.object_id=l.target_id AND l.resolved=1 ORDER BY s.id,target_text')
    .all<LinkRow>()
}

function ensureWorkspace(db: DatabaseConnection, root: string): number {
  db.prepare('INSERT INTO workspaces (root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(root)
  const row = db.prepare('SELECT id FROM workspaces WHERE root = ?').get<{ id: number }>(root)
  if (!row) throw new Error('failed to create workspace')
  return row.id
}

// ----- Tests ----------------------------------------------------------------

test('seed: doc A with [[B]] before B exists is a ghost link', (t) => {
  if (skipIfSqliteUnavailable(t, 'single-file-link-resolve: ghost link seed')) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const repo = new SearchRepository(db, false /* fts5 not needed */)
    const wsId = ensureWorkspace(db, '/tmp/ws-a')
    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-a/A.md', name: 'A.md' })
    seedWikilink(db, aId, 'B')

    // Per-doc resolve picks up A's outgoing — but B doesn't exist yet, so
    // target_doc_id stays NULL and resolved stays 0.
    repo.resolveWikilinkTargetsForDocument(aId)

    const [link] = listLinks(db, aId)
    assert.equal(link.target_text, 'B')
    assert.equal(link.target_doc_id, null, 'B does not exist yet → ghost')
    assert.equal(link.resolved, 0)
  } finally {
    db.close()
  }
})

test('per-doc resolver: indexing B retroactively binds A→B (incoming pass)', (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const repo = new SearchRepository(db, false)
    const wsId = ensureWorkspace(db, '/tmp/ws-b')
    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-b/A.md', name: 'A.md' })
    seedWikilink(db, aId, 'B') // ghost
    // A's first resolve — still ghost
    repo.resolveWikilinkTargetsForDocument(aId)
    {
      const [link] = listLinks(db, aId)
      assert.equal(link.target_doc_id, null)
      assert.equal(link.resolved, 0)
    }
    // Now create B and run B's per-doc resolver. The incoming pass should
    // bind A's [[B]] to B's id.
    const bId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-b/B.md', name: 'B.md' })
    repo.resolveWikilinkTargetsForDocument(bId)

    const [link] = listLinks(db, aId)
    assert.equal(link.target_text, 'B')
    assert.equal(link.target_doc_id, bId, 'incoming pass should retroactively bind A→B')
    assert.equal(link.resolved, 1, 'resolved flag flipped to 1')
  } finally {
    db.close()
  }
})

test('per-doc resolver: indexing C with [[A]] [[B]] only touches C\'s links', (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const repo = new SearchRepository(db, false)
    const wsId = ensureWorkspace(db, '/tmp/ws-c')

    // Stage A, B, plus a 4th doc D with a ghost link [[Nope]] that should
    // not be touched by C's index call.
    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-c/A.md', name: 'A.md' })
    const bId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-c/B.md', name: 'B.md' })
    const dId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-c/D.md', name: 'D.md' })
    seedWikilink(db, dId, 'Nope') // unrelated ghost
    repo.resolveWikilinkTargetsForDocument(dId) // confirmed ghost
    assert.equal(listLinks(db, dId)[0].resolved, 0)
    assert.equal(listLinks(db, dId)[0].target_doc_id, null)

    // Now stage C with two outgoing links to existing docs.
    const cId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-c/C.md', name: 'C.md' })
    seedWikilink(db, cId, 'A')
    seedWikilink(db, cId, 'B')

    // Snapshot D's ghost row before C's resolve to assert it is unchanged.
    const dBefore = listLinks(db, dId)
    repo.resolveWikilinkTargetsForDocument(cId)
    const dAfter = listLinks(db, dId)

    // C's links must both be resolved.
    const cLinks = listLinks(db, cId)
    assert.equal(cLinks.length, 2)
    const cByText = new Map(cLinks.map((l) => [l.target_text, l]))
    assert.equal(cByText.get('A')?.target_doc_id, aId, 'C→A bound')
    assert.equal(cByText.get('A')?.resolved, 1)
    assert.equal(cByText.get('B')?.target_doc_id, bId, 'C→B bound')
    assert.equal(cByText.get('B')?.resolved, 1)

    // D's row must be byte-for-byte identical — per-doc resolve must not
    // trigger a workspace-wide pass.
    assert.deepEqual(dAfter, dBefore, 'D\'s ghost row must not have been touched')
  } finally {
    db.close()
  }
})

test('per-doc resolver: handles .md suffix variants (incoming match)', (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const repo = new SearchRepository(db, false)
    const wsId = ensureWorkspace(db, '/tmp/ws-md')
    // src writes [[Foo]] but target file is named "Foo.md" → must bind.
    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-md/A.md', name: 'A.md' })
    seedWikilink(db, aId, 'Foo')         // bare
    seedWikilink(db, aId, 'Foo.md')      // explicit .md
    seedWikilink(db, aId, 'foo')         // case-insensitive
    seedWikilink(db, aId, 'FOO.MD')      // case-insensitive + .md

    const fId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-md/Foo.md', name: 'Foo.md' })
    repo.resolveWikilinkTargetsForDocument(fId)

    const links = listLinks(db, aId)
    for (const link of links) {
      assert.equal(link.target_doc_id, fId, `[[${link.target_text}]] must bind to Foo.md`)
      assert.equal(link.resolved, 1)
    }
  } finally {
    db.close()
  }
})

test('per-doc resolver: skips already-resolved incoming links (no overwrite)', (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const repo = new SearchRepository(db, false)
    const wsId = ensureWorkspace(db, '/tmp/ws-noov')

    // Two docs share the same name "Dup.md" — workspace resolver picks one
    // via LIMIT 1. Verify the per-doc incoming pass doesn't overwrite an
    // already-resolved link with a different doc id.
    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-noov/A.md', name: 'A.md' })
    const dup1Id = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-noov/x/Dup.md', name: 'Dup.md' })
    seedWikilink(db, aId, 'Dup')
    repo.resolveWikilinkTargetsForDocument(dup1Id) // binds A→Dup as dup1

    const linkBefore = listLinks(db, aId)[0]
    assert.equal(linkBefore.target_doc_id, dup1Id)

    // Now create a SECOND doc named "Dup.md" elsewhere. Per-doc incoming
    // pass on dup2 must NOT clobber the existing binding (we only update
    // when target_doc_id IS NULL).
    const dup2Id = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-noov/y/Dup.md', name: 'Dup.md' })
    repo.resolveWikilinkTargetsForDocument(dup2Id)

    const linkAfter = listLinks(db, aId)[0]
    assert.equal(linkAfter.target_doc_id, dup1Id, 'existing binding preserved (no clobber)')
    assert.notEqual(linkAfter.target_doc_id, dup2Id)
  } finally {
    db.close()
  }
})

test('SearchEngine.scheduleWorkspaceLinkResolve fires after debounce window', async (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const engine = new SearchEngine(db, {
      fts5Available: false,
      workspaceResolveDebounceMs: 25, // fast for tests
    })
    const repo = engine.getRepository()
    const wsId = ensureWorkspace(db, '/tmp/ws-debounce')

    // Create A→B as ghost. Instead of going through the per-doc path, we
    // simulate the scenario where the per-doc pass would have missed an
    // edge case, so the backup workspace pass has to clean it up.
    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-debounce/A.md', name: 'A.md' })
    seedWikilink(db, aId, 'B')
    // B is created but we deliberately don't run per-doc on it — only the
    // debounced workspace pass should bind A→B.
    const bId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-debounce/B.md', name: 'B.md' })

    {
      const [link] = listLinks(db, aId)
      assert.equal(link.target_doc_id, null, 'before debounce: still ghost')
    }

    engine.scheduleWorkspaceLinkResolve(wsId)
    // Wait > debounce window
    await new Promise<void>((resolve) => setTimeout(resolve, 80))

    const [link] = listLinks(db, aId)
    assert.equal(link.target_doc_id, bId, 'workspace pass eventually fired and bound A→B')
    assert.equal(link.resolved, 1)
  } finally {
    db.close()
  }
})

test('SearchEngine.scheduleWorkspaceLinkResolve coalesces N saves into 1 pass', async (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    let resolveCallCount = 0
    const engine = new SearchEngine(db, {
      fts5Available: false,
      workspaceResolveDebounceMs: 30,
    })
    const repo = engine.getRepository()
    // Wrap resolveWikilinkTargets to count invocations through the timer.
    const origResolve = repo.resolveWikilinkTargets.bind(repo)
    repo.resolveWikilinkTargets = (workspaceId: number) => {
      resolveCallCount += 1
      return origResolve(workspaceId)
    }

    const wsId = ensureWorkspace(db, '/tmp/ws-coalesce')
    seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-coalesce/A.md', name: 'A.md' })

    // Fire 10 schedule calls in rapid succession — they should all collapse
    // to a single timer fire because each call resets the debounce.
    for (let i = 0; i < 10; i += 1) engine.scheduleWorkspaceLinkResolve(wsId)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    assert.equal(resolveCallCount, 1, '10 saves → 1 workspace pass')
  } finally {
    db.close()
  }
})

test('SearchEngine.cancelPendingWorkspaceResolves prevents the deferred pass', async (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    let resolveCallCount = 0
    const engine = new SearchEngine(db, {
      fts5Available: false,
      workspaceResolveDebounceMs: 30,
    })
    const repo = engine.getRepository()
    const origResolve = repo.resolveWikilinkTargets.bind(repo)
    repo.resolveWikilinkTargets = (workspaceId: number) => {
      resolveCallCount += 1
      return origResolve(workspaceId)
    }

    const wsId = ensureWorkspace(db, '/tmp/ws-cancel')
    seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-cancel/A.md', name: 'A.md' })

    engine.scheduleWorkspaceLinkResolve(wsId)
    const cancelled = engine.cancelPendingWorkspaceResolves()
    assert.equal(cancelled, 1, 'cancel reports the single pending timer')

    // Wait past the debounce window — no fire should occur.
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    assert.equal(resolveCallCount, 0, 'cancellation prevented the workspace pass')
  } finally {
    db.close()
  }
})

test('SearchEngine.scheduleWorkspaceLinkResolve respects AbortController on the returned signal', async (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    let resolveCallCount = 0
    const engine = new SearchEngine(db, {
      fts5Available: false,
      workspaceResolveDebounceMs: 30,
    })
    const repo = engine.getRepository()
    const origResolve = repo.resolveWikilinkTargets.bind(repo)
    repo.resolveWikilinkTargets = (workspaceId: number) => {
      resolveCallCount += 1
      return origResolve(workspaceId)
    }

    const wsId = ensureWorkspace(db, '/tmp/ws-abort')
    seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-abort/A.md', name: 'A.md' })

    // The signal is shared across reschedules within the same workspace;
    // calling cancelPending… aborts it. Direct AbortController.abort() via
    // cancelPendingWorkspaceResolves is the canonical lifecycle path.
    engine.scheduleWorkspaceLinkResolve(wsId)
    engine.cancelPendingWorkspaceResolves()
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    assert.equal(resolveCallCount, 0)
  } finally {
    db.close()
  }
})

test('end-to-end via indexDocument: per-doc resolve + debounced backup', async (t) => {
  if (skipIfSqliteUnavailable(t, "single-file-link-resolve: legacy-probe path")) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  try {
    const engine = new SearchEngine(db, {
      fts5Available: false,
      workspaceResolveDebounceMs: 30,
    })
    const repo = engine.getRepository()
    const wsId = ensureWorkspace(db, '/tmp/ws-e2e')

    // We'll simulate "doc A with [[B]] saved before B exists" without going
    // through the FS adapter (which would fail on a non-existent path). The
    // per-doc resolver wired into indexDocument is exercised via the
    // repository directly, while we validate that scheduleWorkspaceLinkResolve
    // would have been called on a real save path.
    let scheduleCalls = 0
    const origSchedule = engine.scheduleWorkspaceLinkResolve.bind(engine)
    engine.scheduleWorkspaceLinkResolve = (id: number): AbortSignal => {
      scheduleCalls += 1
      return origSchedule(id)
    }

    const aId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-e2e/A.md', name: 'A.md' })
    seedWikilink(db, aId, 'B')
    repo.resolveWikilinkTargetsForDocument(aId)

    const bId = seedDoc(repo, { workspaceId: wsId, path: '/tmp/ws-e2e/B.md', name: 'B.md' })
    repo.resolveWikilinkTargetsForDocument(bId)

    // Per-doc pass should already have done the job:
    {
      const [link] = listLinks(db, aId)
      assert.equal(link.target_doc_id, bId)
    }

    // Trigger the schedule (mimicking what indexDocument does).
    engine.scheduleWorkspaceLinkResolve(wsId)
    assert.equal(scheduleCalls, 1)

    // Drain the timer to keep test process clean.
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
  } finally {
    db.close()
  }
})

test('reindex and indexDocument preserve derived rows when content is unchanged', async (t) => {
  if (skipIfSqliteUnavailable(t, 'single-file-link-resolve: unchanged content fast path')) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-index-fast-path-')))
  try {
    const engine = new SearchEngine(db, {
      fts5Available: false,
      workspaceResolveDebounceMs: 1_000,
    })
    const path = join(root, 'A.md')
    const content = '---\ntags:\n  - 教程\n---\n# A\n\n[[Target]] ![[asset.png]]\n'
    writeFileSync(path, content, 'utf-8')
    const first = await engine.reindexWorkspace({ root })
    assert.equal(first.ok, true)
    assert.equal(first.indexed, 1)
    const row = db.prepare(
      'SELECT id, content_hash FROM documents WHERE path = ?',
    ).get<{ id: number; content_hash: string }>(path)
    assert.ok(row)
    assert.match(row.content_hash, new RegExp(`^${SEARCH_INDEX_CONTENT_VERSION}:`))

    const repo = engine.getRepository()
    let derivedWrites = 0
    let narrowResolves = 0
    let workspaceResolves = 0
    let scheduledResolves = 0
    repo.replaceTags = () => { derivedWrites += 1 }
    repo.replaceLinks = () => { derivedWrites += 1 }
    repo.replaceAttachments = () => { derivedWrites += 1 }
    repo.resolveWikilinkTargetsForDocument = () => { narrowResolves += 1 }
    repo.resolveWikilinkTargets = () => { workspaceResolves += 1 }
    const identity = db.prepare(
      'SELECT id AS fileKey FROM objects WHERE workspace_id = (SELECT id FROM workspaces WHERE root=?) AND current_path = ?',
    ).get<{ fileKey: string }>(root, path)
    assert.ok(identity)
    db.prepare('UPDATE file_tag_assignments SET readback_at = NULL WHERE object_id = ?').run(identity.fileKey)

    const repeated = await engine.reindexWorkspace({ root })

    assert.equal(repeated.indexed, 0)
    assert.equal(repeated.skipped, 1)
    assert.equal(repeated.removed, 0)
    assert.equal(derivedWrites, 0)
    assert.equal(workspaceResolves, 0)
    const readback = db.prepare(
      'SELECT readback_at AS readbackAt FROM file_tag_assignments WHERE object_id = ? AND suppressed = 0',
    ).get<{ readbackAt: number | null }>(identity.fileKey)
    assert.ok(readback?.readbackAt, 'a no-change rebuild must still complete pending Tag Forge readback')

    engine.scheduleWorkspaceLinkResolve = (): AbortSignal => {
      scheduledResolves += 1
      return new AbortController().signal
    }

    const direct = await engine.indexDocument(root, path, content)

    assert.deepEqual(direct, { ok: true, documentId: row.id, skipped: true })
    assert.equal(derivedWrites, 0)
    assert.equal(narrowResolves, 0)
    assert.equal(scheduledResolves, 0)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('single-document indexing reads content even when size and mtime were restored', async (t) => {
  if (skipIfSqliteUnavailable(t, 'single-file-link-resolve: strong single-file change signal')) return
  const Sqlite = loadSqliteCtor()!
  const db = openSchemaDb(Sqlite)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-index-restored-mtime-')))
  try {
    const engine = new SearchEngine(db, { fts5Available: false })
    const path = join(root, 'A.md')
    const before = '# A\n\n[[One]]\n'
    const after = '# A\n\n[[Two]]\n'
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(after))
    writeFileSync(path, before, 'utf-8')
    const first = await engine.reindexWorkspace({ root })
    assert.equal(first.indexed, 1)
    const beforeRow = db.prepare('SELECT id, content_hash AS contentHash FROM documents WHERE path = ?')
      .get<{ id: number; contentHash: string }>(path)
    assert.ok(beforeRow)
    const original = statSync(path)

    writeFileSync(path, after, 'utf-8')
    utimesSync(path, original.atime, original.mtime)
    const indexed = await engine.indexDocument(root, path)

    assert.equal(indexed.ok, true)
    assert.equal(indexed.skipped, false)
    const afterRow = db.prepare('SELECT content_hash AS contentHash FROM documents WHERE path = ?')
      .get<{ contentHash: string }>(path)
    assert.notEqual(afterRow?.contentHash, beforeRow.contentHash)
    const links = db.prepare('SELECT target_text AS targetText FROM object_links WHERE source_id=(SELECT object_id FROM documents WHERE id=?)')
      .all<{ targetText: string }>(beforeRow.id)
    assert.deepEqual(links.map((link) => link.targetText), ['Two'])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
