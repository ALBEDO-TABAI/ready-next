export type DocumentIndexChangeReason = 'rebuild' | 'incremental'

export interface DocumentIndexChangedEvent {
  workspaceRoot: string
  reason: DocumentIndexChangeReason
  changedPaths: string[]
  completedAt: number
}

export type DocumentWatcherFailureKind = 'enospc' | 'failed'

export interface DocumentWatcherFailedEvent {
  watcherId: string
  workspaceRoot: string
  kind: DocumentWatcherFailureKind
  message: string
  failedAt: number
}
