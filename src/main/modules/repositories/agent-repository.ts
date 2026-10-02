import type { ChatConversationRecord, ChatMessageRecord, ConversationAttachmentRecord } from '../database/records'


export class AgentRepository {
  private async getDatabase() {
    const { getRepositoryDatabase } = await import('./database-accessor')
    return getRepositoryDatabase()
  }

  async getConversationScope(id: string): Promise<ChatConversationRecord | null> {
    return (await this.getDatabase()).chat.getConversationScope(id)
  }

  async getChatMessages(conversationId: string): Promise<ChatMessageRecord[]> {
    return (await this.getDatabase()).chat.getChatMessages(conversationId)
  }

  async listConversationAttachments(conversationId: string): Promise<ConversationAttachmentRecord[]> {
    return (await this.getDatabase()).chat.listConversationAttachments(conversationId)
  }
}
