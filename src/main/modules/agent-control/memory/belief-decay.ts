/**
 * EP2-C6 — belief decay, deterministic subset (03 §2). Usage-signal-driven
 * promotion/demotion replaces pure time decay for belief cards. v1 is all
 * code, zero LLM; thresholds are configuration constants.
 *
 * Rules:
 *  - decay signals = stale created + zero backlinks + zero access, ALL three
 *    (合取). Demote one step per round (H→M→L) — never straight to delete.
 *  - at L with signals: first mark (source: decayed), only a marked card
 *    that STILL qualifies next round is deleted (先降档后删除, two-phase).
 *  - usage signals (was_useful or access threshold) promote one step.
 *  - possible-duplicate cards are never deleted here (标记不直删 — duplicate
 *    resolution belongs to the user via C1 marks).
 *  - coexists with the 30/90-day time decay for one release behind
 *    `beliefDecayEnabled` (rollback = flip the flag; time decay never
 *    touched belief rows — K6C §6 boundary).
 */

import { unlinkSync } from 'fs'
import { join } from 'path'
import { logAgentMetric } from '../metrics'
import { isPossibleDuplicateOfSource } from '../knowledge/reserved-card-source'
import type { BeliefCardStore } from '../knowledge/belief-card-store'

export type BeliefConfidence = 'H' | 'M' | 'L'

export interface BeliefDecaySignals {
  relPath: string
  confidence: BeliefConfidence
  /** frontmatter created, YYYY-MM-DD */
  created: string
  accessCount: number
  wasUsefulCount: number
  backlinksCount: number
  markedDecayed: boolean
  possibleDuplicate: boolean
}

export interface BeliefDecayDecision {
  action: 'keep' | 'promote' | 'demote' | 'mark_decayed' | 'delete'
  toConfidence?: BeliefConfidence
  reason: string
}

export const BELIEF_DECAY_THRESHOLDS = {
  /** created older than this with no links and no access = decay signal. */
  staleDays: 60,
  /** access count at/above this within the card's life promotes. */
  promoteAccessCount: 5,
  /** any positive was_useful signal promotes. */
  promoteUsefulCount: 1,
} as const

const DEMOTE: Record<BeliefConfidence, BeliefConfidence> = { H: 'M', M: 'L', L: 'L' }
const PROMOTE: Record<BeliefConfidence, BeliefConfidence> = { L: 'M', M: 'H', H: 'H' }

function daysSince(created: string, now: Date): number {
  const createdMs = Date.parse(`${created}T00:00:00.000Z`)
  if (!Number.isFinite(createdMs)) return 0
  return (now.getTime() - createdMs) / 86_400_000
}

export function decideBeliefDecay(signals: BeliefDecaySignals, now: Date): BeliefDecayDecision {
  const hasUsage = signals.wasUsefulCount >= BELIEF_DECAY_THRESHOLDS.promoteUsefulCount
    || signals.accessCount >= BELIEF_DECAY_THRESHOLDS.promoteAccessCount
  if (hasUsage) {
    if (signals.confidence === 'H') return { action: 'keep', reason: 'usage_signal_at_top' }
    return { action: 'promote', toConfidence: PROMOTE[signals.confidence], reason: 'usage_signal' }
  }

  // 三者合取：缺任何一个信号都不衰减
  const decaying = daysSince(signals.created, now) >= BELIEF_DECAY_THRESHOLDS.staleDays
    && signals.backlinksCount === 0
    && signals.accessCount === 0
  if (!decaying) return { action: 'keep', reason: 'no_decay_conjunction' }

  if (signals.confidence !== 'L') {
    return { action: 'demote', toConfidence: DEMOTE[signals.confidence], reason: 'decay_conjunction' }
  }
  // L 档：两阶段——先标 decayed，下一轮仍满足才删；疑似重复永不直删
  if (signals.possibleDuplicate) return { action: 'keep', reason: 'duplicate_never_deleted' }
  if (!signals.markedDecayed) return { action: 'mark_decayed', reason: 'decay_at_floor_first_pass' }
  return { action: 'delete', reason: 'decay_at_floor_second_pass' }
}

export interface BeliefDecayEffectors {
  setConfidence(relPath: string, confidence: BeliefConfidence): void
  markDecayed(relPath: string): void
  deleteCard(relPath: string): void
}

export interface BeliefDecayRoundReport {
  promoted: number
  demoted: number
  marked: number
  deleted: number
  kept: number
}

