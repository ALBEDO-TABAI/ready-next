import type {
  ChatConversationRecord,
  ChatMessageRecord,
  ConversationAttachmentRecord,
} from '../database'

export class AgentRepository {
  private async getDatabase() {
    const { getRepositoryDatabase } = await import('./database-accessor')
    return getRepositoryDatabase()
  }

  async getConversationScope(id: string): Promise<ChatConversationRecord | null> {
    return (await this.getDatabase()).getConversationScope(id)
  }

  async getChatMessages(conversationId: string): Promise<ChatMessageRecord[]> {
    return (await this.getDatabase()).getChatMessages(conversationId)
  }

  async listConversationAttachments(conversationId: string): Promise<ConversationAttachmentRecord[]> {
    return (await this.getDatabase()).listConversationAttachments(conversationId)
  }
}
