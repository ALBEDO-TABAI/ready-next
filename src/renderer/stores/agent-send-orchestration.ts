import { createEmptyScopeRunState } from '../modules/agent/scopeRunState'
import {
  buildCodexIngressInputWithDiagnostics,
  filterAttachmentsForComposedAgentInput,
  resolveReferencedFilePoolAttachments,
  serializePersistedAttachments as serializeAttachments,
} from '../modules/agent/messageComposer'
import { mapBackendErrorToFriendly } from '../modules/agent/error-message-mapping'
import { emitRendererAgentMetric } from '../modules/agent/rendererMetrics'
import { buildCodexCurrentDocumentAnchor } from '../modules/agent/codexCurrentDocumentAnchor'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from '../modules/agent/composer-authority'
import { useMode } from './useMode'
import {
  mapSendScopedResponseToMessageResult,
  type IngressAdmittedEvent,
  type PrePersistenceErrorKind,
  type SendMessageResult,
  type TerminalErrorKind,
  type ProductTurnReceipt,
  type SendScopedRequest,
} from '../../shared/ipc-contracts/agent-runtime'
import type { CanonicalAssistantMessage } from '../../shared/ipc-contracts/canonical-message'
import type { ChatAttachment, ScopeRunState } from '../modules/agent/types'
import type { AgentSendResult, AgentState } from './agent-store-types'
import {
  activeSessionKey,
  generateId,
  isSameAttachmentPoolEntry,
  normalizeSessionSlice,
  sessionKeyForScopeId,
  withSessionSliceAndActiveMirror,
} from './agent-store-helpers'
import { parseActionAuthorizationMode } from '../../shared/action-authorization-mode'
import { collectWorkbenchSurfaceResources } from './agent-workbench-resources'
import { codexHeadActionAdmissionRef } from '../modules/agent/productTurnReceipt'
import { resolveNaturalExplicitRetry } from '../modules/agent/explicit-retry-routing'

type PendingIngressSnapshot = {
  requestId: string
  scopeId: string
  userMessageId: string
  responseMessageId: string
  agent: string
  content: string
  timestamp: Date
  attachments: ChatAttachment[]
  originAliasGeneration: number | null
  originMessageVisibilityEpoch: number
  originSessionKey: string
}

export const pendingIngressSnapshots = new Map<string, PendingIngressSnapshot>()

export function pendingIngressOriginMatches(
  state: AgentState,
  pending: Pick<
    PendingIngressSnapshot,
    'scopeId' | 'originAliasGeneration' | 'originMessageVisibilityEpoch' | 'originSessionKey'
  >,
): boolean {
  const slice = normalizeSessionSlice(state.sessions[pending.originSessionKey])
  return Boolean(
    state.sessions[pending.originSessionKey]
    && !state.retiredScopeIds[pending.scopeId]
    && slice.conversationId === pending.scopeId
    && slice.aliasGeneration === pending.originAliasGeneration
    && slice.messageVisibilityEpoch === pending.originMessageVisibilityEpoch,
  )
}

export function rejectedMessageResult(errorKind: PrePersistenceErrorKind): SendMessageResult {
  return {
    success: false,
    disposition: 'rejected_before_persistence',
    shouldClearInput: false,
    preserveInput: true,
    errorKind,
  }
}

export function terminalReasonFromSendError(
  errorKind: TerminalErrorKind,
): ScopeRunState['terminalReason'] {
  switch (errorKind) {
    case 'superseded':
      return 'cancelled_runtime'
    case 'circuit_break':
    case 'unknown':
      return 'infra_error'
    default:
      return errorKind
  }
}

