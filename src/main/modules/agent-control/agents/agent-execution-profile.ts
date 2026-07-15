import { createHash } from 'node:crypto'
import type {
  AgentExecutionProfile,
  TaskExecutionBinding,
} from '../../../../shared/agent-execution-profile'
import { AGENT_KNOWLEDGE_INDEX_MAX_CHARS } from '../../../../shared/agent-execution-profile'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import { isAgentFoundationReady } from './agent-foundation-readiness'

interface ProfileRegistryReader {
  get(id: string): AgentRegistryRecord | null
}

interface ProfilePersonalityReader {
  getPersonality(agentName: string): Promise<{ personalityText: string; tone?: string } | null>
}

interface ProfileKnowledgeStore {
  listCards(opts?: { dir?: string; includeStaged?: boolean }): Array<{
    relPath: string
    body: string
    frontmatter: { status: string; title: string; description: string; confidence: string }
  }>
  listRoutingCards(): Array<{ targetAgentId: string; relPath: string }>
  renderKnowledgeIndex(opts: { maxChars: number; ownerAgentId?: string | null; excludeRelPaths?: readonly string[] }): {
    text: string
    renderedCount: number
    omittedCount: number
    renderedRelPaths: string[]
  }
}

export interface AgentExecutionProfileResolverDeps {
  registry: ProfileRegistryReader
  personality: ProfilePersonalityReader
  getKnowledgeStore: () => ProfileKnowledgeStore
  readAsset: (relPath: string) => string
  isKnowledgeEnabled: () => boolean
  listBlueprints?: () => SpecialistAgentBlueprint[]
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isSafeAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

function resolveReadiness(input: {
  record: AgentRegistryRecord
  rules: string
  foundation: string
  hasRouting: boolean
  blueprints: SpecialistAgentBlueprint[]
}): AgentExecutionProfile['readiness'] {
  const isMain = input.record.id === MAIN_AGENT_ID
  const conversationReady = input.record.status === 'active'
  const handoffReady = conversationReady && !isMain && Boolean(input.record.charter?.trim()) && Boolean(input.rules)
  const foundationReady = !isMain && isAgentFoundationReady({
    agentId: input.record.id,
    foundation: input.foundation,
    blueprints: input.blueprints,
  })
  const reasons: string[] = []
  if (!input.rules && !isMain) reasons.push('rules_missing')
  if (!input.foundation && !isMain) reasons.push('foundation_missing')
  else if (!foundationReady && !isMain) reasons.push('foundation_invalid')
  if (!input.hasRouting && !isMain) reasons.push('active_routing_missing')
  return {
    conversationReady,
    handoffReady,
    autoRoutable: handoffReady && input.hasRouting,
    collaborationReady: handoffReady && foundationReady,
    reasons,
  }
}

export function resolveConversationAgentId(
  requestedAgentId: string,
  registry: ProfileRegistryReader,
): { effectiveAgentId: string; redirectChain: AgentExecutionProfile['redirectChain']; resolutionKind: TaskExecutionBinding['resolutionKind'] } {
  const requested = isSafeAgentId(String(requestedAgentId || '').trim())
    ? String(requestedAgentId).trim()
    : MAIN_AGENT_ID
  const redirectChain: AgentExecutionProfile['redirectChain'] = []
  const seen = new Set<string>()
  let current = requested
  let record = registry.get(current)
  while (record?.status === 'merged') {
    if (seen.has(current) || !record.mergedIntoAgentId || !isSafeAgentId(record.mergedIntoAgentId)) {
      return { effectiveAgentId: MAIN_AGENT_ID, redirectChain, resolutionKind: 'main_fallback' }
    }
    seen.add(current)
    redirectChain.push({ from: current, to: record.mergedIntoAgentId, reason: 'merged' })
    current = record.mergedIntoAgentId
    record = registry.get(current)
  }
  if (record?.status === 'active') {
    return { effectiveAgentId: record.id, redirectChain, resolutionKind: redirectChain.length ? 'merged_redirect' : 'direct' }
  }
  return { effectiveAgentId: MAIN_AGENT_ID, redirectChain, resolutionKind: 'main_fallback' }
}

export class AgentExecutionProfileResolver {
  constructor(private readonly deps: AgentExecutionProfileResolverDeps) {}

  resolveReadiness(requestedAgentId: string): AgentExecutionProfile['readiness'] {
    const requested = isSafeAgentId(String(requestedAgentId || '').trim())
      ? String(requestedAgentId).trim()
      : ''
    const record = requested ? this.deps.registry.get(requested) : null
    if (!record) return { conversationReady: false, handoffReady: false, autoRoutable: false, collaborationReady: false, reasons: ['agent_unavailable'] }
    if (record.status !== 'active') {
      return {
        conversationReady: false,
        handoffReady: false,
        autoRoutable: false,
        collaborationReady: false,
        reasons: [record.status === 'merged' ? 'agent_merged' : 'agent_inactive'],
      }
    }
    const rules = this.deps.readAsset(`agents/${record.id}/RULES.md`).trim()
    const foundation = this.deps.readAsset(`agents/${record.id}/FOUNDATION.md`).trim()
    const hasRouting = this.deps.getKnowledgeStore().listRoutingCards().some((card) => card.targetAgentId === record.id)
    const readiness = resolveReadiness({
      record, rules, foundation, hasRouting,
      blueprints: this.deps.listBlueprints?.() ?? [],
    })
    return readiness
  }

