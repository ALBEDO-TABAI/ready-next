import { PrePersistenceAdmissionError } from '../../send-scoped-confirmation'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { codexDocumentWidgetGuidance } from '../codex-document-widget-guidance'
import { digestCanonicalJson, resolveCodexNativeModelSettings } from '../codex-model-gateway-contract'
import { codexAllowsDirectProvisionalStream } from '../codex-product-turn-authorization'
import type { CodexAliasBindingPort, CodexStartIdentityPort, CodexPreparedRunContextPort } from '../codex-runtime-composition'
import { createCodexTaskActivityProjector } from '../codex-task-activity-projector'
import { ensureRemoteChannelAlias } from '../remote-channel-alias'
import type { ActionSurfaceReader } from './action-surface'
import type { CodexCompositionBase } from './base'
import type { BeginNewContextIssuer } from './begin-new-context'
import type { CodexCompositionLive } from './live-state'
import { isoNow } from './support'
import { codexThreadStartsLineage } from '../codex-thread-materialization'

export type AliasPortsDeps = Pick<CodexCompositionBase, 'clearLastReferenceSkill' | 'gate' | 'input' | 'preparedDetails' | 'publishCodexActionSurfaceInvalidation' | 'releasePreparedReservation' | 'repository' | 'verified'>
  & Pick<BeginNewContextIssuer, 'issuedBeginNewContextActions'>
  & Pick<ActionSurfaceReader, 'readActionSurface'>
  & { readonly live: CodexCompositionLive }

