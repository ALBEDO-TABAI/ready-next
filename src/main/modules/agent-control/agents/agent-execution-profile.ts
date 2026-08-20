import { createHash } from 'node:crypto'
import type {
  AgentExecutionProfile,
  TaskExecutionBinding,
} from '../../../../shared/agent-execution-profile'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'

interface ProfileRegistryReader {
  get(id: string): AgentRegistryRecord | null
}

export interface AgentExecutionProfileResolverDeps {
  registry: ProfileRegistryReader
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function resolveConversationAgentId(
  requestedAgentId: string,
  _registry: ProfileRegistryReader,
): { effectiveAgentId: string; redirectChain: AgentExecutionProfile['redirectChain']; resolutionKind: TaskExecutionBinding['resolutionKind'] } {
  return {
    effectiveAgentId: MAIN_AGENT_ID,
    redirectChain: [],
    resolutionKind: String(requestedAgentId || '').trim() === MAIN_AGENT_ID ? 'direct' : 'main_fallback',
  }
}

export class AgentExecutionProfileResolver {
  constructor(private readonly deps: AgentExecutionProfileResolverDeps) {}

  resolveReadiness(requestedAgentId: string): AgentExecutionProfile['readiness'] {
    if (String(requestedAgentId || '').trim() !== MAIN_AGENT_ID) {
      return { conversationReady: false, handoffReady: false, autoRoutable: false, collaborationReady: false, reasons: ['agent_unavailable'] }
    }
    const record = this.deps.registry.get(MAIN_AGENT_ID)
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
    return { conversationReady: true, handoffReady: false, autoRoutable: false, collaborationReady: false, reasons: [] }
  }

  async resolve(requestedAgentId: string): Promise<AgentExecutionProfile> {
    const requested = MAIN_AGENT_ID
    const resolved = resolveConversationAgentId(requested, this.deps.registry)
    const redirectChain = resolved.redirectChain
    const resolutionKind = resolved.resolutionKind
    const record = this.deps.registry.get(resolved.effectiveAgentId)
    if (!record || record.status !== 'active') {
      throw new Error('[agent-execution-profile] main agent is unavailable')
    }
    const readiness = this.resolveReadiness(MAIN_AGENT_ID)

    const executionMaterialHash = digest({
      effectiveAgentId: record.id,
      identity: 'ready-neutral:v1',
    })
    const readinessRevision = digest({
      status: record.status,
      identity: 'ready-neutral:v1',
    })

    return {
      requestedAgentId: requested,
      effectiveAgentId: record.id,
      personaRef: 'ready-neutral',
      name: 'Ready',
      charter: '',
      personality: '',
      rules: '',
      knowledgeIndex: '',
      allowedKnowledgeRefs: [],
      knowledgeWriteOwnerAgentId: record.id,
      knowledgeWriteNamespace: `agents/${record.id}/knowledge`,
      executionMaterialHash,
      readinessRevision,
      redirectChain,
      readiness: {
        ...readiness,
        reasons: resolutionKind === 'main_fallback'
          ? [...readiness.reasons, 'main_fallback']
          : readiness.reasons,
      },
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
