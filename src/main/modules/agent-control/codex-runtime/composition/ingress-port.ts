import { readyMemoryPromptPayload } from '../../ready-memory'
import {
  codexReplacedTurnContext,
  markCodexTurnReplacedInOpenTransaction,
  resolveCodexTurnReplacementTarget,
} from '../codex-turn-replacement'
import { PrePersistenceAdmissionError, IngressPersistenceError, resolveAttachmentConfirmation } from '../../send-scoped-confirmation'
import { readProjectDirectory, canonicalProjectDirectory } from '../chat-project-directory'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { buildCodexIngressAdmittedDigest } from '../codex-binding-repository'
import { codexDocumentWidgetGuidance } from '../codex-document-widget-guidance'
import { digestCanonicalJson, digestReadyAdditionalContext } from '../codex-model-gateway-contract'
import { sha256 } from '../codex-product-surface-ingress'
import { assertCodexProfileRouteCurrent, CodexProfileRouteChangedError } from '../codex-profile-admission'
import type { CodexIngressPort } from '../codex-runtime-composition'
import type { SameThreadContinuationCandidate } from '../codex-same-thread-continuation'
import { CodexToolSurfaceError } from '../codex-tool-surface'
import { buildCodexExplicitRetryContext } from '../codex-turn-input-builder'
import type { CodexCompositionBase } from './base'
import type { BeginNewContextIssuer } from './begin-new-context'
import type { CodexCompositionLive } from './live-state'
import { isoNow, stableErrorCode } from './support'
import type { IngressPrepare } from './ingress-prepare'

export type IngressPortDeps = Pick<CodexCompositionBase, 'detailPrepared' | 'gatewayRepository' | 'input' | 'ownerMainBootId' | 'preparedDetails' | 'rawDb' | 'repository' | 'verified'>
  & Pick<BeginNewContextIssuer, 'issueBeginNewContextAction'>
  & Pick<IngressPrepare, 'prepareIngress'>
  & { readonly live: CodexCompositionLive }

