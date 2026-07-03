/**
 * EP3-C3 — the FIRST LLM maintenance round (03 §1/§2/§5, v2 of the
 * crystallize pipeline). Container is PINNED to the sub-agent runner
 * (`runSubAgent`) — not skill child, not browser sub-agent, no fourth
 * runner. Four container decisions (contract v3):
 *  - cancellation: the runner's abortSignal channel;
 *  - budget: a single bounded LLM call per round (v1); token/usage audit
 *    goes to maintenance metrics and the single-line log — NEVER a direct
 *    run_meta write (runSubAgent is an event container, owns no ledger);
 *  - logging: one `maintenance_audit` row per round + agent metrics;
 *  - errors: runner terminal events become breadcrumbs, never escalate.
 *
 * The deterministic plan (EP2-C1/C2) runs FIRST; the LLM round is gated by
 * the same EP2-C2 deterministic gate — skip means ZERO LLM calls. All card
 * writes go through BeliefCardStore.writeCard format validation; bad ops
 * are rejected and counted, never half-written. Every new card is FORCED
 * to staged (03 §2 写穿隔离区).
 */

import { randomUUID } from 'node:crypto'

import { logAgentMetric } from '../metrics'
import { isPossibleDuplicateOfSource } from '../knowledge/reserved-card-source'
import { decideCrystallizeRun, type CrystallizeSignals } from './crystallize-gate'
// eslint-disable-next-line ready/no-subagent-leak -- EP3-C3 pins the maintenance LLM container to runSubAgent by contract.
import { runSubAgent } from '../sub-agent/sub-agent-runner'
// eslint-disable-next-line ready/no-subagent-leak -- Type-only context for the same EP3-C3 subagent container contract.
import type { SubAgent, SubAgentContext } from '../sub-agent/sub-agent-types'
import { BeliefCardStore, isAllowedCardPath, BELIEF_CONFIDENCE, BELIEF_TAGS } from '../knowledge/belief-card-store'
import { runBeliefDecayRound, type BeliefDecaySignals, type BeliefDecayEffectors, type BeliefDecayRoundReport } from '../memory/belief-decay'
import { PromptAssetLoader } from '../prompt-assets/loader'
import { promptAssetRoots } from '../prompt-assets/roots'

const SIGNAL_SUMMARY_MAX = 200
const MAX_OPS_PER_ROUND = 12

export interface MaintenanceSignals {
  /** learningRefs / CheckIn digests — SUMMARIES, never full text (省钱门控). */
  learningSummaries: string[]
  checkinSummaries: string[]
  stagedCards: Array<{ relPath: string; title: string; description: string }>
}

export function renderMaintenanceSignals(signals: MaintenanceSignals): string {
  const clip = (text: string) => String(text || '').slice(0, SIGNAL_SUMMARY_MAX)
  const lines: string[] = []
  for (const item of signals.learningSummaries) lines.push(`- [learning] ${clip(item)}`)
  for (const item of signals.checkinSummaries) lines.push(`- [checkin] ${clip(item)}`)
  for (const card of signals.stagedCards) lines.push(`- [staged] ${card.relPath}: ${clip(card.title)} — ${clip(card.description)}`)
  return lines.length > 0 ? lines.join('\n') : '（本轮无新信号）'
}

export interface MaintenanceCardOp {
  relPath: string
  title: string
  description: string
  confidence: string
  tag: string
  body: string
}

/** Parse + structurally validate the LLM output. Invalid entries are
 *  rejected (counted), never partially applied. */
