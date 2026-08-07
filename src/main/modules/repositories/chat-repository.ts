import { getDatabase } from '../database'
import type { ChatConversationRecord, ConversationAttachmentRecord } from '../database'

export class ChatRepository {
  getConversations(agent: string) {
    return getDatabase().getConversations(agent)
  }

  listRecentConversations(limit = 50): Array<ChatConversationRecord & { last_message_at?: string | null }> {
    return getDatabase().listConversationScopes(undefined, limit)
  }

  getMessages(conversationId: string) {
    return getDatabase().getChatMessages(conversationId)
  }

  listConversationAttachments(conversationId: string): ConversationAttachmentRecord[] {
    return getDatabase().listConversationAttachments(conversationId)
  }

  updateConversationTitle(payload: { id: string; title: string }): void {
    getDatabase().updateConversationTitle(payload.id, payload.title)
  }
}
