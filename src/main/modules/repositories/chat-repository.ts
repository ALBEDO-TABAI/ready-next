import { getDatabase } from '../database'
import type { ConversationAttachmentRecord } from '../database'

export class ChatRepository {
  getConversations(agent: string) {
    return getDatabase().getConversations(agent)
  }

  getMessages(conversationId: string) {
    return getDatabase().getChatMessages(conversationId)
  }

  listConversationAttachments(conversationId: string): ConversationAttachmentRecord[] {
    return getDatabase().listConversationAttachments(conversationId)
  }

  deleteConversation(conversationId: string): void {
    getDatabase().deleteConversation(conversationId)
  }

  saveMessage(payload: {
    id: string
    conversationId: string
    role: string
    content: string
    timestamp: string
    meta?: Record<string, unknown>
  }): void {
    getDatabase().addChatMessage(
      payload.id,
      payload.conversationId,
      payload.role,
      payload.content,
      payload.timestamp,
      payload.meta,
    )
  }

  createConversation(payload: { id: string; agent: string; title: string }): void {
    getDatabase().createConversation(payload.id, payload.agent, payload.title)
  }

  updateConversationTitle(payload: { id: string; title: string }): void {
    getDatabase().updateConversationTitle(payload.id, payload.title)
  }
}
