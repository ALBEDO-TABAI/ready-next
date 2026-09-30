import type { ChatConversationRecord, ConversationAttachmentRecord } from '../database/records'
import { getDatabase } from '../database'


export class ChatRepository {
  getConversations(agent: string) {
    return getDatabase().chat.getConversations(agent)
  }

  listRecentConversations(limit = 50): Array<ChatConversationRecord & { last_message_at?: string | null }> {
    return getDatabase().chat.listConversationScopes(undefined, limit)
  }

  getMessages(conversationId: string) {
    return getDatabase().chat.getChatMessages(conversationId)
  }

  listConversationAttachments(conversationId: string): ConversationAttachmentRecord[] {
    return getDatabase().chat.listConversationAttachments(conversationId)
  }

  deleteConversation(conversationId: string): void {
    getDatabase().chat.deleteConversation(conversationId)
  }

  saveMessage(payload: {
    id: string
    conversationId: string
    role: string
    content: string
    timestamp: string
    meta?: Record<string, unknown>
  }): void {
    getDatabase().chat.addChatMessage(
      payload.id,
      payload.conversationId,
      payload.role,
      payload.content,
      payload.timestamp,
      payload.meta,
    )
  }

  createConversation(payload: { id: string; agent: string; title: string }): void {
    getDatabase().chat.createConversation(payload.id, payload.agent, payload.title)
  }

  updateConversationTitle(payload: { id: string; title: string }): void {
    getDatabase().chat.updateConversationTitle(payload.id, payload.title)
  }
}
