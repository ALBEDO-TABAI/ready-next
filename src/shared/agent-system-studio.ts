export type AgentSystemStudioAgentStatus = 'active' | 'disabled' | 'retired' | 'merged'
export type AgentSystemStudioAgentKind = 'main' | 'specialist'

export type AgentSystemStudioRoutingDisabledReason =
  | 'card_staged'
  | 'missing_triggers'
  | 'target_inactive'
  | 'invalid_card'

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
  contentSummary: {
    knowledgeCards: number
    stagedContentEdits: number
  }
  contentEditProposals: AgentSystemStudioContentEditProposal[]
}

export interface AgentSystemStudioSnapshot {
  generatedAt: string
  agents: AgentSystemStudioAgent[]
}
