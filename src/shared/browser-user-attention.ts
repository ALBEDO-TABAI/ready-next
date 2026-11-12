import { z } from 'zod'
import { parseSendScopedRequest, type SendScopedRequest } from './ipc-contracts/agent-runtime'

export const browserAttentionRecordSchema = z.object({
  id: z.string().min(1),
  reason: z.enum(['login', 'captcha', 'takeover', 'review_rejected']),
  tabId: z.string().min(1).nullable(),
  physicalTargetToken: z.string().min(1).nullable(),
}).strict()
export type BrowserAttentionRecord = z.infer<typeof browserAttentionRecordSchema>
export type BrowserAttentionReason = BrowserAttentionRecord['reason']
export type BrowserAttentionTarget = {
  browserTaskId: string
  parentTaskId: string
  ownerRunId: string
  tabId: string
  physicalTargetToken: string
}
export type BrowserUserAttention = BrowserAttentionRecord & {
  status: 'needs_user'
  browserTaskId: string
  parentTaskId: string
  ownerRunId: string
  action: { kind: 'send_user_input'; label: string; text: string }
}
export type BrowserAttentionActionRequest = {
  browserTaskId: string
  attentionId: string
  expectedMessageVisibilityEpoch: number
  expectedAliasGeneration?: number
  actionAdmissionRef: NonNullable<SendScopedRequest['actionAdmissionRef']>
}

export const browserAttentionReadSchema = z.object({ scopeId: z.string().min(1), browserTaskId: z.string().min(1) }).strict()
export function parseBrowserAttentionAction(value: unknown): BrowserAttentionActionRequest {
  const request = z.object({
    browserTaskId: z.string().min(1), attentionId: z.string().min(1),
    expectedMessageVisibilityEpoch: z.number().int().nonnegative(),
    expectedAliasGeneration: z.number().int().nonnegative().optional(), actionAdmissionRef: z.unknown(),
  }).strict().parse(value)
  const checked = parseSendScopedRequest({
    scopeId: 'validate', requestId: 'validate', message: 'validate',
    expectedMessageVisibilityEpoch: request.expectedMessageVisibilityEpoch,
    actionAdmissionRef: request.actionAdmissionRef,
    userMessage: { id: 'validate', content: 'validate', timestamp: new Date().toISOString(), meta: {},
      attachmentConfirmation: { selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0 } },
  })
  if (!checked.actionAdmissionRef) throw new Error('browser_attention_admission_ref_required')
  return { ...request, actionAdmissionRef: checked.actionAdmissionRef }
}

export const BROWSER_ATTENTION_COPY: Record<BrowserAttentionReason, { label: string; sentence: string; notification: string }> = {
  login: { label: '我处理好了，继续', sentence: '我已完成登录，请重新检查页面后继续原任务。', notification: '需要你完成登录' },
  captcha: { label: '我处理好了，继续', sentence: '我已完成验证码，请重新检查页面后继续原任务。', notification: '需要你完成验证码' },
  takeover: { label: '让助手接着做', sentence: '请重新检查页面后接着处理原任务。', notification: '你已接管，助手已停止操作' },
  review_rejected: { label: '重新尝试', sentence: '请根据复核未通过的原因重新处理原任务。', notification: '任务复核未通过，需要你处理' },
}

export interface BrowserTaskAttentionChanged { scopeId: string; browserTaskId: string }
