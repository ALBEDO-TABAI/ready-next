export interface DocActionPayload {
  type: string
  [key: string]: unknown
}

export type DocActionMutationReason =
  | 'changed'
  | 'saved'
  | 'no_match'
  | 'identical'
  | 'rejected'
  | 'cancelled'
  | 'validation_failed'
  | 'not_mutation'

export interface DocActionMutationOutcome {
  mutated: boolean
  mutationReason: DocActionMutationReason
  documentSaved?: boolean
  errorKind?: 'widget_boundary_violation' | 'document_visual_syntax_invalid'
  recoverable?: boolean
}

export type DocActionSaveState = 'saved' | 'dirty' | 'unsaved'

export interface DocActionDocumentIdentity {
  tabId: string
  title: string
  path: string | null
  dirty: boolean
  requiresSave: boolean
  saveState: DocActionSaveState
}

export interface DocActionExecutionResult {
  summary: string
  document: DocActionDocumentIdentity | null
}


export interface CommandResult {
  handled: boolean
  text: string
  isError?: boolean
}


export interface ActiveDocumentSnapshot {
  tabId: string
  title: string
  path: string | null
  content: string
  isDirty: boolean
  charCount: number
}


export type DocActionFailureReason = 'target_not_resolved'
