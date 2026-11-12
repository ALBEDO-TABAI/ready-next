import { createHash } from 'node:crypto'
import { ReadyRefSchema, toReadyUri, type ReadyRef } from '../../../../shared/ready-ref'
import { conversationTurn } from '../../../../shared/conversation-preview'
import type { ConversationPreviewMessage } from '../../../../shared/conversation-preview'
import type { FastCardItem } from '../../../../shared/fastcard'

/** Only saved content is read. A reference grants neither writing nor a new tool capability. */
export function readCapturedReference(input: ReadyRef, sources: {
  cards(): FastCardItem[]
  conversation(id: string): ConversationPreviewMessage[]
}) {
  const ref = ReadyRefSchema.parse(input)
  let name: string, text: string
  if (ref.kind === 'fastcard') {
    const item = sources.cards().find(item => item.id === ref.id)
    if (!item) throw new Error('收集已不存在')
    name = item.title || '收集'
    text = JSON.stringify(item)
  } else if (ref.kind === 'conversation') {
    const turn = conversationTurn(sources.conversation(ref.id), ref.run)
    name = '对话'
    text = `${turn.question}\n\n${turn.answer}`
  } else throw new Error('此引用必须通过原有的资料授权入口')
  return { name, text, path: toReadyUri(ref), digest: createHash('sha256').update(text).digest('hex') }
}