/** The product ingress port: preparation from the prepare factory, and atomic persistence. */
export function createIngressPort(deps: IngressPortDeps) {
  const { live, detailPrepared, gatewayRepository, input, issueBeginNewContextAction, ownerMainBootId, preparedDetails, rawDb, repository, verified, prepareIngress } = deps
  const ingressPort: CodexIngressPort = {
    prepareIngress,
    async persistIngressAtomic({ scope, request, reservation, prepared }) {
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || detailPrepared.get(prepared.runId) !== prepared || !live.host) {
        throw new IngressPersistenceError('ingress_transaction_failed', sha256(`missing:${prepared.runId}`), 'codex_prepared_detail_missing')
      }
      const resolveCurrentRecoveryEvidence = (): string | null => {
        try {
          const current = detail.resolveCurrentContinuation()
          return current?.decision.kind === 'requires_new_context'
            ? current.decision.evidenceDigest
            : null
        } catch (error) {
          // silent-catch: an incompatible tool surface yields its evidence digest; any other resolution failure reads as no current recovery evidence
          return error instanceof CodexToolSurfaceError
            && error.compatibility
            && error.compatibility.kind !== 'compatible'
            ? error.compatibility.evidenceDigest
            : null
        }
      }
      const issueAtomicRecovery = (candidateEvidenceDigest: string) => (
        issueBeginNewContextAction({
          scopeId: scope.id,
          scopeEpoch: request.expectedMessageVisibilityEpoch,
          candidateEvidenceDigest,
          consequenceDigest: digestCanonicalJson({
            requestId: request.requestId,
            actionAdmissionRef: request.actionAdmissionRef ?? null,
          }),
          draftRevision: request.draftRevision ?? null,
        }, resolveCurrentRecoveryEvidence)
      )
      const admittedAt = isoNow()
      const eventBase = {
        type: 'ingress_admitted' as const,
        requestId: request.requestId,
        scopeId: scope.id,
        originUserMessageId: request.userMessage.id,
        aliasGeneration: prepared.conversationAlias.aliasGeneration,
        ingressAdmittedRevision: 1,
        admittedAt,
      }
      try {
        rawDb.exec('BEGIN IMMEDIATE')
        const currentProjectScope = live.host.getScope(scope.id)
        if (!currentProjectScope || readProjectDirectory(currentProjectScope) !== detail.projectDirectory) {
          throw new PrePersistenceAdmissionError('action_projection_confirmation_required', true,
            digestCanonicalJson({ runId: prepared.runId, stage: 'project_selection_changed' }),
            'codex_project_directory_changed')
        }
        if (detail.projectDirectory) canonicalProjectDirectory(detail.projectDirectory)
        assertCodexProfileRouteCurrent({ settings: input.settings, expected: detail.upstream })
        const scopeEpoch = rawDb.prepare(`
          SELECT message_visibility_epoch
            FROM chat_conversations
           WHERE id = ? AND closed_at IS NULL
           LIMIT 1
        `).get<{ message_visibility_epoch: number }>(scope.id)
        if (!scopeEpoch || !Number.isSafeInteger(scopeEpoch.message_visibility_epoch)) {
          throw new Error('codex_message_visibility_scope_missing')
        }
        const messageVisibilityEpoch = scopeEpoch.message_visibility_epoch
        if (request.expectedMessageVisibilityEpoch !== messageVisibilityEpoch
          || (
            typeof request.expectedAliasGeneration === 'number'
            && request.expectedAliasGeneration > prepared.conversationAlias.aliasGeneration
          )) {
          throw new Error('codex_ingress_expected_identity_mismatch')
        }
        let currentContinuationCandidate: SameThreadContinuationCandidate | null = null
        if (detail.continuationCandidate) {
          const current = detail.resolveCurrentContinuation()
          if (!current) {
            throw new PrePersistenceAdmissionError(
              'action_projection_confirmation_required',
              true,
              digestCanonicalJson({ runId: prepared.runId, stage: 'atomic_continuation_missing' }),
              'codex_atomic_continuation_missing',
            )
          }
          if (current.decision.kind === 'requires_new_context') {
            const reason = current.decision.reason ?? 'host_unavailable'
            throw new PrePersistenceAdmissionError(
              reason,
              reason === 'host_unavailable',
              current.decision.evidenceDigest,
              current.decision.reason || 'host_unavailable',
              issueAtomicRecovery(current.decision.evidenceDigest),
            )
          }
          if (digestCanonicalJson(current.candidate)
            !== digestCanonicalJson(detail.continuationCandidate)) {
            throw new PrePersistenceAdmissionError(
              'action_projection_confirmation_required',
              true,
              digestCanonicalJson({
                runId: prepared.runId,
                stage: 'atomic_continuation_changed',
                prepared: detail.continuationCandidate,
                current: current.candidate,
              }),
              'codex_atomic_continuation_changed',
            )
          }
          currentContinuationCandidate = current.candidate
        }
        const admissionWithoutDigest = {
          prepared,
          reservation,
          ownerMainBootId,
          admittedAt,
          ingressAdmittedRevision: 1,
          threadBindingId: detail.threadBindingId,
          isolatedThreadCwd: detail.isolatedThreadCwd,
          turnRequestId: detail.turnRequestId,
          runtimeManifestDigest: verified.manifestDigest,
          protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
          instructionContractDigest: detail.instructionContractDigest,
          codexModel: 'ready-e0-model',
          upstreamProfileSnapshotRef: detail.upstream.snapshotRef,
          upstreamProfileSnapshotDigest: detail.upstream.snapshotDigest,
          additionalContextDigest: digestReadyAdditionalContext({
            resourceReferences: prepared.ingress.kind === 'user_ingress'
              ? prepared.ingress.resourceAdditionalContext
              : [],
            explicitRetry: prepared.ingress.kind === 'user_ingress'
              && prepared.ingress.attemptKind === 'explicit_retry'
              ? buildCodexExplicitRetryContext(prepared.ingress)
              : null,
            readyMemory: readyMemoryPromptPayload(prepared.readyMemorySnapshot),
            documentWidgetGuidance: codexDocumentWidgetGuidance(prepared),
            replacedTurn: codexReplacedTurnContext(prepared),
          }),
          turnContractDigest: detail.turnContractDigest,
          messageVisibilityEpoch,
          readyParentReceipt: {
            messageRole: 'user' as const,
            messageContent: request.userMessage.content,
            messageTimestamp: request.userMessage.timestamp,
            messageMetaDigest: digestCanonicalJson(request.userMessage.meta),
            executionBindingDigest: digestCanonicalJson(detail.executionBinding),
          },
          continuationCandidate: currentContinuationCandidate,
        }
        const ingressAdmittedDigest = buildCodexIngressAdmittedDigest(admissionWithoutDigest)
        const existing = rawDb.prepare('SELECT 1 AS present FROM chat_messages WHERE id = ? LIMIT 1').get(request.userMessage.id)
        if (existing) throw new Error('codex_origin_message_already_exists')
        if (prepared.replacedOriginUserMessageId) {
          const target = request.replaceLatestTurn?.userMessageId === prepared.replacedOriginUserMessageId
            ? resolveCodexTurnReplacementTarget(rawDb, {
                scopeId: scope.id,
                userMessageId: prepared.replacedOriginUserMessageId,
              })
            : null
          if (!target) {
            throw new PrePersistenceAdmissionError('action_projection_confirmation_required', true,
              digestCanonicalJson({ runId: prepared.runId, stage: 'replace_latest_turn_target' }),
              'codex_replace_latest_turn_target_stale')
          }
          markCodexTurnReplacedInOpenTransaction(rawDb, {
            scopeId: scope.id, target, replacingRunId: prepared.runId,
          })
        } else if (request.replaceLatestTurn) {
          throw new PrePersistenceAdmissionError('action_projection_confirmation_required', true,
            digestCanonicalJson({ runId: prepared.runId, stage: 'replace_latest_turn_unprepared' }),
            'codex_replace_latest_turn_target_stale')
        }
        input.database.chat.addChatMessage(
          request.userMessage.id,
          scope.id,
          'user',
          request.userMessage.content,
          request.userMessage.timestamp,
          request.userMessage.meta,
          messageVisibilityEpoch,
        )
        live.host.getTaskProjectionStore().create({
          taskId: prepared.taskId,
          scopeId: scope.id,
          messageVisibilityEpoch,
          runId: prepared.runId,
          ...detail.productTaskFacts,
          taskTitle: prepared.neutralProjectionSeed.taskTitle,
          taskSummary: prepared.neutralProjectionSeed.taskSummary,
          status: 'running',
          interactionState: 'running',
          waitingFor: 'none',
          steps: [],
          ownerAgentId: scope.activeAgentId || scope.agent,
          taskOrigin: 'user_root',
          executionBinding: detail.executionBinding,
          createdAt: admittedAt,
          updatedAt: admittedAt,
        }, { silent: true, reasonHint: 'create' })
        live.host.createCodexActiveRunMetaInOpenTransaction({
          runId: prepared.runId,
          taskId: prepared.taskId,
          scopeId: scope.id,
          messageVisibilityEpoch,
          agentId: scope.activeAgentId || scope.agent,
          executionBinding: detail.executionBinding,
          taskType: detail.productTaskFacts.taskType,
        })
        gatewayRepository.storeSnapshot({ ...detail.upstream, createdAt: admittedAt })
        repository.admitProductBindingsInOpenTransaction({
          ...admissionWithoutDigest,
          ingressAdmittedDigest,
        })
        rawDb.exec('COMMIT')
        const attachmentConfirmation = resolveAttachmentConfirmation(
          request.userMessage.attachmentConfirmation,
        )
        return {
          persistence: {
            scope: 'pre-existing',
            message: 'persisted',
            ...attachmentConfirmation,
          },
          event: { ...eventBase, messageVisibilityEpoch, ingressAdmittedDigest },
        }
      } catch (error) {
        if (rawDb.inTransaction) rawDb.exec('ROLLBACK')
        if (error instanceof PrePersistenceAdmissionError) throw error
        if (error instanceof CodexToolSurfaceError
          && error.compatibility
          && error.compatibility.kind !== 'compatible') {
          throw new PrePersistenceAdmissionError(
            error.compatibility.kind,
            false,
            error.compatibility.evidenceDigest,
            error.code,
            issueAtomicRecovery(error.compatibility.evidenceDigest),
          )
        }
        if (error instanceof CodexProfileRouteChangedError) {
          // Observed before any durable write: report the configuration change
          // itself and let the caller re-read the action surface, which is the
          // single owner that classifies model/thread-config recovery.
          throw new PrePersistenceAdmissionError('action_projection_confirmation_required', true,
            digestCanonicalJson({ runId: prepared.runId, stage: 'atomic_ingress', code: error.code }),
            error.code)
        }
        if (error instanceof CodexBindingRepositoryError
          && (error.code === 'action_admission_ref_stale' || error.code === 'ordinary_uncommitted_tail_stale')) {
          throw new PrePersistenceAdmissionError('action_projection_confirmation_required', true,
            digestCanonicalJson({ runId: prepared.runId, stage: 'atomic_ingress', code: error.code }), error.code)
        }
        throw new IngressPersistenceError(
          'ingress_transaction_failed',
          digestCanonicalJson({ runId: prepared.runId, stage: 'atomic_ingress' }),
          stableErrorCode(error, 'codex_ingress_transaction_failed'),
        )
      }
    },
  }

  return {
    ingressPort,
  }
}

export type IngressPort = ReturnType<typeof createIngressPort>
