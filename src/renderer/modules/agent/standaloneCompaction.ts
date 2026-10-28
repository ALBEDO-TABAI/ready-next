import type { ChatAttachment } from './types'

export const CONTEXT_COMPACT_SKILL_ID = 'context-compact'

/**
 * The user sent only the context-compact skill: no other text and no other attachment. That is a request to compact
 * the conversation now, which runs as its own step rather than inside an Agent turn.
 */
export function isStandaloneCompactionRequest(
  content: string,
  attachments: ReadonlyArray<Pick<ChatAttachment, 'source' | 'skillId' | 'name'>>,
): boolean {
  if (attachments.length === 0
    || !attachments.every((attachment) => (
      attachment.source === 'skill-folder' && attachment.skillId === CONTEXT_COMPACT_SKILL_ID
    ))) return false
  const remainder = attachments.reduce((text, attachment) => text.split(`@[${attachment.name}]`).join(''), content)
  return remainder.trim() === ''
}

/** What the composer says when compaction did not happen; the draft is kept either way. */
export function compactionFailureMessage(code: string): string {
  if (code === 'no_active_operation' || code === 'alias_not_bound') return '目前没有需要压缩的新内容。'
  if (code === 'thread_busy' || code === 'lifecycle_action_pending') return '当前还有任务在进行，等它结束后再压缩。'
  if (code === 'native_protocol_error') return '压缩没有开始，对话保持原样，可以再试一次。'
  if (code === 'compaction_state_unknown') {
    return '暂时无法确认压缩结果。稍后再看；如果对话一直无法继续，可以开始新上下文。'
  }
  if (code === 'binding_conflict') return '当前对话已变化，请重试。'
  if (code === 'persistence_failed') return '没能保存压缩记录，请重试。'
  return '这次没能压缩上下文，请重试。'
}
