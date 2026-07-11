// B8-D R1 — SessionPrerouteService: session-creation preroute evaluation,
// the read-only Studio simulation, and the recent-trace ring buffer,
// extracted from AgentControlRuntime (runtime.ts) as a delegated
// sub-service. Method bodies are mechanical moves; the only substitutions
// are the shared `settingsRepository` / `agentRegistry` /
// `taskProjectionStore` / `getBeliefCardStore` references becoming injected
// dependencies. The trace ring buffer is cluster-exclusive state and
// migrated here.
import { readAgentSessionPrerouteMode } from '../../settings-engine/agent-session-preroute-setting'
import { decideSessionPreroute, type PrerouteResult } from '../agents/session-preroute'
import {
  buildSessionPrerouteTrace,
  pushSessionPrerouteTraceSafely,
  SessionPrerouteTraceRingBuffer,
} from '../agents/session-preroute-trace'
import type {
  AgentSystemStudioPrerouteTrace,
  AgentSystemStudioRoutingSimulation,
} from '../../../../shared/agent-system-studio'
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type { AgentRegistryRepository } from '../../repositories/agent-registry-repository'
import type { TaskProjectionRepository } from '../../repositories/task-projection-repository'
import type { BeliefCardStore } from '../knowledge/belief-card-store'
import { buildStudioPrerouteActions } from './runtime-helpers'

export interface SessionPrerouteServiceDeps {
  settingsRepository: AppSettingsRepository
  agentRegistry: AgentRegistryRepository
  taskProjectionStore: TaskProjectionRepository
  getBeliefCardStore: () => BeliefCardStore
  getAgentReadiness: (agentId: string) => { autoRoutable: boolean }
}

export class SessionPrerouteService {
  private readonly sessionPrerouteTraces = new SessionPrerouteTraceRingBuffer()

  constructor(private readonly deps: SessionPrerouteServiceDeps) {}

