import type { CodexBeginNewContextActionRef } from '../../../../../shared/ipc-contracts/agent-runtime'
import { CodexBindingRepository } from '../codex-binding-repository'
import type { CodexCompositionBase } from './base'
import type { CodexCompositionLive } from './live-state'

export type BeginNewContextIssuerDeps = Pick<CodexCompositionBase, 'repository'>
  & { readonly live: CodexCompositionLive }

/** Issuing and remembering "begin new context" actions. */
export function createBeginNewContextIssuer(deps: BeginNewContextIssuerDeps) {
  const { repository } = deps
  const issuedBeginNewContextActions = new Map<string, {
    actionRef: CodexBeginNewContextActionRef
    resolveCurrentEvidenceDigest: () => string | null
  }>()

  // Every exact-request rejection mints a new operation id, so this boot-scoped
  // issuance map is bounded by insertion order. Recovery only ever replays a
  // recent issuance; the repository remains the authority for already-committed
  // operations, so evicting the oldest entries cannot resurrect stale authority.
  const MAX_ISSUED_BEGIN_NEW_CONTEXT_ACTIONS = 256

  const issueBeginNewContextAction = (
    action: Parameters<CodexBindingRepository['buildBeginNewContextActionRef']>[0],
    resolveCurrentEvidenceDigest: () => string | null,
  ): CodexBeginNewContextActionRef => {
    const actionRef = repository.buildBeginNewContextActionRef(action)
    issuedBeginNewContextActions.delete(actionRef.operationId)
    issuedBeginNewContextActions.set(actionRef.operationId, {
      actionRef,
      resolveCurrentEvidenceDigest,
    })
    while (issuedBeginNewContextActions.size > MAX_ISSUED_BEGIN_NEW_CONTEXT_ACTIONS) {
      const oldest = issuedBeginNewContextActions.keys().next()
      if (oldest.done) break
      issuedBeginNewContextActions.delete(oldest.value)
    }
    return actionRef
  }

  return {
    issuedBeginNewContextActions,
    MAX_ISSUED_BEGIN_NEW_CONTEXT_ACTIONS,
    issueBeginNewContextAction,
  }
}

export type BeginNewContextIssuer = ReturnType<typeof createBeginNewContextIssuer>
