export type TaskCreationOrigin =
  | 'user_root'
  | 'workflow_child'
  | 'system_background'
  | 'legacy'

export const AGENT_KNOWLEDGE_INDEX_MAX_CHARS = 1500

export type RunExecutionOrigin =
  | 'initial'
  | 'continuation'
  | 'handoff_takeover'
  | 'workflow_participant'
  | 'scheduled_task'

export type TaskExecutorKind = 'registered_agent' | 'ephemeral'

export interface TaskExecutionBinding {
  schemaVersion: 1
  runId: string
  ownerAgentIdAtStart: string
  runOrigin: RunExecutionOrigin
  kind: TaskExecutorKind
  requestedAgentId?: string | null
  effectiveAgentId?: string | null
  ephemeralRole?: string | null
  executionMaterialHash: string
  ownerAssignmentSource: 'conversation_active' | 'continuation' | 'handoff' | 'parent_task' | 'scheduled_task'
  executionSelectionSource: 'task_owner' | 'workflow_participant' | 'ephemeral_role'
  resolutionKind: 'direct' | 'merged_redirect' | 'main_fallback'
}

export interface AgentExecutionReadiness {
  conversationReady: boolean
  handoffReady: boolean
  autoRoutable: boolean
  collaborationReady: boolean
  reasons: string[]
}

export interface AgentExecutionProfile {
  requestedAgentId: string
  effectiveAgentId: string
  personaRef: string
  name: string
  charter: string
  personality: string
  rules: string
  knowledgeIndex: string
  allowedKnowledgeRefs: string[]
  knowledgeWriteOwnerAgentId: string
  knowledgeWriteNamespace: `agents/${string}/knowledge`
  executionMaterialHash: string
  readinessRevision: string
  redirectChain: Array<{ from: string; to: string; reason: 'merged' }>
  readiness: AgentExecutionReadiness
}

export interface ConversationAgentState {
  sessionAgentId: string
  activeAgentId: string
  handoffGeneration: number
}
