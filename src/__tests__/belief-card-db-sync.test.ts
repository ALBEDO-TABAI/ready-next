import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  syncBeliefCards,
  getBeliefCardMirrorBySlug,
  type MirrorDb,
  type BeliefCardMirrorRow,
} from '../main/modules/agent-control/knowledge/belief-card-mirror'

test('belief-card-db-sync declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'belief-card-db-sync transitive sqlite load')
})

// Minimal in-memory stand-in for agent_memory_metadata belief rows. Host-node
// cannot load the electron-ABI better-sqlite3, so the mirror is exercised
// against a fake that understands just the upsert + select-by-slug it issues.
function makeFakeDb(): MirrorDb & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    prepare(sql: string) {
      if (sql.includes('INSERT INTO agent_memory_metadata')) {
        return {
          run: (params: unknown) => {
            const p = params as Record<string, unknown>
            rows.set(String(p.id), { category: 'belief', ...p })
          },
          get: () => undefined,
          all: () => [],
        }
      }
      if (sql.includes('SELECT') && sql.includes('slug = ?')) {
        return {
          get: <R>(slug: unknown) => {
            for (const row of rows.values()) {
              if (row.category === 'belief' && row.slug === slug) return row as R
            }
            return undefined as R
          },
          run: () => undefined,
          all: () => [],
        }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
}

function fm(over: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '采集风险',
    description: '小红书脚本检测',
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-11',
    status: 'active',
    ...over,
  }
}

test('sync projects card fields into a mirror row; file is the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-mirror-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    store.writeCard({ relPath: 'knowledge/risk.md', frontmatter: fm({ confidence: 'M' }), body: 'b1' })
    const db = makeFakeDb()

    const r1 = syncBeliefCards(db, store)
    assert.equal(r1.synced, 1)
    assert.equal(r1.invalid, 0)
    const row1 = getBeliefCardMirrorBySlug(db, 'risk') as BeliefCardMirrorRow
    assert.equal(row1.confidence, 'M')
    assert.equal(row1.file_path, 'knowledge/risk.md')
    assert.equal(row1.status, 'active')
    const hash1 = row1.content_hash

    // edit the file (raise confidence + body) → re-sync reflects the file
    store.writeCard({ relPath: 'knowledge/risk.md', frontmatter: fm({ confidence: 'H' }), body: 'b2-changed' })
    syncBeliefCards(db, store)
    const row2 = getBeliefCardMirrorBySlug(db, 'risk') as BeliefCardMirrorRow
    assert.equal(row2.confidence, 'H')
    assert.notEqual(row2.content_hash, hash1, 'content_hash must change when the file changes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('staged cards are mirrored too (mirror is an index, not the injection gate)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-mirror-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    store.writeCard({ relPath: 'knowledge/s.md', frontmatter: fm({ status: 'staged' }), body: 'x' })
    const db = makeFakeDb()
    syncBeliefCards(db, store)
    const row = getBeliefCardMirrorBySlug(db, 's') as BeliefCardMirrorRow
    assert.equal(row.status, 'staged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt file becomes an invalid row and does not drop sibling rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-mirror-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    store.writeCard({ relPath: 'knowledge/good.md', frontmatter: fm(), body: 'ok' })
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'knowledge', 'broken.md'), 'no frontmatter', 'utf-8')
    const db = makeFakeDb()

    const res = syncBeliefCards(db, store)
    assert.equal(res.synced, 1)
    assert.equal(res.invalid, 1)
    const good = getBeliefCardMirrorBySlug(db, 'good') as BeliefCardMirrorRow
    assert.equal(good.status, 'active')
    const broken = getBeliefCardMirrorBySlug(db, 'broken') as BeliefCardMirrorRow
    assert.equal(broken.status, 'invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
