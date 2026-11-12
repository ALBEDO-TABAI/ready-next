import type { BrowserAttentionActionRequest, BrowserUserAttention } from '../../../../shared/browser-user-attention'
import { parseSendScopedRequest, type SendScopedRequest, type SendScopedResponse } from '../../../../shared/ipc-contracts/agent-runtime'
import { browserAttentionUserInput } from '../../browser-engine/browser-user-attention'

export async function sendBrowserAttentionInput(request: BrowserAttentionActionRequest, deps: {
  readAttention(browserTaskId: string): BrowserUserAttention | null
  readParent(taskId: string): { scopeId: string; runId: string; messageVisibilityEpoch?: number } | null
  readScope(scopeId: string): { source_kind: string; message_visibility_epoch?: number } | null
  messageExists(id: string): boolean
  readPhysicalTarget(tabId: string): string | null
  changed?(browserTaskId: string): void
  watchPersisted?(scopeId: string, messageId: string, handler: () => void): () => void
  send(request: SendScopedRequest): Promise<SendScopedResponse>
}): Promise<SendScopedResponse> {
  const attention = deps.readAttention(request.browserTaskId)
  if (!attention || attention.id !== request.attentionId) throw new Error('browser_attention_stale')
  if (attention.tabId && deps.readPhysicalTarget(attention.tabId) !== attention.physicalTargetToken) {
    throw new Error('browser_attention_target_changed')
  }
  const parent = deps.readParent(attention.parentTaskId)
  const scope = parent && deps.readScope(parent.scopeId)
  if (!parent || parent.runId !== attention.ownerRunId || !scope || scope.source_kind !== 'local'
    || scope.message_visibility_epoch !== request.expectedMessageVisibilityEpoch
    || parent.messageVisibilityEpoch !== request.expectedMessageVisibilityEpoch) {
    throw new Error('browser_attention_scope_changed')
  }
  const input = parseSendScopedRequest(browserAttentionUserInput(attention, {
    scopeId: parent.scopeId,
    expectedMessageVisibilityEpoch: request.expectedMessageVisibilityEpoch,
    expectedAliasGeneration: request.expectedAliasGeneration,
    actionAdmissionRef: request.actionAdmissionRef,
  }))
  if (deps.messageExists(input.userMessage.id)) throw new Error('browser_attention_already_sent')
  const unwatch = deps.watchPersisted?.(input.scopeId, input.userMessage.id, () => deps.changed?.(attention.browserTaskId))
  try {
    return await deps.send(input)
  } finally {
    unwatch?.()
    // A persisted user message consumes attention even if the subsequent run fails.
    if (deps.messageExists(input.userMessage.id)) deps.changed?.(attention.browserTaskId)
  }
}