/** Apply one deterministic decay round; every transition writes an audit row. */
export function runBeliefDecayRound(
  cards: ReadonlyArray<BeliefDecaySignals>,
  effectors: BeliefDecayEffectors,
  now: Date,
): BeliefDecayRoundReport {
  const report: BeliefDecayRoundReport = { promoted: 0, demoted: 0, marked: 0, deleted: 0, kept: 0 }
  for (const signals of cards) {
    const decision = decideBeliefDecay(signals, now)
    switch (decision.action) {
      case 'promote':
        effectors.setConfidence(signals.relPath, decision.toConfidence!)
        report.promoted += 1
        break
      case 'demote':
        effectors.setConfidence(signals.relPath, decision.toConfidence!)
        report.demoted += 1
        break
      case 'mark_decayed':
        effectors.markDecayed(signals.relPath)
        report.marked += 1
        break
      case 'delete':
        effectors.deleteCard(signals.relPath)
        report.deleted += 1
        break
      default:
        report.kept += 1
        continue
    }
    logAgentMetric('belief_decay', {
      relPath: signals.relPath,
      action: decision.action,
      toConfidence: decision.toConfidence ?? null,
      reason: decision.reason,
    })
  }
  return report
}

/**
 * P5d deterministic-parts migration (2026-07-03) — collect per-card decay
 * signals from the store + belief mirror. MOVED here from maintenance-llm-round
 * (the dark LLM round) so the live decay wiring never imports the dormant file
 * (audit §4.3: "A2 与 A1 解耦"). `readMirror` returns access_count (bumped at
 * injection by P2-4) + wasUsefulCount (0 until a mirror column exists).
 */
export function collectBeliefDecaySignals(
  store: BeliefCardStore,
  readMirror: (relPath: string) => { accessCount: number; wasUsefulCount: number } | null,
  now: Date,
): BeliefDecaySignals[] {
  const files = store.listAllCardFilesAllScopes()
  const incoming = new Map<string, number>()
  for (const file of files) {
    if (!file.card) continue
    const matches = file.card.body.matchAll(/\[\[([^\][\n]+)\]\]/g)
    for (const match of matches) {
      const slug = match[1].trim()
      const key = `${file.scopeId}|${slug}`
      incoming.set(key, (incoming.get(key) ?? 0) + 1)
    }
  }
  return files.flatMap((file) => {
    if (!file.card) return []
    const slug = file.relPath.replace(/^.*\//, '').replace(/\.md$/, '')
    const mirror = readMirror(file.relPath)
    return [{
      relPath: file.relPath,
      confidence: file.card.frontmatter.confidence,
      created: file.card.frontmatter.created,
      accessCount: mirror?.accessCount ?? 0,
      wasUsefulCount: mirror?.wasUsefulCount ?? 0,
      backlinksCount: incoming.get(`${file.scopeId}|${slug}`) ?? 0,
      markedDecayed: String(file.card.frontmatter.source || '').includes('decayed'),
      possibleDuplicate: isPossibleDuplicateOfSource(file.card.frontmatter.source),
    }]
  })
}

/**
 * P5d — file-backed decay effectors (mirror crystallize-gate's pattern).
 * setConfidence/markDecayed rewrite frontmatter via the store; deleteCard
 * unlinks inside the memory root (idempotent, traversal-guarded). Only ever
 * invoked by `runBeliefDecayRound` whose decisions are conservative
 * (demote-before-delete, two-phase L deletion, duplicates never deleted).
 */
export function createBeliefDecayEffectors(store: BeliefCardStore): BeliefDecayEffectors {
  return {
    setConfidence(relPath, confidence) {
      const card = store.readCard(relPath, { includeStaged: true })
      if (!card) return
      store.writeCard({ relPath, frontmatter: { ...card.frontmatter, confidence }, body: card.body })
    },
    markDecayed(relPath) {
      const card = store.readCard(relPath, { includeStaged: true })
      if (!card) return
      const existing = String(card.frontmatter.source || '')
      if (existing.includes('decayed')) return
      const source = existing ? `${existing}; decayed` : 'decayed'
      store.writeCard({ relPath, frontmatter: { ...card.frontmatter, source }, body: card.body })
    },
    deleteCard(relPath) {
      if (relPath.includes('..')) return
      try { unlinkSync(join(store.rootPath, relPath)) } catch { /* idempotent — already gone */ }
    },
  }
}