/** Alias binding, start identity and prepared run context ports. */
export function createAliasPorts(deps: AliasPortsDeps) {
  const { live, clearLastReferenceSkill, gate, input, issuedBeginNewContextActions, preparedDetails, publishCodexActionSurfaceInvalidation, readActionSurface, releasePreparedReservation, repository, verified } = deps
  const aliasBindingPort: CodexAliasBindingPort = {
    ensureChannelAlias(scopeId) {
      ensureRemoteChannelAlias({ database: input.database, repository, scopeId,
        runtimeManifestDigest: verified.manifestDigest, protocolSchemaDigest: verified.manifest.stableV2SchemaSha256 })
    },
    readAliasGeneration(aliasId) {
      return repository.readActiveAliasBinding(aliasId)?.aliasGeneration ?? null
    },
    readLatestAliasGeneration(aliasId) {
      return repository.readLatestAliasGeneration(aliasId)
    },
    readActiveProductRunVisibilityIdentity(readyRunId) {
      return repository.readActiveProductRunVisibilityIdentity(readyRunId)
    },
    readCommittedProductRunVisibilityIdentity(readyRunId) {
      return repository.readCommittedProductRunVisibilityIdentity(readyRunId)
    },
    readLifecycleSnapshot(identity) {
      const surface = readActionSurface(identity)
      if (surface.state !== 'active_head') throw new Error('codex_active_head_missing')
      return surface.lifecycle
    },
    readHeadActionProjection(identity) {
      const surface = readActionSurface(identity)
      if (surface.state !== 'active_head') throw new Error('codex_active_head_missing')
      return surface.head
    },
    readActionSurface(identity) {
      return readActionSurface(identity)
    },
    beginNewContext(request) {
      gate.assertOpen()
      const issuance = issuedBeginNewContextActions.get(request.actionRef.operationId)
      const result = repository.beginNewContext({
        actionRef: request.actionRef,
        issuedActionRef: issuance?.actionRef ?? null,
        assertRecoveryEligible() {
          if (!issuance || issuance.resolveCurrentEvidenceDigest()
            !== issuance.actionRef.candidateEvidenceDigest) {
            throw new CodexBindingRepositoryError('begin_new_context_recovery_no_longer_eligible')
          }
        },
        runtimeManifestDigest: verified.manifestDigest,
        protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
        committedAt: isoNow(),
      })
      if (result.committed) {
        clearLastReferenceSkill(request.actionRef.scopeId)
        publishCodexActionSurfaceInvalidation(request.actionRef.scopeId, result.invalidation)
      }
      return {
        ok: true,
        boundary: result.boundary,
        aliasGeneration: result.invalidation.aliasGeneration,
        actionSurfaceInvalidation: {
          contract: 'codex_action_surface_invalidation_v1',
          ...result.invalidation,
        },
      }
    },
  }

  const startIdentityPort: CodexStartIdentityPort = {
    resolveMethods(scopeId, workbenchMode) {
      gate.assertOpen()
      let binding = repository.readActiveAliasBinding(scopeId)
      if (binding && codexThreadStartsLineage(binding.materializationKind) && !binding.codexThreadId) {
        const refreshed = repository.refreshPristineFreshStartHeadAtomic({
          aliasId: scopeId,
          runtimeManifestDigest: verified.manifestDigest,
          protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
          createdAt: isoNow(),
        })
        if (refreshed.kind === 'refreshed') {
          publishCodexActionSurfaceInvalidation(scopeId, refreshed.invalidation)
        }
        if (refreshed.kind === 'reset_required') throw new Error('codex_conversation_reset_required')
        binding = 'binding' in refreshed ? refreshed.binding : null
      }
      if (binding) {
        const surface = readActionSurface({
          aliasId: binding.aliasId,
          aliasGeneration: binding.aliasGeneration,
          workbenchMode,
        })
        if (surface.state !== 'active_head') throw new Error('codex_alias_binding_missing')
        if (surface.head.actions.send_new_message.availability !== 'ready') {
          const blocker = surface.head.actions.send_new_message.blockers[0]
          if (blocker === 'history_materializing') throw new Error('codex_conversation_materializing')
          if (blocker === 'thread_busy') throw new Error('codex_thread_busy')
          throw new Error('codex_conversation_reset_required')
        }
      }
      if (!binding || binding.retiredAt) throw new Error('codex_alias_binding_missing')
      if (binding.materializationKind === 'native_fork'
        && binding.materializationState === 'pending') {
        throw new PrePersistenceAdmissionError(
          'conversation_materializing', true,
          digestCanonicalJson({ scopeId, state: binding.materializationState }),
          'codex_conversation_materializing',
        )
      }
      if (binding.materializationKind === 'native_fork'
        && binding.materializationState !== 'confirmed') {
        throw new PrePersistenceAdmissionError(
          'conversation_reset_required', false,
          digestCanonicalJson({ scopeId, state: binding.materializationState }),
          'codex_conversation_reset_required',
        )
      }
      if (binding.continuationBlockedAt) throw new PrePersistenceAdmissionError(
        'conversation_reset_required', false,
        digestCanonicalJson({ scopeId, reason: binding.continuationBlockedReason }),
        'codex_conversation_reset_required',
      )
      if (binding.hasActiveFence) throw new PrePersistenceAdmissionError(
        'thread_busy', true, digestCanonicalJson({ scopeId, state: 'thread_busy' }),
        'codex_thread_busy',
      )
      return binding.codexThreadId ? ['turn/start'] : ['thread/start', 'turn/start']
    },
    async reserve({ scopeId, methods }) {
      gate.assertOpen()
      if (!live.registry) throw new Error('codex_registry_unavailable')
      const binding = repository.readActiveAliasBinding(scopeId)
      if (!binding) throw new Error('codex_alias_binding_missing')
      const expected = binding.codexThreadId ? ['turn/start'] : ['thread/start', 'turn/start']
      if (methods.join('\u0000') !== expected.join('\u0000')) throw new Error('codex_reservation_method_drift')
      return live.registry.reserve({ scopeId, existingThread: Boolean(binding.codexThreadId) })
    },
    async reconcileReservationContractFailure({ reservationResult, evidenceDigest }) {
      if (!live.registry || !reservationResult || typeof reservationResult !== 'object') return
      const reservation = (reservationResult as { reservation?: { reservationSetId?: unknown } }).reservation
      if (typeof reservation?.reservationSetId !== 'string') return
      const present = live.registry.snapshot().members.some((member) => member.reservationSetId === reservation.reservationSetId)
      if (present) live.registry.releaseBeforeDispatch({ reservationSetId: reservation.reservationSetId, evidenceDigest })
    },
    async releaseAfterIngressFailure({ reservation, failure }) {
      releasePreparedReservation(reservation.reservationSetId, failure.evidenceDigest)
    },
    async releaseAfterPrePersistenceRejection({ reservation, rejection }) {
      releasePreparedReservation(reservation.reservationSetId, rejection.admissionEvidenceDigest)
    },
  }

  const preparedRunContextPort: CodexPreparedRunContextPort = {
    async resolve({ prepared, scope }) {
      gate.assertOpen()
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || scope.id !== prepared.readyToolHostIdentity.scopeId) throw new Error('codex_prepared_context_mismatch')
      const activityHost = live.host
      const taskActivityProjector = activityHost
        ? createCodexTaskActivityProjector({
          store: activityHost.getTaskProjectionStore(),
          publish: (patch) => activityHost.publishActivityProjection({
            type: 'updated',
            scopeId: scope.id,
            aliasGeneration: prepared.conversationAlias.aliasGeneration,
            messageVisibilityEpoch: scope.messageVisibilityEpoch,
            visibilityOwnerKind: 'product_alias',
            agent: scope.agent,
            ownerAgentId: scope.activeAgentId || scope.agent,
            taskOrigin: 'user_root',
            handoffGeneration: scope.handoffGeneration,
            runId: prepared.runId,
            taskId: prepared.taskId,
            module: prepared.externalReadSlice?.kind === 'lark_cli_read' ? 'feishu' : 'system',
            taskProjectionId: prepared.taskId,
            ...patch,
          }),
          taskId: prepared.taskId,
          runId: prepared.runId,
          messageVisibilityEpoch: scope.messageVisibilityEpoch,
          larkCliRead: prepared.externalReadSlice?.kind === 'lark_cli_read',
        })
        : null
      return {
        turnBuildContext: {
          turnRequestId: detail.turnRequestId,
          reasoningEffort: resolveCodexNativeModelSettings(
            detail.upstream.snapshot,
          ).reasoningEffort,
          readyRunId: prepared.runId,
          toolSurfaceDigest: prepared.readyToolSurface.toolSurfaceDigest,
          turnContractDigest: detail.turnContractDigest,
          upstreamProfileSnapshotDigest: detail.upstream.snapshotDigest,
          readyMemorySnapshot: prepared.readyMemorySnapshot,
          documentWidgetGuidance: codexDocumentWidgetGuidance(prepared),
          replacedOriginUserMessageId: prepared.replacedOriginUserMessageId ?? null,
        },
        collection: {
          terminalTimeoutMs: null,
          actionReceiptRefs: [],
          interactionState: null,
          waitingFor: null,
          terminalReasonCandidate: 'done',
          abortInitiator: null,
          budgetState: { ...prepared.productBudgetSeed },
          contextState: {
            resourceAnchorDigest: prepared.resourceAnchorDigest,
            automaticCompactionExchanges: [],
          },
          providerDiagnostics: { provider: 'ready_gateway', agentProtocol: 'openai', wireApi: 'responses' },
          recoveryCheckpointRef: null,
          browserContinuationRef: null,
          browserProofRefs: [],
          otherProofRefs: [],
          projectionPatchRefs: [],
          allowNullPhaseFallback: false,
          allowDirectProvisionalStream: codexAllowsDirectProvisionalStream(prepared),
          onActivity(event) {
            taskActivityProjector?.observe(event)
          },
          onProvisionalDelta(event) {
            if (!codexAllowsDirectProvisionalStream(prepared)) return
            live.host?.emitProvisionalDelta({
              scopeId: scope.id,
              aliasGeneration: prepared.conversationAlias.aliasGeneration,
              messageVisibilityEpoch: scope.messageVisibilityEpoch,
              agent: scope.agent,
              ownerAgentId: scope.activeAgentId || scope.agent,
              handoffGeneration: scope.handoffGeneration,
              runId: prepared.runId,
              taskId: prepared.taskId,
              delta: event.delta,
            })
          },
        },
      }
    },
  }

  return {
    aliasBindingPort,
    startIdentityPort,
    preparedRunContextPort,
  }
}

export type AliasPorts = ReturnType<typeof createAliasPorts>
