import { create } from 'zustand'
import type { ReadyRef } from '../../../shared/ready-ref'
import { conversationTurn } from '../../../shared/conversation-preview'

export const useConversationReveal = create<{ target: { scopeId: string; messageId: string; requestId: string } | null }>(() => ({ target: null }))

export async function revealConversation(ref: Extract<ReadyRef, { kind: 'conversation' }>): Promise<void> {
  const { useAgent, revealSearchConversation } = await import('../../stores/useAgent')
  useConversationReveal.setState({ target: null })
  await revealSearchConversation(ref.id)
  if (ref.run) {
    const state = useAgent.getState(), session = state.activeSessionId && state.sessions[state.activeSessionId]
    if (!session || state.conversationId !== ref.id) throw new Error('会话已切换')
    const turn = conversationTurn(session.messages.map(message => ({ ...message, role: message.type })), ref.run)
    useConversationReveal.setState({ target: { scopeId: ref.id, messageId: turn.messageId, requestId: crypto.randomUUID() } })
  }
}
