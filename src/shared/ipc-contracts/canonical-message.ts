export interface CanonicalAssistantMessage {
  id: string
  conversationId: string
  role: 'assistant'
  content: string
  timestamp: string
  meta: Record<string, unknown>
}

export interface CanonicalAssistantMessageReceipt {
  canonicalMessage: CanonicalAssistantMessage
  canonicalMessageDigest: string
}
