import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import { agentScopeKnowledgeDir, type BeliefCardStore } from '../knowledge/belief-card-store'
import type {
  AgentSystemStudioAgent,
  AgentSystemStudioContentEditProposal,
  AgentSystemStudioFoundationFile,
  AgentSystemStudioKnowledgeCard,
  AgentSystemStudioSnapshot,
} from '../../../../shared/agent-system-studio'
import { hashSpecialistStudioContent } from './specialist-content-edit-proposals'

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
    // silent-catch: unreadable file degrades to exists-without-content in the read model
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

export function buildAgentSystemStudioSnapshot(input: {
  agents: AgentRegistryRecord[]
  store: BeliefCardStore
  listContentEditProposals?: (agentId: string) => AgentSystemStudioContentEditProposal[]
  now?: Date
}): AgentSystemStudioSnapshot {
  const agents: AgentSystemStudioAgent[] = input.agents.map((agent) => {
    const knowledgeCards = listAgentKnowledge(input.store, agent.id)
    const contentEditProposals = input.listContentEditProposals?.(agent.id) ?? []
    const rules = readRules(input.store, agent.id)
    const foundation = readFoundation(input.store, agent.id)
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
      rules,
      foundation,
      knowledgeCards,
      contentSummary: {
        knowledgeCards: knowledgeCards.length,
        stagedContentEdits: contentEditProposals.filter((proposal) => proposal.status === 'staged').length,
      },
      contentEditProposals,
    }
  })
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    agents,
  }
}