export async function sendAgentMessage(input: {
  get: () => AgentState
  set: (partial: AgentState | Partial<AgentState> | ((state: AgentState) => AgentState | Partial<AgentState>)) => void
  content: string
  options?: {
    codexExternalReadSlice?: Record<string, unknown>
    explicitRetry?: SendScopedRequest['explicitRetry']
    actionAdmissionRef?: SendScopedRequest['actionAdmissionRef']
  }
  commitPersistedIngressSnapshot: (event: Pick<
    IngressAdmittedEvent,
    'requestId' | 'scopeId' | 'originUserMessageId' | 'aliasGeneration' | 'messageVisibilityEpoch' | 'admittedAt'
  >) => boolean
  completeScopeRunAfterSendSuccess: (
    scopeId: string,
    requestId: string,
    payload: {
      canonicalMessage: CanonicalAssistantMessage
      canonicalMessageDigest: string
      productTurnReceipt?: ProductTurnReceipt
    },
  ) => Promise<void>
  clearInfrastructureWatchdog: (scopeId: string, requestId: string) => void
}): Promise<SendMessageResult> {
  const { get, set, content, options } = input
  const normalizedContent = content.trim()
  const { attachments: pendingAttachments } = get()
  if (!normalizedContent && pendingAttachments.length === 0) {
    throw new Error('empty_input')
  }
  const {
    currentAgent,
    attachments,
    currentScope,
    currentScopeId,
    pendingContinuationIntent,
  } = get()

  if (pendingContinuationIntent) return rejectedMessageResult('conversation_reset_required')
  if (!currentScope || !currentScopeId) return rejectedMessageResult('scope_missing')
  if (currentScope.agent !== currentAgent) {
    return rejectedMessageResult('conversation_reset_required')
  }
  const originSessionKey = sessionKeyForScopeId(get(), currentScopeId)
  const originSlice = normalizeSessionSlice(get().sessions[originSessionKey])
  const originComposerAuthority = captureComposerAuthority(get())
  if (
    originComposerAuthority.sessionId !== originSessionKey
    || originComposerAuthority.scopeId !== currentScopeId
    || originComposerAuthority.sessionConversationId !== currentScopeId
  ) return rejectedMessageResult('conversation_reset_required')
  const sendGate = originSlice.scopeHeadActionProjection?.actions.send_new_message
  if (!sendGate) return rejectedMessageResult('head_unavailable')
  if (sendGate.availability !== 'ready') {
    return rejectedMessageResult(sendGate.blockers[0] === 'thread_busy'
      ? 'thread_busy' : sendGate.blockers[0] === 'history_materializing'
        ? 'conversation_materializing' : 'conversation_reset_required')
  }
  const activeAgentName = currentAgent
  const activeScope = currentScope
  const activeScopeId = currentScopeId

  const { filePool } = get()
  const referencedPoolAttachments = resolveReferencedFilePoolAttachments(content, filePool)
  let currentDocumentAnchor
  try {
    currentDocumentAnchor = await buildCodexCurrentDocumentAnchor(activeScopeId)
  } catch {
    return rejectedMessageResult('attachment_unavailable')
  }
  const workbenchResources = collectWorkbenchSurfaceResources()
  let explicitRetry = options?.explicitRetry
  const retryHasCurrentContext = attachments.length > 0
    || referencedPoolAttachments.length > 0
    || workbenchResources.length > 0
    || Boolean(options?.codexExternalReadSlice)
  if (explicitRetry && retryHasCurrentContext) {
    return rejectedMessageResult('explicit_retry_control_invalid')
  }
  if (!explicitRetry) {
    const retryRoute = await resolveNaturalExplicitRetry({
      content,
      attachmentCount: attachments.length + referencedPoolAttachments.length,
      workbenchResourceCount: workbenchResources.length,
      externalReadSlicePresent: Boolean(options?.codexExternalReadSlice),
      messages: originSlice.messages,
      scopeId: activeScopeId,
      messageVisibilityEpoch: originSlice.messageVisibilityEpoch,
      readProductTurnPresentation: window.electronAPI?.agent?.readProductTurnPresentation
        ? (readyRunId) => window.electronAPI.agent.readProductTurnPresentation(
            readyRunId,
            useMode.getState().workbenchMode,
          )
        : null,
    })
    if (retryRoute.kind === 'resource_restatement_required') {
      return rejectedMessageResult('explicit_retry_control_invalid')
    }
    if (retryRoute.kind === 'unavailable') {
      return rejectedMessageResult('conversation_reset_required')
    }
    if (retryRoute.kind === 'resolved') {
      explicitRetry = retryRoute.explicitRetry
    }
  }

  const currentAttachments = filterAttachmentsForComposedAgentInput(content, [...attachments])
  const messageAttachments = [...currentAttachments]
  for (const attachment of referencedPoolAttachments) {
    if (!messageAttachments.some((candidate) => isSameAttachmentPoolEntry(candidate, attachment))) {
      messageAttachments.push(attachment)
    }
  }
  const composedInput = await buildCodexIngressInputWithDiagnostics({
    content,
    attachments: messageAttachments,
    currentDocumentAnchor,
  })
  if (composedInput.diagnostics.inputFailedCount > 0) {
    emitRendererAgentMetric('renderer_attachment_input_failed', {
      scopeId: activeScopeId,
      agent: activeAgentName,
      failedCount: composedInput.diagnostics.inputFailedCount,
    })
    return rejectedMessageResult('attachment_unavailable')
  }
  const composedResources = [
    ...(composedInput.resources || []),
    ...workbenchResources.filter((resource) => !(composedInput.resources || []).some((existing) => (
      existing.kind === resource.kind
      && JSON.stringify(existing) === JSON.stringify(resource)
    ))),
  ]
  const beforeDispatch = get()
  if (
    !isComposerAuthorityCurrent(beforeDispatch, originComposerAuthority)
    || activeSessionKey(beforeDispatch) !== originSessionKey
    || !pendingIngressOriginMatches(beforeDispatch, {
      scopeId: activeScopeId,
      originAliasGeneration: originSlice.aliasGeneration,
      originMessageVisibilityEpoch: originSlice.messageVisibilityEpoch,
      originSessionKey,
    })
  ) return rejectedMessageResult('conversation_reset_required')

  const userMsgId = generateId('msg')
  const userTimestamp = new Date()
  const persistedAttachments = serializeAttachments(messageAttachments)
  const userMessageMeta = {
    sourceKind: activeScope.sourceKind,
    sourceId: activeScope.sourceId,
    threadKey: activeScope.threadKey,
    direction: 'local-input',
    workbenchMode: useMode.getState().workbenchMode,
    actionAuthorizationMode: parseActionAuthorizationMode(
      activeScope.meta.actionAuthorizationMode,
    ),
    ...(persistedAttachments.length > 0 ? { attachments: persistedAttachments } : {}),
    ...(options?.codexExternalReadSlice
      ? { codexExternalReadSlice: options.codexExternalReadSlice }
      : {}),
  }

  const requestId = generateId('req')
  const responseId = generateId('response')
  pendingIngressSnapshots.set(requestId, {
    requestId,
    scopeId: activeScopeId,
    userMessageId: userMsgId,
    responseMessageId: responseId,
    agent: activeAgentName,
    content,
    timestamp: userTimestamp,
    attachments: messageAttachments,
    originAliasGeneration: originSlice.aliasGeneration,
    originMessageVisibilityEpoch: originSlice.messageVisibilityEpoch,
    originSessionKey,
  })

  try {
    if (typeof window === 'undefined' || !window.electronAPI?.agent?.sendScoped) {
      pendingIngressSnapshots.delete(requestId)
      return rejectedMessageResult('host_unavailable')
    }
    const result: AgentSendResult = await window.electronAPI.agent.sendScoped({
      scopeId: activeScopeId,
      message: composedInput.message,
      requestId,
      ...(typeof originSlice.aliasGeneration === 'number'
        ? { expectedAliasGeneration: originSlice.aliasGeneration }
        : {}),
      expectedMessageVisibilityEpoch: originSlice.messageVisibilityEpoch,
      resources: composedResources.length > 0 ? composedResources : undefined,
      currentDocumentAnchor,
      ...(!explicitRetry ? {
        actionAdmissionRef: options?.actionAdmissionRef
          ?? codexHeadActionAdmissionRef(originSlice.scopeHeadActionProjection),
      } : {}),
      userMessage: {
        id: userMsgId,
        content,
        timestamp: userTimestamp.toISOString(),
        meta: userMessageMeta,
        attachmentConfirmation: {
          selectedCount: messageAttachments.length,
          metadataCount: persistedAttachments.length,
          inputIncludedCount: composedInput.diagnostics.inputIncludedCount,
          inputFailedCount: composedInput.diagnostics.inputFailedCount,
        },
      },
      ...(explicitRetry ? { explicitRetry } : {}),
    })

    if (
      pendingIngressSnapshots.has(requestId)
      && (result.disposition === 'terminal_success'
        || result.disposition === 'terminal_failure_after_persistence')
    ) {
      input.commitPersistedIngressSnapshot({
        requestId,
        scopeId: activeScopeId,
        originUserMessageId: userMsgId,
        aliasGeneration: result.aliasGeneration,
        messageVisibilityEpoch: originSlice.messageVisibilityEpoch,
        admittedAt: userTimestamp.toISOString(),
      })
    }

    if (!result.success) {
      const mapped = mapSendScopedResponseToMessageResult(result)
      if (result.disposition !== 'terminal_failure_after_persistence') {
        const pending = pendingIngressSnapshots.get(requestId)
        const friendly = mapBackendErrorToFriendly({
          error: result.error,
          errorKind: result.errorKind,
        })
        const receivedAt = new Date().toISOString()
        set((state) => {
          if (!pending || pendingIngressSnapshots.get(requestId) !== pending
            || !pendingIngressOriginMatches(state, pending)) return {}
          const sessionKey = pending.originSessionKey
          const slice = normalizeSessionSlice(state.sessions[sessionKey])
          if (!state.sessions[sessionKey] || slice.conversationId !== activeScopeId) return {}
          const currentRun = slice.scopeRunStates[activeScopeId]
            || createEmptyScopeRunState({ scopeId: activeScopeId, agent: activeAgentName })
          const nextScopeRunStates = {
            ...slice.scopeRunStates,
            [activeScopeId]: {
              ...currentRun,
              updatedAt: receivedAt,
              softError: {
                message: result.error,
                errorKind: result.errorKind,
                toolName: null,
                friendlyMessage: friendly.friendlyMessage,
                technicalDetails: friendly.technicalDetails || null,
                receivedAt,
              },
            },
          }
          return {
            sessions: {
              ...state.sessions,
              [sessionKey]: { ...slice, scopeRunStates: nextScopeRunStates },
            },
            ...(state.activeSessionId === sessionKey ? { scopeRunStates: nextScopeRunStates } : {}),
          }
        })
        pendingIngressSnapshots.delete(requestId)
        emitRendererAgentMetric('renderer_friendly_error_surfaced', {
          scopeId: activeScopeId,
          agent: activeAgentName,
          errorKind: result.errorKind,
        })
        if (result.errorKind === 'action_projection_confirmation_required'
          && pending && pendingIngressOriginMatches(get(), pending)) {
          await get().refreshCodexActionSurface(activeScopeId)
        }
        return mapped
      }
      input.clearInfrastructureWatchdog(activeScopeId, requestId)
      await input.completeScopeRunAfterSendSuccess(activeScopeId, requestId, {
        canonicalMessage: result.canonicalMessage,
        canonicalMessageDigest: result.canonicalMessageDigest,
        productTurnReceipt: result.productTurnReceipt,
      })
      return mapped
    }
    await input.completeScopeRunAfterSendSuccess(activeScopeId, requestId, {
      canonicalMessage: result.canonicalMessage,
      canonicalMessageDigest: result.canonicalMessageDigest,
      productTurnReceipt: result.productTurnReceipt,
    })
    return mapSendScopedResponseToMessageResult(result)
  } catch (error) {
    const admissionWasObserved = !pendingIngressSnapshots.has(requestId)
    pendingIngressSnapshots.delete(requestId)
    if (!admissionWasObserved) return rejectedMessageResult('host_unavailable')
    input.clearInfrastructureWatchdog(activeScopeId, requestId)
    const friendly = mapBackendErrorToFriendly({
      error: error instanceof Error ? error.message : String(error),
      errorKind: 'unknown',
    })
    set((state) => {
      const sessionKey = originSessionKey
      const slice = normalizeSessionSlice(state.sessions[sessionKey])
      if (!state.sessions[sessionKey]
        || slice.conversationId !== activeScopeId
        || slice.messageVisibilityEpoch !== originSlice.messageVisibilityEpoch
        || slice.streamingRequestId !== requestId) return {}
      const currentRun = slice.scopeRunStates[activeScopeId]
      return withSessionSliceAndActiveMirror(state, sessionKey, {
        messages: slice.messages.map((message) => (
          message.id === responseId
            ? { ...message, content: friendly.friendlyMessage, type: 'system' as const }
            : message
        )),
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
        scopeRunStates: currentRun
          ? {
              ...slice.scopeRunStates,
              [activeScopeId]: {
                ...currentRun,
                phase: 'error',
                terminalReason: 'infra_error',
                error: error instanceof Error ? error.message : String(error),
                updatedAt: new Date().toISOString(),
              },
            }
          : slice.scopeRunStates,
      })
    })
    return {
      success: false,
      disposition: 'terminal_failure_after_persistence',
      shouldClearInput: true,
      preserveInput: false,
      errorKind: 'unknown',
    }
  }
}
