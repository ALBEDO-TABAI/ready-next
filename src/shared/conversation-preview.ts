export interface ConversationPreviewMessage { id: string; role: string; content: string; meta?: Record<string, unknown> }

/** A run must occur in the visible scope; never substitute the latest turn for a missing run. */
export function conversationTurn(messages: ConversationPreviewMessage[], run?: string) {
  let at = run ? messages.findIndex(message => message.meta?.runId === run) : messages.findLastIndex(message => message.role === 'user')
  if (at < 0) throw new Error('这一轮对话已不存在或不可见')
  while (at > 0 && messages[at].role !== 'user') at--
  if (messages[at].role !== 'user') throw new Error('这一轮的问题不可见')
  const question = messages[at]
  if (run && question.meta?.runId && question.meta.runId !== run) throw new Error('这一轮的问题不可见')
  const next = messages.findIndex((message, index) => index > at && message.role === 'user')
  const answers = messages.slice(at + 1, next < 0 ? undefined : next).filter(message => message.role === 'assistant' && (!run || message.meta?.runId === run))
  return { messageId: question.id, question: question.content, answer: answers.map(message => message.content).join('\n\n').slice(0, 1200) }
}
