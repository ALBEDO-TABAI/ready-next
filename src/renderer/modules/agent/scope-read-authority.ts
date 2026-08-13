export interface ScopeReadAuthorityScope {
  id: string
  messageVisibilityEpoch: number
}

export interface ScopeReadAuthorityState {
  scopeAuthorityRevision: number
  scopes: ScopeReadAuthorityScope[]
  retiredScopeIds: Record<string, true | undefined>
}

export interface ScopeReadAuthoritySnapshot {
  revision: number
  scopeEpochs: Readonly<Record<string, number>>
}

export function captureScopeReadAuthority(
  state: ScopeReadAuthorityState,
  scopeIds: readonly string[],
): ScopeReadAuthoritySnapshot | null {
  const scopeById = new Map(state.scopes.map((scope) => [scope.id, scope] as const))
  const scopeEpochs: Record<string, number> = {}
  for (const scopeId of scopeIds) {
    const scope = scopeById.get(scopeId)
    if (!scope || state.retiredScopeIds[scopeId]) return null
    scopeEpochs[scopeId] = scope.messageVisibilityEpoch
  }
  return {
    revision: state.scopeAuthorityRevision,
    scopeEpochs,
  }
}

export function isScopeReadAuthorityCurrent(
  state: ScopeReadAuthorityState,
  expected: ScopeReadAuthoritySnapshot,
): boolean {
  if (state.scopeAuthorityRevision !== expected.revision) return false
  const scopeById = new Map(state.scopes.map((scope) => [scope.id, scope] as const))
  return Object.entries(expected.scopeEpochs).every(([scopeId, epoch]) => {
    const scope = scopeById.get(scopeId)
    return !state.retiredScopeIds[scopeId]
      && scope?.messageVisibilityEpoch === epoch
  })
}

export function scopeRowMatchesReadAuthority(
  expected: ScopeReadAuthoritySnapshot,
  scopeId: string | null | undefined,
  messageVisibilityEpoch: number | null | undefined,
): boolean {
  if (!scopeId || !Number.isSafeInteger(messageVisibilityEpoch)) return false
  return expected.scopeEpochs[scopeId] === messageVisibilityEpoch
}

export function captureScopeEpoch(
  state: ScopeReadAuthorityState,
  scopeId: string,
): number | null {
  if (state.retiredScopeIds[scopeId]) return null
  const scope = state.scopes.find((candidate) => candidate.id === scopeId)
  return scope && Number.isSafeInteger(scope.messageVisibilityEpoch)
    ? scope.messageVisibilityEpoch
    : null
}

export function isScopeEpochCurrent(
  state: ScopeReadAuthorityState,
  scopeId: string,
  expectedMessageVisibilityEpoch: number,
): boolean {
  return captureScopeEpoch(state, scopeId) === expectedMessageVisibilityEpoch
}
