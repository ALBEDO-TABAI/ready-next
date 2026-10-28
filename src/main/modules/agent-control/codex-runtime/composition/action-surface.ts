import { classifyLifecycleOperation } from '../../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import { projectCodexHeadActionProjection } from '../codex-action-surface'
import { projectCodexLifecycleOperationV2 } from '../codex-lifecycle-action-surface'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import type { CodexCompositionBase } from './base'
import type { BeginNewContextIssuer } from './begin-new-context'
import type { HeadContinuation } from './head-continuation'
import type { CodexCompositionLive } from './live-state'

export type ActionSurfaceReaderDeps = Pick<BeginNewContextIssuer, 'issueBeginNewContextAction'>
  & Pick<CodexCompositionBase, 'repository' | 'verified'>
  & Pick<HeadContinuation, 'resolveHeadContinuation'>
  & { readonly live: CodexCompositionLive }

/** The conversation action surface the renderer reads. */
export function createActionSurfaceReader(deps: ActionSurfaceReaderDeps) {
  const { issueBeginNewContextAction, repository, resolveHeadContinuation, verified } = deps
  const readActionSurface = (identity: {
    aliasId: string
    aliasGeneration: number
    workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar'
  }) => {
    const activeBinding = repository.readActiveAliasBinding(identity.aliasId)
    if (!activeBinding) {
      const historyOnly = repository.readHistoryOnlyScope(identity.aliasId)
      if (!historyOnly || identity.aliasGeneration > historyOnly.sourceAliasGeneration) {
        throw new Error('codex_action_surface_scope_missing')
      }
      return {
        state: 'history_only' as const,
        scopeId: historyOnly.scopeId,
        scopeEpoch: historyOnly.scopeEpoch,
        sourceAliasGeneration: historyOnly.sourceAliasGeneration,
        head: null,
        lifecycle: null,
        beginNewContext: issueBeginNewContextAction({
          scopeId: historyOnly.scopeId,
          scopeEpoch: historyOnly.scopeEpoch,
          candidateEvidenceDigest: historyOnly.evidenceDigest,
          consequenceDigest: digestCanonicalJson(null),
          draftRevision: null,
        }, () => repository.readHistoryOnlyScope(historyOnly.scopeId)?.evidenceDigest ?? null),
        contextBoundaries: repository.readContextBoundaries({
          scopeId: historyOnly.scopeId,
          scopeEpoch: historyOnly.scopeEpoch,
        }),
      }
    }
    const read = repository.readLifecycleOperation(identity)
    const snapshot = classifyLifecycleOperation(read.facts)
    const base = {
      identity: read.identity,
      activeReadyRunId: read.activeReadyRunId,
      latestReadyRunId: read.latestReadyRunId,
      snapshot,
      interruptRequested: read.interruptRequested,
      interruptAcknowledged: read.interruptAcknowledged,
      requestedAction: read.requestedAction,
      evidenceDigest: digestCanonicalJson({ ...read, snapshot }),
    }
    const baseHeadFacts = repository.readHeadActionFacts({
      ...identity,
      currentRuntimeManifestDigest: verified.manifestDigest,
      currentProtocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
    })
    const binding = activeBinding
    const continuation = resolveHeadContinuation({
      ...identity,
      scopeEpoch: baseHeadFacts.scopeEpoch,
      workbenchMode: identity.workbenchMode || 'browser',
      threadBindingId: binding.threadBindingId,
      codexThreadId: binding.codexThreadId,
      materializationKind: binding.materializationKind,
    })
    const headContractBlocker = continuation?.reason
      ?? (binding.codexThreadId || binding.materializationKind === 'fresh_root_with_tail'
        ? null : undefined)
    const headFacts = { ...baseHeadFacts, headContractBlocker }
    const head = projectCodexHeadActionProjection(headFacts)
    const manualCompactionRuntime = binding.codexThreadId
      ? repository.resolveRuntimeOperationForThread({
          threadBindingId: binding.threadBindingId,
          operation: 'manual_compaction',
        })
      : null
    const lifecycleProjection = projectCodexLifecycleOperationV2({
      base,
      head,
      scopeEpoch: headFacts.scopeEpoch,
      threadBindingId: headFacts.threadBindingId,
      headRevision: headFacts.headRevision,
      materializationIntentRef: headFacts.materializationIntentRef ?? null,
      manualCompactionRuntimeBlocker: manualCompactionRuntime?.kind === 'compatible'
        ? null
        : manualCompactionRuntime?.kind === 'unsupported'
          ? 'runtime_unsupported'
          : manualCompactionRuntime ? 'runtime_unverified' : null,
    })
    const settledHeadBlocked = baseHeadFacts.continuationBlocked
      || (!binding.codexThreadId && head.actions.send_new_message.availability === 'blocked')
    const recoveryEvidenceDigest = ['idle_never_started', 'idle_ready_terminal_no_native', 'idle_native_thread'].includes(snapshot)
      ? continuation?.kind === 'requires_new_context' ? continuation.evidenceDigest
        : settledHeadBlocked ? base.evidenceDigest : null
      : null
    return {
      state: 'active_head' as const,
      scopeId: head.scopeId,
      scopeEpoch: headFacts.scopeEpoch,
      sourceAliasGeneration: head.actionProjectionVersion.headGeneration,
      head,
      lifecycle: lifecycleProjection,
      beginNewContext: recoveryEvidenceDigest
        ? issueBeginNewContextAction({
            scopeId: head.scopeId,
            scopeEpoch: headFacts.scopeEpoch,
            candidateEvidenceDigest: recoveryEvidenceDigest,
            consequenceDigest: digestCanonicalJson(head.actions.send_new_message.consequence),
            draftRevision: null,
          }, () => {
            if (settledHeadBlocked && continuation?.kind !== 'requires_new_context') {
              const current = repository.readLifecycleOperation(identity)
              const currentSnapshot = classifyLifecycleOperation(current.facts)
              const currentBinding = repository.readActiveAliasBinding(identity.aliasId)
              return ['idle_never_started', 'idle_ready_terminal_no_native', 'idle_native_thread'].includes(currentSnapshot)
                && (!current.facts.codexThreadId || currentBinding?.continuationBlockedAt)
                ? digestCanonicalJson({ ...current, snapshot: currentSnapshot }) : null
            }
            const current = resolveHeadContinuation({
              ...identity,
              scopeEpoch: headFacts.scopeEpoch,
              workbenchMode: identity.workbenchMode || 'browser',
              threadBindingId: binding.threadBindingId,
              codexThreadId: binding.codexThreadId,
              materializationKind: binding.materializationKind,
            })
            return current?.kind === 'requires_new_context' ? current.evidenceDigest : null
          })
        : null,
      contextBoundaries: repository.readContextBoundaries({
        scopeId: head.scopeId,
        scopeEpoch: headFacts.scopeEpoch,
      }),
    }
  }

  return {
    readActionSurface,
  }
}

export type ActionSurfaceReader = ReturnType<typeof createActionSurfaceReader>
