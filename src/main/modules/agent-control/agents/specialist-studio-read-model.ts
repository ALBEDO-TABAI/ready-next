import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import { agentScopeKnowledgeDir, type BeliefCardStore } from '../knowledge/belief-card-store'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type {
  AgentSystemStudioAgent,
  AgentSystemStudioContentEditProposal,
  AgentSystemStudioDerivationCandidate,
  AgentSystemStudioFoundationFile,
  AgentSystemStudioKnowledgeCard,
  AgentSystemStudioOwnedTask,
  AgentSystemStudioPrerouteTrace,
  AgentSystemStudioSnapshot,
} from '../../../../shared/agent-system-studio'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import { hashSpecialistStudioContent } from './specialist-content-edit-proposals'

export interface SpecialistStudioDerivationCandidateLike {
  candidateRelPath: string
  title: string
  description: string
  defaultSpecialistId: string
  defaultName: string
  defaultRoutingTriggers: string[]
}

function cleanPreview(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 240)
}

function readContentFile(store: BeliefCardStore, relPath: string): AgentSystemStudioAgent['rules'] {
  const abs = join(store.rootPath, relPath)
  if (!existsSync(abs)) return { relPath, exists: false, preview: null, content: null, contentHash: null }
  try {
    const content = readFileSync(abs, 'utf8')
    return {
      relPath,
      exists: true,
      preview: cleanPreview(content),
      content,
      contentHash: hashSpecialistStudioContent(content),
    }
  } catch {
    return { relPath, exists: true, preview: null, content: null, contentHash: null }
  }
}

function readRules(store: BeliefCardStore, agentId: string): AgentSystemStudioAgent['rules'] {
  return readContentFile(store, `agents/${agentId}/RULES.md`)
}

function readFoundation(store: BeliefCardStore, agentId: string): AgentSystemStudioFoundationFile {
  return readContentFile(store, `agents/${agentId}/FOUNDATION.md`)
}

function toKnowledgeCard(scopeId: string, relPath: string, card: NonNullable<ReturnType<BeliefCardStore['readCard']>>): AgentSystemStudioKnowledgeCard {
  return {
    relPath,
    title: card.frontmatter.title,
    description: card.frontmatter.description,
    status: card.frontmatter.status,
    tag: card.frontmatter.tag ?? null,
    scopeId,
    body: card.body,
    contentHash: hashSpecialistStudioContent(card.body),
  }
}

function listAgentKnowledge(store: BeliefCardStore, agentId: string): AgentSystemStudioKnowledgeCard[] {
  const isMain = agentId === MAIN_AGENT_ID
  const dir = isMain ? 'knowledge' : agentScopeKnowledgeDir(agentId)
  if (!dir) return []
  return store.listCards({ dir, includeStaged: true })
    .filter((card) => !/(^|\/)knowledge\/routing-[a-z0-9._-]+\.md$/.test(card.relPath))
    .map((card) => toKnowledgeCard(isMain ? 'global' : `agent:${agentId}`, card.relPath, card))
}

function toOwnedTask(record: TaskProjectionRecord): AgentSystemStudioOwnedTask {
  return {
    taskId: record.taskId,
    scopeId: record.scopeId,
    title: record.taskTitle ?? null,
    summary: record.taskSummary ?? null,
    status: record.status,
    interactionState: record.interactionState,
    ownerAgentId: record.ownerAgentId ?? null,
    updatedAt: record.updatedAt,
  }
}

function toDerivationCandidate(candidate: SpecialistStudioDerivationCandidateLike): AgentSystemStudioDerivationCandidate {
  return {
    candidateRelPath: candidate.candidateRelPath,
    title: candidate.title,
    description: candidate.description,
    defaultSpecialistId: candidate.defaultSpecialistId,
    defaultName: candidate.defaultName,
    defaultRoutingTriggers: candidate.defaultRoutingTriggers,
  }
}

export function buildAgentSystemStudioSnapshot(input: {
  agents: AgentRegistryRecord[]
  store: BeliefCardStore
  listOwnedTasks: (agentId: string) => TaskProjectionRecord[]
  listContentEditProposals?: (agentId: string) => AgentSystemStudioContentEditProposal[]
  derivationCandidates?: SpecialistStudioDerivationCandidateLike[]
  stagedBlueprints?: SpecialistAgentBlueprint[]
  recentPrerouteTraces?: AgentSystemStudioPrerouteTrace[]
  now?: Date
}): AgentSystemStudioSnapshot {
  const routingCards = input.store.listRoutingCardInventory(input.agents)
  const agents: AgentSystemStudioAgent[] = input.agents.map((agent) => {
    const knowledgeCards = listAgentKnowledge(input.store, agent.id)
    const agentRoutingCards = routingCards.filter((card) => card.targetAgentId === agent.id)
    const ownedTasks = input.listOwnedTasks(agent.id).map(toOwnedTask)
    const contentEditProposals = input.listContentEditProposals?.(agent.id) ?? []
    return {
      id: agent.id,
      name: agent.name,
      charter: agent.charter ?? null,
      status: agent.status,
      kind: agent.id === MAIN_AGENT_ID ? 'main' : 'specialist',
      parentAgentId: agent.parentAgentId ?? null,
      derivationReason: agent.derivationReason ?? null,
      mergedIntoAgentId: agent.mergedIntoAgentId ?? null,
      createdAt: agent.createdAt,
      rules: readRules(input.store, agent.id),
      foundation: readFoundation(input.store, agent.id),
      knowledgeCards,
      routingCards: agentRoutingCards,
      ownedTasks,
      contentSummary: {
        knowledgeCards: knowledgeCards.length,
        routingCards: agentRoutingCards.length,
        ownedTasks: ownedTasks.length,
        stagedContentEdits: contentEditProposals.filter((proposal) => proposal.status === 'staged').length,
      },
      contentEditProposals,
    }
  })
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    agents,
    routingCards,
    derivationCandidates: (input.derivationCandidates ?? []).map(toDerivationCandidate),
    stagedBlueprints: input.stagedBlueprints ?? [],
    recentPrerouteTraces: input.recentPrerouteTraces ?? [],
  }
}
