export interface ComposerAuthoritySession {
  conversationId: string | null
  aliasGeneration: number | null
  messageVisibilityEpoch: number
}

export interface ComposerAuthorityState {
  activeSessionId: string | null
  currentScopeId: string | null
  composerAuthorityRevision: number
  sessions: Record<string, ComposerAuthoritySession | undefined>
}

export interface ComposerAuthoritySnapshot {
  revision: number
  sessionId: string | null
  scopeId: string | null
  sessionConversationId: string | null
  aliasGeneration: number | null
  messageVisibilityEpoch: number
}

export function captureComposerAuthority(
  state: ComposerAuthorityState,
): ComposerAuthoritySnapshot {
  const sessionId = state.activeSessionId
  const session = sessionId ? state.sessions[sessionId] : undefined
  return {
    revision: state.composerAuthorityRevision,
    sessionId,
    scopeId: state.currentScopeId,
    sessionConversationId: session?.conversationId ?? null,
    aliasGeneration: session?.aliasGeneration ?? null,
    messageVisibilityEpoch: session?.messageVisibilityEpoch ?? 0,
  }
}

export function isComposerAuthorityCurrent(
  state: ComposerAuthorityState,
  expected: ComposerAuthoritySnapshot,
): boolean {
  const current = captureComposerAuthority(state)
  return current.revision === expected.revision
    && current.sessionId === expected.sessionId
    && current.scopeId === expected.scopeId
    && current.sessionConversationId === expected.sessionConversationId
    && current.aliasGeneration === expected.aliasGeneration
    && current.messageVisibilityEpoch === expected.messageVisibilityEpoch
}