export function parseMaintenanceOps(raw: string): { ops: MaintenanceCardOp[]; rejected: number } {
  let parsed: unknown
  try {
    const trimmed = String(raw || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    parsed = JSON.parse(trimmed)
  } catch {
    return { ops: [], rejected: 1 }
  }
  if (!Array.isArray(parsed)) return { ops: [], rejected: 1 }
  const ops: MaintenanceCardOp[] = []
  let rejected = 0
  for (const entry of parsed.slice(0, MAX_OPS_PER_ROUND)) {
    const record = entry as Record<string, unknown>
    const candidate: MaintenanceCardOp = {
      relPath: String(record?.relPath || ''),
      title: String(record?.title || ''),
      description: String(record?.description || ''),
      confidence: String(record?.confidence || ''),
      tag: String(record?.tag || ''),
      body: String(record?.body || ''),
    }
    const valid = isAllowedCardPath(candidate.relPath)
      && candidate.title.trim().length > 0
      && candidate.description.trim().length > 0
      && (BELIEF_CONFIDENCE as readonly string[]).includes(candidate.confidence)
      && (BELIEF_TAGS as readonly string[]).includes(candidate.tag)
      && candidate.body.trim().length > 0
    if (valid) ops.push(candidate)
    else rejected += 1
  }
  rejected += Math.max(0, parsed.length - MAX_OPS_PER_ROUND)
  return { ops, rejected }
}

export interface MaintenanceRoundDeps {
  signals: CrystallizeSignals
  now: Date
  store: BeliefCardStore
  collect: () => MaintenanceSignals
  /** Injectable LLM (tests use fakes; production wires through the
   *  sub-agent loop). One bounded call per round. */
  llm: (prompt: string, abortSignal: AbortSignal) => Promise<string>
  /** Real decay signals (mirror access counts + graph backlinks). */
  collectDecaySignals?: () => BeliefDecaySignals[]
  decayEffectors?: BeliefDecayEffectors
  abortSignal?: AbortSignal
  loadPrompt?: () => string
}

export interface MaintenanceRoundReport {
  decision: 'run' | 'skip'
  reason: string
  llmCalls: number
  applied: number
  rejected: number
  decay?: BeliefDecayRoundReport
  terminal: string
}

export interface MaintenanceRoundStatusSnapshot extends MaintenanceRoundReport {
  lastRunAt: string
}

let lastMaintenanceRoundStatus: MaintenanceRoundStatusSnapshot | null = null

export function getLastMaintenanceRoundStatus(): MaintenanceRoundStatusSnapshot | null {
  return lastMaintenanceRoundStatus ? { ...lastMaintenanceRoundStatus } : null
}

function defaultPrompt(): string {
  try {
    const loader = new PromptAssetLoader({
      roots: promptAssetRoots(),
      fallbacks: { 'maintenance/round': '输出 JSON 数组的 memory_write_card 操作；无内容输出 []。\n\n{{signals}}' },
    })
    return loader.load('maintenance/round').body
  } catch {
    return '输出 JSON 数组的 memory_write_card 操作；无内容输出 []。\n\n{{signals}}'
  }
}

/**
 * P5d/C26 unwired: runMaintenanceLlmRound is not in production driver path.
 * Drive one maintenance round through the PINNED runSubAgent container.
 */
export async function runMaintenanceLlmRound(deps: MaintenanceRoundDeps): Promise<MaintenanceRoundReport> {
  const gate = decideCrystallizeRun(deps.signals, deps.now)
  if (gate.decision === 'skip') {
    const report: MaintenanceRoundReport = {
      decision: 'skip', reason: gate.reason, llmCalls: 0, applied: 0, rejected: 0, terminal: 'gated_skip',
    }
    lastMaintenanceRoundStatus = { ...report, lastRunAt: deps.now.toISOString() }
    logAgentMetric('maintenance_audit', { round: 'llm', ...report })
    return report
  }

  let llmCalls = 0
  let applied = 0
  let rejected = 0
  let decay: BeliefDecayRoundReport | undefined

  const subagent: SubAgent = {
    lifecycleId: `maintenance-${randomUUID()}`,
    durableRunId: null,
    subagentName: 'ready-crystallize-llm',
    artifactDir: null,
    async *run(context: SubAgentContext) {
      // ① LLM digestion (single bounded call; summaries only)
      const signalsText = renderMaintenanceSignals(deps.collect())
      const prompt = (deps.loadPrompt?.() ?? defaultPrompt()).replace('{{signals}}', signalsText)
      llmCalls += 1
      const rawOutput = await deps.llm(prompt, context.abortSignal)
      const parsedOps = parseMaintenanceOps(rawOutput)
      rejected += parsedOps.rejected
      for (const op of parsedOps.ops) {
        // every write goes through the store's format validation; new cards
        // are FORCED staged — the LLM cannot mint active beliefs.
        const written = deps.store.writeCard({
          relPath: op.relPath,
          frontmatter: {
            title: op.title,
            description: op.description,
            confidence: op.confidence as never,
            tag: op.tag as never,
            created: deps.now.toISOString().slice(0, 10),
            status: 'staged',
          },
          body: op.body,
        })
        if (written.ok) applied += 1
        else rejected += 1
      }
      // ② deterministic decay with REAL signals (EP2-C6 接线)
      if (deps.collectDecaySignals && deps.decayEffectors) {
        decay = runBeliefDecayRound(deps.collectDecaySignals(), deps.decayEffectors, deps.now)
      }
      yield { type: 'progress', message: `ops applied=${applied} rejected=${rejected}` } as unknown as import('../sub-agent/sub-agent-types').SubAgentWorkEvent
      return { state: 'completed' as const } as import('../sub-agent/sub-agent-types').SubAgentRunResult
    },
  }

  const abortController = new AbortController()
  if (deps.abortSignal) {
    if (deps.abortSignal.aborted) abortController.abort()
    else deps.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
  }
  let terminal = 'done'
  try {
    const iterator = runSubAgent(subagent, {
      abortSignal: abortController.signal,
      cleanup: { register: () => () => undefined } as never,
      metadata: { kind: 'maintenance_round' },
    })
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        terminal = String((next.value as { state?: string } | undefined)?.state || 'done')
        break
      }
    }
  } catch (error) {
    // runner failures become breadcrumbs, never escalate (容器决策④)
    terminal = `runner_error:${error instanceof Error ? error.message : String(error)}`
  }

  const report: MaintenanceRoundReport = {
    decision: 'run', reason: gate.reason, llmCalls, applied, rejected, decay, terminal,
  }
  lastMaintenanceRoundStatus = { ...report, lastRunAt: deps.now.toISOString() }
  // single-line round report (03 §5) — usage audit lives HERE, not run_meta.
  logAgentMetric('maintenance_audit', { round: 'llm', ...report })
  return report
}

// collectBeliefDecaySignals MOVED to memory/belief-decay.ts (P5d deterministic
// migration, 2026-07-03) so the LIVE decay wiring never imports this dormant
// LLM-round file. Re-exported here for existing importers.
export { collectBeliefDecaySignals } from '../memory/belief-decay'