  async resolve(requestedAgentId: string): Promise<AgentExecutionProfile> {
    const requested = isSafeAgentId(String(requestedAgentId || '').trim())
      ? String(requestedAgentId).trim()
      : MAIN_AGENT_ID
    const resolved = resolveConversationAgentId(requested, this.deps.registry)
    const redirectChain = resolved.redirectChain
    const resolutionKind = resolved.resolutionKind
    let current = resolved.effectiveAgentId
    let record = this.deps.registry.get(current)
    if (!record || record.status !== 'active') {
      throw new Error('[agent-execution-profile] main agent is unavailable')
    }

    const personaRef = record.personaRef || record.id
    const personalityRecord = await this.deps.personality.getPersonality(personaRef)
    const fallbackPersonality = this.deps.readAsset('SOUL.md').trim()
    const personality = personalityRecord?.personalityText?.trim() || fallbackPersonality
    const tone = personalityRecord?.tone?.trim() || undefined
    const reasons: string[] = []
    if (!personalityRecord) reasons.push('personality_fallback')

    const rules = this.deps.readAsset(`agents/${record.id}/RULES.md`).trim()
    const foundation = this.deps.readAsset(`agents/${record.id}/FOUNDATION.md`).trim()
    const knowledgeEnabled = this.deps.isKnowledgeEnabled()
    const store = this.deps.getKnowledgeStore()
    const scopedCards = knowledgeEnabled
      ? store.listCards({ dir: `agents/${record.id}/knowledge` })
        .filter((card) => card.frontmatter.status === 'active')
        .sort((left, right) => left.relPath.localeCompare(right.relPath))
      : []
    const globalCards = knowledgeEnabled
      ? store.listCards()
        .filter((card) => card.frontmatter.status === 'active' && !/(^|\/)routing-[a-z0-9._-]+\.md$/.test(card.relPath))
        .sort((left, right) => left.relPath.localeCompare(right.relPath))
      : []
    const inventory = [...scopedCards, ...globalCards]
    const routingCards = store.listRoutingCards()
    const rendered = knowledgeEnabled
      ? store.renderKnowledgeIndex({
        maxChars: AGENT_KNOWLEDGE_INDEX_MAX_CHARS,
        ownerAgentId: record.id,
        excludeRelPaths: routingCards.map((card) => card.relPath),
      })
      : { text: '', renderedCount: 0, renderedRelPaths: [], omittedCount: 0 }
    const allowedKnowledgeRefs = rendered.renderedRelPaths
    const allowedSet = new Set(allowedKnowledgeRefs)
    const cards = inventory.filter((card) => allowedSet.has(card.relPath))
    const knowledgeIndex = rendered.omittedCount > 0
      ? `${rendered.text}\n（另有 ${rendered.omittedCount} 条低置信度条目）`
      : rendered.text
    const hasRouting = routingCards.some((card) => card.targetAgentId === record!.id)
    const readiness = resolveReadiness({
      record, rules, foundation, hasRouting,
      blueprints: this.deps.listBlueprints?.() ?? [],
    })
    reasons.push(...readiness.reasons)

    const executionMaterialHash = digest({
      effectiveAgentId: record.id,
      personaRef,
      personality,
      ...(tone ? { tone } : {}),
      rules,
      knowledge: cards.map((card) => ({ relPath: card.relPath, frontmatter: card.frontmatter, body: card.body })),
    })
    const readinessRevision = digest({
      status: record.status,
      charter: record.charter,
      rules,
      foundation,
      routingRefs: routingCards.filter((card) => card.targetAgentId === record!.id).map((card) => card.relPath).sort(),
      reasons,
    })

    return {
      requestedAgentId: requested,
      effectiveAgentId: record.id,
      personaRef,
      name: record.name,
      charter: record.charter || '',
      personality,
      tone,
      rules,
      knowledgeIndex,
      allowedKnowledgeRefs,
      knowledgeWriteOwnerAgentId: record.id,
      knowledgeWriteNamespace: `agents/${record.id}/knowledge`,
      executionMaterialHash,
      readinessRevision,
      redirectChain,
      readiness: { ...readiness, reasons: resolutionKind === 'main_fallback' ? [...reasons, 'main_fallback'] : reasons },
    }
  }

  createBinding(input: {
    profile: AgentExecutionProfile
    runId: string
    ownerAgentIdAtStart: string
    runOrigin: TaskExecutionBinding['runOrigin']
    ownerAssignmentSource: TaskExecutionBinding['ownerAssignmentSource']
    executionSelectionSource?: TaskExecutionBinding['executionSelectionSource']
  }): TaskExecutionBinding {
    return {
      schemaVersion: 1,
      runId: input.runId,
      ownerAgentIdAtStart: input.ownerAgentIdAtStart,
      runOrigin: input.runOrigin,
      kind: 'registered_agent',
      requestedAgentId: input.profile.requestedAgentId,
      effectiveAgentId: input.profile.effectiveAgentId,
      executionMaterialHash: input.profile.executionMaterialHash,
      ownerAssignmentSource: input.ownerAssignmentSource,
      executionSelectionSource: input.executionSelectionSource || 'task_owner',
      resolutionKind: input.profile.redirectChain.length > 0
        ? 'merged_redirect'
        : input.profile.requestedAgentId === input.profile.effectiveAgentId
          ? 'direct'
          : 'main_fallback',
    }
  }
}
