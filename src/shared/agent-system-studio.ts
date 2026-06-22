import type { SpecialistAgentBlueprint } from './agent-specialist-blueprint'
import type { TaskProjectionRecord } from './ipc-contracts/task-projection'

export type AgentSystemStudioAgentStatus = 'active' | 'disabled' | 'retired' | 'merged'
export type AgentSystemStudioAgentKind = 'main' | 'specialist'

export type AgentSystemStudioRoutingDisabledReason =
  | 'card_staged'
  | 'missing_triggers'
  | 'target_inactive'
  | 'invalid_card'

export type AgentSystemStudioPrerouteTraceReason =
  | 'routing_off'
  | 'suggest_only'
  | 'card_staged'
  | 'missing_triggers'
  | 'target_inactive'
  | 'no_keyword_match'
  | 'precedent_conflict'
  | 'state_owner_inactive'

export interface AgentSystemStudioKnowledgeCard {
  relPath: string
  title: string
  description: string
  status: string
  tag: string | null
  scopeId: string
  body: string
  contentHash: string
}

export interface AgentSystemStudioRulesFile {
  relPath: string
  exists: boolean
  preview: string | null
  content: string | null
  contentHash: string | null
}

export interface AgentSystemStudioFoundationFile {
  relPath: string
  exists: boolean
  preview: string | null
  content: string | null
  contentHash: string | null
}

export interface AgentSystemStudioRoutingCard {
  relPath: string
  title: string
  description: string
  status: string
  targetAgentId: string
  targetStatus: AgentSystemStudioAgentStatus | 'missing'
  triggers: string[] | null
  disabledReason: AgentSystemStudioRoutingDisabledReason | null
}

export interface AgentSystemStudioOwnedTask {
  taskId: string
  scopeId: string
  title: string | null
  summary: string | null
  status: TaskProjectionRecord['status']
  interactionState: TaskProjectionRecord['interactionState']
  ownerAgentId: string | null
  updatedAt: string
}

export type AgentSystemStudioContentEditTargetKind = 'rules' | 'foundation' | 'knowledge_card'
export type AgentSystemStudioContentEditProposalStatus = 'staged' | 'applied' | 'rejected' | 'conflict'

export interface AgentSystemStudioContentEditProvenance {
  source: 'studio' | 'task_evolution'
  sessionId: string | null
  note: string | null
  taskId?: string | null
  runId?: string | null
  scopeId?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
}

export interface AgentSystemStudioContentEditProposal {
  proposalId: string
  agentId: string
  targetKind: AgentSystemStudioContentEditTargetKind
  targetRelPath: string
  baseHash: string
  baseContent: string
  proposedContent: string
  status: AgentSystemStudioContentEditProposalStatus
  provenance: AgentSystemStudioContentEditProvenance
  createdAt: string
  updatedAt: string
  appliedAt: string | null
}

export interface AgentSystemStudioStageContentEditInput {
  agentId: string
  targetKind: AgentSystemStudioContentEditTargetKind
  targetRelPath?: string | null
  proposedContent: string
  sessionId?: string | null
  note?: string | null
}

export interface AgentSystemStudioConfirmContentEditInput {
  proposalId: string
}

export interface AgentSystemStudioRejectContentEditInput {
  proposalId: string
}

export interface AgentSystemStudioAgent {
  id: string
  name: string
  charter: string | null
  status: AgentSystemStudioAgentStatus
  kind: AgentSystemStudioAgentKind
  parentAgentId: string | null
  derivationReason: string | null
  mergedIntoAgentId: string | null
  createdAt: string
  rules: AgentSystemStudioRulesFile
  foundation: AgentSystemStudioFoundationFile
  knowledgeCards: AgentSystemStudioKnowledgeCard[]
  routingCards: AgentSystemStudioRoutingCard[]
  ownedTasks: AgentSystemStudioOwnedTask[]
  contentSummary: {
    knowledgeCards: number
    routingCards: number
    ownedTasks: number
    stagedContentEdits: number
  }
  contentEditProposals: AgentSystemStudioContentEditProposal[]
}

export interface AgentSystemStudioDerivationCandidate {
  candidateRelPath: string
  title: string
  description: string
  defaultSpecialistId: string
  defaultName: string
  defaultRoutingTriggers: string[]
}

export interface AgentSystemStudioPrerouteTrace {
  id: string
  createdAt: string
  firstMessagePreview: string
  mode: 'off' | 'suggest' | 'auto'
  effect: 'none' | 'suggest' | 'route'
  decisionTier: 'state' | 'precedent' | 'fallback'
  targetAgentId: string
  reasons: AgentSystemStudioPrerouteTraceReason[]
}

export type AgentSystemStudioRoutingSimulationActionKind = 'use_once' | 'always_route' | 'keep_main'

export interface AgentSystemStudioRoutingSimulationAction {
  kind: AgentSystemStudioRoutingSimulationActionKind
  label: string
  description: string
  enabled: boolean
}

export interface AgentSystemStudioRoutingSimulation {
  sample: string
  mode: 'off' | 'suggest' | 'auto'
  effect: 'none' | 'suggest' | 'route'
  decisionTier: 'state' | 'precedent' | 'fallback'
  targetAgentId: string
  targetAgentName: string | null
  targetStatus: AgentSystemStudioAgentStatus | 'missing'
  matchedKeywords: string[]
  cardRelPath: string | null
  fallbackReason: 'routing_off' | 'no_match' | 'precedent_conflict' | null
  conflicts: Array<{ cardRelPath: string; targetAgentId: string }>
  reasons: AgentSystemStudioPrerouteTraceReason[]
  actions: AgentSystemStudioRoutingSimulationAction[]
}

export interface AgentSystemStudioSnapshot {
  generatedAt: string
  agents: AgentSystemStudioAgent[]
  routingCards: AgentSystemStudioRoutingCard[]
  derivationCandidates: AgentSystemStudioDerivationCandidate[]
  stagedBlueprints: SpecialistAgentBlueprint[]
  recentPrerouteTraces: AgentSystemStudioPrerouteTrace[]
}
