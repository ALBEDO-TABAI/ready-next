/**
 * P5d deterministic migration (2026-07-03) — belief-decay is now wired live
 * (runtime CrystallizeScheduler tick). This exercises the REAL file-backed
 * effectors + collector against a BeliefCardStore: fresh cards are kept, stale
 * cards demote-before-delete, and L-floor cards delete only on the second pass.
 * The safety property (never delete a used/recent card) is the whole point.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  collectBeliefDecaySignals,
  createBeliefDecayEffectors,
  runBeliefDecayRound,
} from '../main/modules/agent-control/memory/belief-decay'

const NOW = new Date('2026-07-03T00:00:00.000Z')
const STALE = '2026-01-01' // >60 days before NOW, decay-eligible
const FRESH = '2026-07-01' // recent, never decays

const fm = (title: string, confidence: 'H' | 'M' | 'L', created: string) => ({
  title, description: `d-${title}`, confidence, tag: 'knowledge' as const, created, status: 'active' as const,
})
// readMirror: every card unused (accessCount 0) so only age+backlinks gate decay.
const zeroMirror = () => ({ accessCount: 0, wasUsefulCount: 0 })

test('wired decay: fresh card kept, stale H demotes, stale L marks then deletes (two-phase)', () => {
  const root = mkdtempSync(join(tmpdir(), 'belief-decay-wire-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({ relPath: 'knowledge/fresh.md', frontmatter: fm('fresh', 'H', FRESH) as never, body: 'recent, no links' }).ok)
    assert.ok(store.writeCard({ relPath: 'knowledge/stale-h.md', frontmatter: fm('staleH', 'H', STALE) as never, body: 'old, no links' }).ok)
    assert.ok(store.writeCard({ relPath: 'knowledge/stale-l.md', frontmatter: fm('staleL', 'L', STALE) as never, body: 'old, no links' }).ok)

    const effectors = createBeliefDecayEffectors(store)

    // ── Round 1 ──
    const r1 = runBeliefDecayRound(collectBeliefDecaySignals(store, zeroMirror, NOW), effectors, NOW)
    assert.equal(r1.demoted, 1, 'stale H demotes once')
    assert.equal(r1.marked, 1, 'stale L marked_decayed (first pass)')
    assert.equal(r1.deleted, 0, 'nothing deleted on first pass')
    // fresh card untouched (kept)
    assert.equal(store.readCard('knowledge/fresh.md', { includeStaged: true })!.frontmatter.confidence, 'H')
    // stale H now M
    assert.equal(store.readCard('knowledge/stale-h.md', { includeStaged: true })!.frontmatter.confidence, 'M')
    // stale L still present, source marked decayed
    const staleL1 = store.readCard('knowledge/stale-l.md', { includeStaged: true })
    assert.ok(staleL1 && String(staleL1.frontmatter.source || '').includes('decayed'))

    // ── Round 2 (re-collect after mutations) ──
    const r2 = runBeliefDecayRound(collectBeliefDecaySignals(store, zeroMirror, NOW), effectors, NOW)
    assert.equal(r2.deleted, 1, 'marked stale L deletes on second pass')
    assert.equal(existsSync(join(root, 'knowledge/stale-l.md')), false, 'stale L file removed')
    assert.equal(r2.demoted, 1, 'stale M (was H) demotes to L')
    // fresh card STILL untouched after two rounds — the safety property
    assert.equal(store.readCard('knowledge/fresh.md', { includeStaged: true })!.frontmatter.confidence, 'H')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wired decay: a USED stale card is promoted/kept, never decayed', () => {
  const root = mkdtempSync(join(tmpdir(), 'belief-decay-used-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({ relPath: 'knowledge/used.md', frontmatter: fm('used', 'L', STALE) as never, body: 'old but used' }).ok)
    // accessCount ≥ promote threshold → usage signal wins over age
    const usedMirror = () => ({ accessCount: 9, wasUsefulCount: 0 })
    const r = runBeliefDecayRound(collectBeliefDecaySignals(store, usedMirror, NOW), createBeliefDecayEffectors(store), NOW)
    assert.equal(r.deleted, 0)
    assert.equal(r.promoted, 1, 'used stale card promotes, not decays')
    assert.ok(existsSync(join(root, 'knowledge/used.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
