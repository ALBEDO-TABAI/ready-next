export type SessionRecallMatchKind = 'message' | 'title' | 'task' | 'attachment' | 'recent' | 'semantic'

export interface SessionRecallHit {
  conversationId: string
  lineageRootId: string
  resumeTitle: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  threadKey: string
  matchedBy: SessionRecallMatchKind[]
  score: number
  hitExcerpt?: string | null
  latestTaskTitle?: string | null
  latestTaskSummary?: string | null
  attachmentNames: string[]
  updatedAt: string
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
