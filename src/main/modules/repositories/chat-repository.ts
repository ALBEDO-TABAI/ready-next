import { getDatabase } from '../database'
import type { ChatConversationRecord, ConversationAttachmentRecord } from '../database/records'

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

  updateConversationTitle(payload: { id: string; title: string }): void {
    getDatabase().chat.updateConversationTitle(payload.id, payload.title)
  }
}
