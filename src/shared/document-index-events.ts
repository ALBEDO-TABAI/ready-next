export type DocumentIndexChangeReason = 'rebuild' | 'incremental'

export interface DocumentIndexChangedEvent {
  workspaceRoot: string
  reason: DocumentIndexChangeReason
  changedPaths: string[]
  completedAt: number
}
