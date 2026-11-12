import type { AgentMessage } from './types'
import { useAgent } from '../../stores/useAgent'
import type { CaptureSelection } from '../workbench/capture'

/** A short title from the answer's first line, without Markdown marks. */
export function answerTitle(content: string): string {
  const line = content.split(/\r?\n/).map(text => text.replace(/^[\s#>*+\-\d.)]+/, '').replace(/[*_`~[\]]/g, '').trim()).find(Boolean) ?? ''
  return (line.length > 28 ? `${line.slice(0, 28)}…` : line) || '助手回答'
}

/** An answer as a capture (W6 §3.2): its words, with the conversation — and the run, when known — as the source. */
export function answerCapture(message: Pick<AgentMessage, 'content' | 'meta'>): CaptureSelection {
  const { conversationId } = useAgent.getState()
  if (!conversationId) throw new Error('这段对话还没有保存，暂时不能收下')
  const run = typeof message.meta?.runId === 'string' && message.meta.runId ? message.meta.runId : undefined
  return { ref: { kind: 'conversation', id: conversationId, ...(run ? { run } : {}) }, title: answerTitle(message.content), text: message.content.trim() }
}
