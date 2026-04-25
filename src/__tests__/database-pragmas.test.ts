/**
 * SQLite PRAGMA tuning regression. The defaults (cache_size=2000 pages,
 * journal_mode=DELETE, synchronous=FULL, mmap_size=0) cause cache miss on
 * every query for a multi-GB DB; applyPerformancePragmas() fixes that. This
 * suite locks the post-tuning values so a future refactor cannot silently
 * regress the perf win.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyPerformancePragmas, type DatabaseConnection } from '../main/modules/database'

type SqliteCtor = new (path: string) => DatabaseConnection & {
  pragma(source: string, options?: { simple?: boolean }): unknown
}

function openInMemoryDb(): InstanceType<SqliteCtor> | null {
  // The native binding is built against Electron's Node ABI. When running this
  // test under system Node (npm run test / tsx --test), require() succeeds but
  // `new Sqlite()` throws ERR_DLOPEN_FAILED. Probe by actually constructing.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
    const Sqlite = mod.default || mod
    return new Sqlite(':memory:')
  } catch {
    return null
  }
}

test('applyPerformancePragmas tunes journal/sync/cache/mmap/temp_store', (t) => {
  const db = openInMemoryDb()
  if (!db) {
    t.skip('better-sqlite3 native binding unavailable (likely ABI mismatch with system Node; runs under Electron)')
    return
  }
  try {
    applyPerformancePragmas(db)

    const journalMode = db.pragma('journal_mode', { simple: true })
    const synchronous = db.pragma('synchronous', { simple: true })
    const cacheSize = db.pragma('cache_size', { simple: true })
    const mmapSize = db.pragma('mmap_size', { simple: true })
    const tempStore = db.pragma('temp_store', { simple: true })

    // Note: in-memory DBs cannot use WAL, so journal_mode falls back to 'memory'.
    // On a real on-disk DB the value will be 'wal'. Accept either so the test
    // runs deterministically across CI / dev shells without touching the
    // filesystem.
    assert.ok(
      journalMode === 'wal' || journalMode === 'memory',
      `journal_mode expected 'wal' or 'memory', got ${String(journalMode)}`,
    )

    // synchronous: NORMAL=1, FULL=2, OFF=0
    assert.equal(synchronous, 1, `synchronous expected NORMAL (1), got ${String(synchronous)}`)

    // cache_size: we set -65536 (KB). better-sqlite3 echoes the negative value
    // back when queried, so the spread is bounded — anything more negative than
    // -2000 (the default) confirms the new setting took effect.
    assert.equal(typeof cacheSize, 'number', `cache_size expected number, got ${typeof cacheSize}`)
    assert.ok(
      Number(cacheSize) <= -65536,
      `cache_size expected <= -65536 KB, got ${String(cacheSize)}`,
    )

    // mmap_size > 0 confirms mmap window is open. SQLite may clamp to its
    // compile-time SQLITE_MAX_MMAP_SIZE on some platforms, so just assert > 0.
    assert.equal(typeof mmapSize, 'number', `mmap_size expected number, got ${typeof mmapSize}`)
    assert.ok(Number(mmapSize) > 0, `mmap_size expected > 0, got ${String(mmapSize)}`)

    // temp_store: DEFAULT=0, FILE=1, MEMORY=2
    assert.equal(tempStore, 2, `temp_store expected MEMORY (2), got ${String(tempStore)}`)
  } finally {
    db.close()
  }
})

test('applyPerformancePragmas no-ops when pragma() is missing', () => {
  // Mimics the in-memory mock fallback path where pragma is not implemented.
  const fakeDb: DatabaseConnection = {
    exec: () => {},
    prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
    close: () => {},
  }
  // Should not throw.
  assert.doesNotThrow(() => applyPerformancePragmas(fakeDb))
})

test('applyPerformancePragmas swallows per-pragma failures and continues', () => {
  // Simulate a platform where one pragma fails (e.g. WAL on a Windows network
  // drive). The helper must continue applying the rest, not bail.
  const applied: string[] = []
  const fakeDb: DatabaseConnection = {
    exec: () => {},
    prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
    close: () => {},
    pragma: (source: string) => {
      applied.push(source)
      if (source.startsWith('journal_mode')) {
        throw new Error('WAL not supported on this filesystem')
      }
      return [{ result: 'ok' }]
    },
  }
  assert.doesNotThrow(() => applyPerformancePragmas(fakeDb))
  // Five tuning pragmas + one user_version diagnostic read.
  assert.equal(applied.length, 6, `expected 6 pragma calls, got ${applied.length}: ${applied.join(', ')}`)
  assert.ok(applied.some((s) => s.startsWith('synchronous')), 'synchronous pragma should still run after WAL failure')
  assert.ok(applied.some((s) => s.startsWith('user_version')), 'user_version diagnostic should still run after WAL failure')
})
