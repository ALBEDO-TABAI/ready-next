import type {
  BrowserCheckpointSuspensionReason,
  BrowserConfirmationSuspensionRequest,
  BrowserHumanTakeoverPrompt,
} from '../../../shared/browser-workflow-control'
import { browserHumanTakeoverBlockedReason } from '../../../shared/browser-workflow-control'
import { browserConfirmationNotice } from '../../../shared/browser-confirmation-card'
import type { CanonicalAssistantMessageReceipt } from '../../../shared/ipc-contracts/canonical-message'
import { parseObjectStrict, serializeWorkflowJson, workflowDigest } from './browser-workflow-codec'
import type { WorkflowRawDatabase } from './browser-workflow-unit-of-work'
import { buildCanonicalCoreCloseoutMessage } from './canonical-core-closeout-message'
import { requireRunMessageVisibilityEpoch } from './agent-session-message-visibility'

interface ChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json?: string | null
  message_visibility_epoch?: number
}

function resolveCheckpointNotice(input: {
  suspensionReason: BrowserCheckpointSuspensionReason
  suspensionRequest?: BrowserConfirmationSuspensionRequest | null
  humanTakeoverPrompt?: BrowserHumanTakeoverPrompt | null
  publicNotice?: string | null
}): string {
  if (input.suspensionRequest) return browserConfirmationNotice(input.suspensionRequest)
  if (input.suspensionReason === 'human_takeover') {
    return browserHumanTakeoverBlockedReason(input.humanTakeoverPrompt)
      || '页面需要你完成验证或手动操作。完成后可以从任务卡继续。'
  }
  const notice = String(input.publicNotice || '').trim()
  if (!notice) throw new Error('checkpoint_public_notice_required')
  return notice
}

export function writeCanonicalCheckpointNotice(
  db: WorkflowRawDatabase,
  input: {
    parentTaskId: string
    ownerRunId: string
    conversationId: string
    checkpointId: string
    createdAt: string
    suspensionReason: BrowserCheckpointSuspensionReason
    suspensionRequest?: BrowserConfirmationSuspensionRequest | null
    humanTakeoverPrompt?: BrowserHumanTakeoverPrompt | null
    publicNotice?: string | null
  },
): CanonicalAssistantMessageReceipt {
  const canonicalMessage = buildCanonicalCoreCloseoutMessage({
    parentTaskId: input.parentTaskId,
    ownerRunId: input.ownerRunId,
    conversationId: input.conversationId,
    finalText: resolveCheckpointNotice(input),
    timestamp: input.createdAt,
    terminalReason: input.suspensionReason === 'human_takeover'
      ? 'human_takeover'
      : `checkpoint_${input.suspensionReason}`,
    checkpointId: input.checkpointId,
  })
  canonicalMessage.meta = {
    ...canonicalMessage.meta,
    checkpointId: input.checkpointId,
    ...(input.suspensionRequest ? { browserConfirmationRequest: input.suspensionRequest } : {}),
  }
  const canonicalMessageDigest = workflowDigest(canonicalMessage)
  const messageVisibilityEpoch = requireRunMessageVisibilityEpoch(db, {
    ownerRunId: input.ownerRunId,
    conversationId: input.conversationId,
  })
  db.prepare(
    `INSERT INTO chat_messages (
       id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
     ) VALUES (?, ?, 'assistant', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    canonicalMessage.id,
    canonicalMessage.conversationId,
    canonicalMessage.content,
    canonicalMessage.timestamp,
    serializeWorkflowJson(canonicalMessage.meta, 'checkpoint_canonical_assistant_meta_json'),
    messageVisibilityEpoch,
  )
  const messageReadback = db.prepare(
    `SELECT id, conversation_id, role, content, timestamp, meta_json,
            message_visibility_epoch
       FROM chat_messages WHERE id = ? LIMIT 1`,
  ).get<Required<ChatMessageRow>>(canonicalMessage.id)
  if (!messageReadback || messageReadback.role !== 'assistant'
    || messageReadback.message_visibility_epoch !== messageVisibilityEpoch) {
    throw new Error('checkpoint_canonical_assistant_message_readback_failed')
  }
  const readbackCanonical = {
    id: messageReadback.id,
    conversationId: messageReadback.conversation_id,
    role: 'assistant' as const,
    content: messageReadback.content,
    timestamp: messageReadback.timestamp,
    meta: parseObjectStrict<Record<string, unknown>>(
      messageReadback.meta_json || '{}',
      'checkpoint_canonical_assistant_meta_json',
    ),
  }
  if (workflowDigest(readbackCanonical) !== canonicalMessageDigest) {
    throw new Error('checkpoint_canonical_assistant_message_digest_mismatch')
  }
  return { canonicalMessage: readbackCanonical, canonicalMessageDigest }
}
