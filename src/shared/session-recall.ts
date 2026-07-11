export type SessionRecallMatchKind =
  | 'message'
  | 'title'
  | 'task'
  | 'attachment'
  | 'recent'
  | 'recent_self_lineage'
  | 'semantic'

/** P0-1 — displayable session state for the history panel, derived in main
 *  from the scope's latest task projection (status + interaction_state). */
export type SessionRecallSessionStatus = 'working' | 'blocked' | 'check_in_pending' | 'done' | 'error'

export interface SessionRecallHit {
  conversationId: string
  lineageRootId: string
  resumeTitle: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  threadKey: string
  agentId?: string | null
  activeAgentId?: string | null
  matchedBy: SessionRecallMatchKind[]
  score: number
  hitExcerpt?: string | null
  latestTaskTitle?: string | null
  latestTaskSummary?: string | null
  attachmentNames: string[]
  updatedAt: string
  /** P0-1 — null/absent = pure history, renders unlit. */
  sessionStatus?: SessionRecallSessionStatus | null
}

export interface SessionRecallCapsule {
  conversationId: string
  lineageRootId: string
  resumeTitle: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  threadKey: string
  summary: string
  latestTaskTitle?: string | null
  latestTaskSummary?: string | null
  attachmentNames: string[]
  updatedAt: string
}

export interface SessionRecallContextRef {
  conversationId: string
  attachedAt: string
}