  /** EP4-A5 — session-creation preroute (pure table+classifier router fed
   *  with projection facts, active routing cards, and registry status). */
  evaluateSessionPreroute(firstMessage: string): PrerouteResult {
    const mode = readAgentSessionPrerouteMode(this.deps.settingsRepository)
    if (mode === 'off') {
      return decideSessionPreroute({
        firstMessage,
        recentOwnedTasks: [],
        routingCards: [],
        isAgentActive: () => false,
        mode,
      })
    }
    const agents = this.deps.agentRegistry.list()
    const recentOwnedTasks = this.deps.taskProjectionStore.listRecentTasksForPreroute(10).map((record) => ({
      taskId: record.taskId,
      status: String(record.status),
      interactionState: record.interactionState ?? null,
      summary: record.taskSummary ?? null,
      blockerCategory: record.blockedReason ?? null,
      ownerAgentId: record.ownerAgentId ?? null,
    }))
    const store = this.deps.getBeliefCardStore()
    const routingCards = (store?.listRoutingCards() ?? []).map((card) => ({
      relPath: card.relPath,
      targetAgentId: card.targetAgentId,
      triggers: card.triggers,
    }))
    const isAgentAutoRoutable = (agentId: string): boolean => this.deps.getAgentReadiness(agentId).autoRoutable
    const result = decideSessionPreroute({
      firstMessage,
      recentOwnedTasks,
      routingCards,
      isAgentActive: (agentId) => this.deps.agentRegistry.get(agentId)?.status === 'active',
      isAgentAutoRoutable,
      mode,
    })
    pushSessionPrerouteTraceSafely({
      sink: this.sessionPrerouteTraces,
      id: `preroute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      now: new Date(),
      firstMessage,
      mode,
      result,
      recentOwnedTasks,
      getRoutingInventory: () => store?.listRoutingCardInventory(agents) ?? [],
      isAgentActive: (agentId) => this.deps.agentRegistry.get(agentId)?.status === 'active',
    })
    return result
  }

  /** P8g-8a — read-only Studio simulation. It reuses the preroute rules but
   * deliberately does not push a trace, so typed samples never pollute the
   * real recent-routing history. */
  simulateSessionPrerouteForStudio(firstMessage: string): AgentSystemStudioRoutingSimulation {
    const sample = String(firstMessage || '').trim()
    const mode = readAgentSessionPrerouteMode(this.deps.settingsRepository)
    if (mode === 'off') {
      const result = decideSessionPreroute({
        firstMessage: sample,
        recentOwnedTasks: [],
        routingCards: [],
        isAgentActive: () => false,
        mode,
      })
      const targetStatus = 'missing'
      return {
        sample,
        mode,
        effect: result.effect,
        decisionTier: result.decision.tier,
        targetAgentId: result.decision.targetAgentId,
        targetAgentName: null,
        targetStatus,
        matchedKeywords: [],
        cardRelPath: null,
        fallbackReason: result.decision.tier === 'fallback' ? result.decision.reason : null,
        conflicts: result.decision.tier === 'fallback' ? (result.decision.conflicts ?? []) : [],
        reasons: ['routing_off'],
        actions: buildStudioPrerouteActions({ result, targetName: null, targetStatus }),
      }
    }
    const agents = this.deps.agentRegistry.list()
    const recentOwnedTasks = this.deps.taskProjectionStore.listRecentTasksForPreroute(10).map((record) => ({
      taskId: record.taskId,
      status: String(record.status),
      interactionState: record.interactionState ?? null,
      summary: record.taskSummary ?? null,
      blockerCategory: record.blockedReason ?? null,
      ownerAgentId: record.ownerAgentId ?? null,
    }))
    const store = this.deps.getBeliefCardStore()
    const routingCards = (store?.listRoutingCards() ?? []).map((card) => ({
      relPath: card.relPath,
      targetAgentId: card.targetAgentId,
      triggers: card.triggers,
    }))
    const isAgentAutoRoutable = (agentId: string): boolean => this.deps.getAgentReadiness(agentId).autoRoutable
    const result = decideSessionPreroute({
      firstMessage: sample,
      recentOwnedTasks,
      routingCards,
      isAgentActive: (agentId) => this.deps.agentRegistry.get(agentId)?.status === 'active',
      isAgentAutoRoutable,
      mode,
    })
    const trace = buildSessionPrerouteTrace({
      id: 'studio-routing-simulation',
      now: new Date(),
      firstMessage: sample,
      mode,
      result,
      recentOwnedTasks,
      routingInventory: store?.listRoutingCardInventory(agents) ?? [],
      isAgentActive: (agentId) => this.deps.agentRegistry.get(agentId)?.status === 'active',
    })
    const target = this.deps.agentRegistry.get(result.decision.targetAgentId)
    const targetStatus = target?.status ?? 'missing'
    const matchedKeywords = result.decision.tier === 'precedent' ? result.decision.matchedKeywords : []
    const cardRelPath = result.decision.tier === 'precedent' ? result.decision.cardRelPath : null
    const fallbackReason = result.decision.tier === 'fallback' ? result.decision.reason : null
    const conflicts = result.decision.tier === 'fallback' ? (result.decision.conflicts ?? []) : []
    return {
      sample,
      mode,
      effect: result.effect,
      decisionTier: result.decision.tier,
      targetAgentId: result.decision.targetAgentId,
      targetAgentName: target?.name ?? null,
      targetStatus,
      matchedKeywords,
      cardRelPath,
      fallbackReason,
      conflicts,
      reasons: trace.reasons,
      actions: buildStudioPrerouteActions({ result, targetName: target?.name ?? null, targetStatus }),
    }
  }

  listRecentSessionPrerouteTraces(limit = 10): AgentSystemStudioPrerouteTrace[] {
    return this.sessionPrerouteTraces.listRecent(limit)
  }
}
