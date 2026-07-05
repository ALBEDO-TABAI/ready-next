/**
 * LIVE (P5d cluster deterministic-parts migration, 2026-07-03): wired into
 * production via runtime.ts `CrystallizeScheduler` (startup + 6h), emitting a
 * `crystallize_round_fired` ledger. The LLM maintenance round + emergence feed
 * stay deferred; only the deterministic crystallize + belief-decay rounds are live.
 *
 * EP2-C2 — deterministic crystallize gate + v1 round runner (03 §3.2/§6).
 *
 * Gate: pure code decides run/skip BEFORE any expensive work — skip is a
 * legal outcome that leaves a single auditable breadcrumb (单行 JSON 进
 * maintenance 日志). 门控管跑不跑，回合内管做不做 — two separate layers.
 *
 * v1 round: ONLY the C1 deterministic plan (backlinks rewrite, index.md,
 * staged expiry, duplicate marking). No LLM turn exists in v1 (03 §6 分期
 * 原则); C3 adds the model round later behind this same gate.
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { logAgentMetric } from '../metrics'
import { POSSIBLE_DUPLICATE_OF_PREFIX } from '../knowledge/reserved-card-source'
import { buildKnowledgeGraphPlan } from '../knowledge/knowledge-index-builder'
import type { BeliefCardStore } from '../knowledge/belief-card-store'

export interface CrystallizeSignals {
  lastRunAt: string | null
  newCheckInsWithLearning: number
  newConversationTurns: number
  cardWritesSinceLast: number
  memoryFileMtimeChanged: boolean
  forced: boolean
}

export interface CrystallizeGateDecision {
  decision: 'run' | 'skip'
  reason: string
  signals: CrystallizeSignals
}

const MIN_INTERVAL_MINUTES = 360 // 6h — aligned with MemoryLifecycleManager
const TURN_THRESHOLD = 20

export function decideCrystallizeRun(
  signals: CrystallizeSignals,
  now: Date,
  opts: { minIntervalMinutes?: number; turnThreshold?: number } = {},
): CrystallizeGateDecision {
  const minInterval = opts.minIntervalMinutes ?? MIN_INTERVAL_MINUTES
  const turnThreshold = opts.turnThreshold ?? TURN_THRESHOLD
  if (signals.forced) return { decision: 'run', reason: 'forced', signals }
  if (!signals.lastRunAt) return { decision: 'run', reason: 'never_ran', signals }
  const elapsedMinutes = (now.getTime() - Date.parse(signals.lastRunAt)) / 60_000
  if (elapsedMinutes >= minInterval) return { decision: 'run', reason: 'interval_elapsed', signals }
  if (signals.newCheckInsWithLearning > 0) return { decision: 'run', reason: 'learning_checkins', signals }
  if (signals.cardWritesSinceLast > 0) return { decision: 'run', reason: 'card_writes', signals }
  if (signals.memoryFileMtimeChanged) return { decision: 'run', reason: 'memory_file_changed', signals }
  if (signals.newConversationTurns >= turnThreshold) return { decision: 'run', reason: 'turn_threshold', signals }
  return { decision: 'skip', reason: 'quiet_within_interval', signals }
}

/** Effectors apply the plan — injected so the round is testable and the
 *  filesystem surface stays in one place. */
export interface CrystallizeEffectors {
  applyCardBody(relPath: string, body: string): void
  markDuplicate(relPath: string, duplicateOfSlug: string): void
  deleteCard(relPath: string): void
  writeIndexFile(markdown: string): void
}

export function createCrystallizeEffectors(store: BeliefCardStore): CrystallizeEffectors {
  return {
    applyCardBody(relPath, body) {
      const card = store.readCard(relPath, { includeStaged: true })
      if (!card) return
      store.writeCard({ relPath, frontmatter: card.frontmatter, body })
    },
    markDuplicate(relPath, duplicateOfSlug) {
      const card = store.readCard(relPath, { includeStaged: true })
      if (!card) return
      store.writeCard({
        relPath,
        frontmatter: { ...card.frontmatter, source: `${POSSIBLE_DUPLICATE_OF_PREFIX} [[${duplicateOfSlug}]]` },
        body: card.body,
      })
    },
    deleteCard(relPath) {
      // staged-expiry only; the path came from the store listing, but guard
      // against traversal anyway by resolving inside the root.
      if (relPath.includes('..')) return
      try { unlinkSync(join(store.rootPath, relPath)) } catch { /* silent-catch: already gone — expiry is idempotent */ }
    },
    writeIndexFile(markdown) {
      // index.md lives at the memory root (01 §7b DEFAULT_FILES contract).
      writeFileSync(join(store.rootPath, 'index.md'), markdown, 'utf-8')
    },
  }
}

export interface CrystallizeRoundReport {
  backlinksRewritten: number
  expiredStagedDeleted: number
  duplicatesMarked: number
  invalidCards: number
  orphanLinks: number
}

export interface CrystallizeRoundResult {
  decision: 'run' | 'skip'
  reason: string
  report?: CrystallizeRoundReport
}

export async function runCrystallizeRound(params: {
  signals: CrystallizeSignals
  now: Date
  store: BeliefCardStore
  effectors: CrystallizeEffectors
}): Promise<CrystallizeRoundResult> {
  const gate = decideCrystallizeRun(params.signals, params.now)
  if (gate.decision === 'skip') {
    logAgentMetric('maintenance_audit', { decision: 'skip', reason: gate.reason, signals: gate.signals })
    return { decision: 'skip', reason: gate.reason }
  }

  // EP4-K-mirror — the deterministic round sees EVERY scope (agent cards
  // get backlink rewrites / staged expiry / duplicate marking under the
  // same rules); the plan's index.md stays global-only by construction.
  const plan = buildKnowledgeGraphPlan(params.store.listAllCardFilesAllScopes(), { now: params.now })
  for (const { relPath, body } of plan.cardBodies) params.effectors.applyCardBody(relPath, body)
  for (const relPath of plan.expiredStaged) params.effectors.deleteCard(relPath)
  for (const { relPath, duplicateOf } of plan.possibleDuplicates) params.effectors.markDuplicate(relPath, duplicateOf)
  params.effectors.writeIndexFile(plan.indexMarkdown)

  const report: CrystallizeRoundReport = {
    backlinksRewritten: plan.cardBodies.length,
    expiredStagedDeleted: plan.expiredStaged.length,
    duplicatesMarked: plan.possibleDuplicates.length,
    invalidCards: plan.invalidCards.length,
    orphanLinks: plan.orphanLinks.length,
  }
  logAgentMetric('maintenance_audit', { decision: 'run', reason: gate.reason, signals: gate.signals, report })
  return { decision: 'run', reason: gate.reason, report }
}

/**
 * Scheduling skeleton — mirrors MemoryLifecycleManager's interval pattern
 * (6h rhythm). The round callback is injected; failures never escalate
 * (handler errors must not break the host).
 */
export class CrystallizeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly runRound: () => Promise<unknown>) {}

  start(intervalMinutes = MIN_INTERVAL_MINUTES): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runRound().catch((error) => {
        console.error('[CrystallizeScheduler] round failed:', error)
      })
    }, intervalMinutes * 60_000)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
