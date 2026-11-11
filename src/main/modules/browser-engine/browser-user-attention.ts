import { BROWSER_ATTENTION_COPY, browserAttentionRecordSchema, type BrowserUserAttention } from '../../../shared/browser-user-attention'
import type { BrowserCapabilityTaskHandle } from './capability-types'
import type { SendScopedRequest } from '../../../shared/ipc-contracts/agent-runtime'

export function readBrowserUserAttention(task: BrowserCapabilityTaskHandle, payload: Record<string, unknown>): BrowserUserAttention | null {
  if (!task.parentTaskId || !task.createdByRunId || task.status === 'completed') return null
  const reviewRejected = task.result && typeof task.result === 'object'
    && 'userAttentionReason' in task.result && task.result.userAttentionReason === 'review_rejected'
  const record = payload.userAttention !== undefined
    ? browserAttentionRecordSchema.parse(payload.userAttention)
    : reviewRejected
      ? { id: `review:${task.createdByRunId}`, reason: 'review_rejected' as const, tabId: null, physicalTargetToken: null }
      : null
  if (!record) return null
  const copy = BROWSER_ATTENTION_COPY[record.reason]
  return {
    ...record, status: 'needs_user', browserTaskId: task.taskId,
    parentTaskId: task.parentTaskId, ownerRunId: task.createdByRunId,
    action: { kind: 'send_user_input', label: copy.label,
      text: `${copy.sentence}\n原任务：${task.parentTaskId}（浏览器任务：${task.taskId}，原执行：${task.createdByRunId}）` },
  }
}

export function browserAttentionUserInput(attention: BrowserUserAttention, input: {
  scopeId: string
  expectedMessageVisibilityEpoch: number
  expectedAliasGeneration?: number
  actionAdmissionRef: NonNullable<SendScopedRequest['actionAdmissionRef']>
}): SendScopedRequest {
  const id = `browser-help:${attention.browserTaskId}:${attention.id}`
  return {
    ...input, requestId: id, message: attention.action.text,
    userMessage: { id, content: attention.action.text, timestamp: new Date().toISOString(),
      meta: { workbenchMode: 'browser', browserTaskRef: {
        browserTaskId: attention.browserTaskId, parentTaskId: attention.parentTaskId,
        ownerRunId: attention.ownerRunId, attentionId: attention.id, reason: attention.reason,
      } },
      attachmentConfirmation: { selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0 },
    },
    ...(attention.tabId ? { resources: [{ kind: 'browser_tab' as const, id: attention.tabId, name: '原任务页面', tabId: attention.tabId }] } : {}),
  }
}
