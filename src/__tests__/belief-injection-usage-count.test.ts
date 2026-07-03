/**
 * P2-4 (2026-07-03) — belief usage counting. `renderKnowledgeIndex` now reports
 * which cards it injected (`renderedRelPaths`), and `bumpBeliefCardAccess`
 * increments those mirror rows' access_count so decay signals (belief-decay.ts)
 * and "is this belief used?" metrics stop reading a permanent 0.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { bumpBeliefCardAccess, type MirrorDb } from '../main/modules/agent-control/knowledge/belief-card-mirror'

// In-memory stand-in for agent_memory_metadata belief rows that understands the
// UPDATE bumpBeliefCardAccess issues (host-node can't load the electron ABI).
function makeFakeDb(seed: Array<{ file_path: string; access_count: number }>): MirrorDb & { get: (fp: string) => number } {
  const rows = new Map<string, { access_count: number; last_accessed_at: number | null }>()
  for (const r of seed) rows.set(r.file_path, { access_count: r.access_count, last_accessed_at: null })
  return {
    get: (fp: string) => rows.get(fp)?.access_count ?? -1,
    prepare(sql: string) {
      if (sql.includes('UPDATE agent_memory_metadata') && sql.includes('access_count')) {
        return {
          run: (filePath: unknown) => {
            const row = rows.get(String(filePath))
            if (!row) return { changes: 0 }
            row.access_count += 1
            row.last_accessed_at = 1
            return { changes: 1 }
          },
          get: () => undefined,
          all: () => [],
        }
      }
      return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
    },
  } as unknown as MirrorDb & { get: (fp: string) => number }
}

test('bumpBeliefCardAccess increments existing belief rows, ignores missing, dedupes', () => {
  const db = makeFakeDb([{ file_path: 'a.md', access_count: 0 }, { file_path: 'b.md', access_count: 5 }])
  const updated = bumpBeliefCardAccess(db, ['a.md', 'b.md', 'a.md', 'missing.md', ''])
  // a.md + b.md updated once each (a.md deduped); missing/empty ignored.
  assert.equal(updated, 2)
  assert.equal(db.get('a.md'), 1)
  assert.equal(db.get('b.md'), 6)
})

test('bumpBeliefCardAccess on empty list is a no-op', () => {
  const db = makeFakeDb([{ file_path: 'a.md', access_count: 0 }])
  assert.equal(bumpBeliefCardAccess(db, []), 0)
  assert.equal(db.get('a.md'), 0)
})

const activeFm = (title: string, confidence: 'H' | 'M' | 'L') => ({
  title,
  description: `desc-${title}`,
  confidence,
  tag: 'knowledge' as const,
  created: '2026-01-01',
  status: 'active' as const,
})

test('renderKnowledgeIndex reports renderedRelPaths for the cards it injected', () => {
  const root = mkdtempSync(join(tmpdir(), 'belief-usage-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({ relPath: 'knowledge/one.md', frontmatter: activeFm('one', 'H') as never, body: 'body one' }).ok)
    assert.ok(store.writeCard({ relPath: 'knowledge/two.md', frontmatter: activeFm('two', 'M') as never, body: 'body two' }).ok)
    const index = store.renderKnowledgeIndex({ maxChars: 10_000 })
    assert.equal(index.renderedCount, index.renderedRelPaths.length)
    assert.equal(index.renderedRelPaths.length, 2)
    assert.ok(index.renderedRelPaths.some((p) => p.endsWith('one.md')))
    assert.ok(index.renderedRelPaths.some((p) => p.endsWith('two.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('renderKnowledgeIndex renderedRelPaths respects the maxChars budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'belief-usage-2-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    for (let i = 0; i < 5; i++) {
      assert.ok(store.writeCard({ relPath: `knowledge/c${i}.md`, frontmatter: activeFm(`card-${i}`, 'H') as never, body: 'body' }).ok)
    }
    const index = store.renderKnowledgeIndex({ maxChars: 70 })
    // Budget clips the list; renderedRelPaths matches exactly what text contains.
    assert.ok(index.renderedRelPaths.length >= 1 && index.renderedRelPaths.length < 5)
    for (const rel of index.renderedRelPaths) assert.ok(index.text.includes(rel))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
