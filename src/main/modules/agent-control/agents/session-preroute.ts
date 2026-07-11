/**
 * EP4-A5 — session-creation preroute (04 档位二). A PURE table+classifier
 * router — never a model call. Three-tier decision:
 *
 *   1. STATE FIRST — the first message classifies (I1 shared classifier) as
 *      continue_task / status_query AND a recent open task carries an
 *      ownerAgentId whose agent is still active → stay with that agent.
 *      Continue 类永远回原 agent: precedent matching can NEVER override
 *      this tier (C4.1 协同硬断言).
 *   2. PRECEDENT — ACTIVE routing-*.md cards with a valid `triggers`
 *      keyword list (A5 closed convention: literal keywords, case-folded
 *      containment). Target agent is BOUND to the filename and must be
 *      active in the registry. Highest keyword-hit count wins; a TIE across
 *      different targets is a conflict → fall back to the main agent with
 *      the conflicting cards listed for the suggestion banner.
 *   3. FALLBACK — main agent (A4 档位一 proposal handles the rest).
 *
 * Mode mapping (`agent_auto_routing`, default suggest):
 *   off     → effect 'none' (零行为变化 — caller skips evaluation entirely;
 *             this function still honors it defensively)
 *   suggest → tier 1/2 hits become banner DATA; the user clicks to switch
 *   auto    → tier 1/2 hits route directly; banner shows "点此改回"
 */

import {
  classifyFollowupIntent,
  type FollowupTaskRef,
} from '../../../../shared/agent-followup-intent'
import { isOpenTaskStatus } from '../contracts/task-open-status'
import { MAIN_AGENT_ID } from '../../repositories/agent-registry-repository'

export type SessionPrerouteMode = 'off' | 'suggest' | 'auto'

export interface PrerouteOwnedTaskRef extends FollowupTaskRef {
  ownerAgentId: string | null
}

export interface PrerouteRoutingCard {
  relPath: string
  targetAgentId: string
  triggers: string[] | null
}

export type PrerouteDecision =
  | { tier: 'state'; targetAgentId: string; taskId: string | null }
  | { tier: 'precedent'; targetAgentId: string; cardRelPath: string; matchedKeywords: string[] }
  | {
      tier: 'fallback'
      targetAgentId: typeof MAIN_AGENT_ID
      reason: 'routing_off' | 'no_match' | 'precedent_conflict'
      conflicts?: Array<{ cardRelPath: string; targetAgentId: string }>
    }

export type PrerouteEffect = 'none' | 'suggest' | 'route'

export interface PrerouteResult {
  decision: PrerouteDecision
  effect: PrerouteEffect
}

function isOpenTask(ref: PrerouteOwnedTaskRef): boolean {
  return isOpenTaskStatus(ref.status) || ref.interactionState === 'check_in_pending'
}

export function decideSessionPreroute(input: {
  firstMessage: string
  /** Recent tasks with owners (most-recent first), projection-derived. */
  recentOwnedTasks: ReadonlyArray<PrerouteOwnedTaskRef>
  routingCards: ReadonlyArray<PrerouteRoutingCard>
  isAgentActive: (agentId: string) => boolean
  isAgentAutoRoutable?: (agentId: string) => boolean
  mode: SessionPrerouteMode
}): PrerouteResult {
  if (input.mode === 'off') {
    return { decision: { tier: 'fallback', targetAgentId: MAIN_AGENT_ID, reason: 'routing_off' }, effect: 'none' }
  }
  const effectFor = (hit: boolean): PrerouteEffect =>
    hit ? (input.mode === 'auto' ? 'route' : 'suggest') : 'none'

  // ---- tier 1: state first
  const intent = classifyFollowupIntent(input.firstMessage, {
    hasActiveTaskContext: input.recentOwnedTasks.length > 0,
    taskRefs: input.recentOwnedTasks,
  })
  if (intent.kind === 'continue_task' || intent.kind === 'status_query') {
    // bind to the classifier's pinned task when present, else the most
    // recent open task — OWNED OR NOT (an un-owned continuation belongs to
    // the main agent and must never be hijacked by precedent, C4.1 协同).
    const pinned = intent.targetTaskId
      ? input.recentOwnedTasks.find((ref) => ref.taskId === intent.targetTaskId)
      : undefined
    const target = pinned ?? input.recentOwnedTasks.find(isOpenTask)
    if (target?.ownerAgentId && input.isAgentActive(String(target.ownerAgentId))) {
      return {
        decision: { tier: 'state', targetAgentId: String(target.ownerAgentId), taskId: target.taskId ?? null },
        effect: effectFor(true),
      }
    }
    return { decision: { tier: 'fallback', targetAgentId: MAIN_AGENT_ID, reason: 'no_match' }, effect: 'none' }
  }

  // ---- tier 2: precedent via the closed triggers convention
  const message = input.firstMessage.toLowerCase()
  type Hit = { card: PrerouteRoutingCard; matched: string[] }
  const hits: Hit[] = []
  for (const routingCard of input.routingCards) {
    if (!routingCard.triggers || routingCard.triggers.length === 0) continue
    if (!(input.isAgentAutoRoutable ?? input.isAgentActive)(routingCard.targetAgentId)) continue
    const matched = routingCard.triggers.filter((keyword) => message.includes(keyword.toLowerCase()))
    if (matched.length > 0) hits.push({ card: routingCard, matched })
  }
  if (hits.length > 0) {
    const best = Math.max(...hits.map((hit) => hit.matched.length))
    const winners = hits.filter((hit) => hit.matched.length === best)
    const distinctTargets = new Set(winners.map((hit) => hit.card.targetAgentId))
    if (distinctTargets.size > 1) {
      return {
        decision: {
          tier: 'fallback',
          targetAgentId: MAIN_AGENT_ID,
          reason: 'precedent_conflict',
          conflicts: winners.map((hit) => ({ cardRelPath: hit.card.relPath, targetAgentId: hit.card.targetAgentId })),
        },
        effect: 'none',
      }
    }
    const winner = winners[0]
    return {
      decision: {
        tier: 'precedent',
        targetAgentId: winner.card.targetAgentId,
        cardRelPath: winner.card.relPath,
        matchedKeywords: winner.matched,
      },
      effect: effectFor(true),
    }
  }

  // ---- tier 3: fallback
  return { decision: { tier: 'fallback', targetAgentId: MAIN_AGENT_ID, reason: 'no_match' }, effect: 'none' }
}
