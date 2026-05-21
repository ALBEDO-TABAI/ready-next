import type { ConversationScope } from './contracts/types'

export interface ExternalMemoryPrefetchRequest {
  scope: ConversationScope
  userText: string
}

export interface ExternalMemoryProvider {
  id: string
  initialize?: () => Promise<void> | void
  shutdown?: () => Promise<void> | void
  prefetch?: (request: ExternalMemoryPrefetchRequest) => Promise<string[]> | string[]
}

export class ExternalMemoryProviderSlot {
  private activeProvider: ExternalMemoryProvider | null = null

  getActiveProvider(): ExternalMemoryProvider | null {
    return this.activeProvider
  }

  async register(provider: ExternalMemoryProvider): Promise<void> {
    if (this.activeProvider) {
      throw new Error(`External memory provider already active: ${this.activeProvider.id}`)
    }
    this.activeProvider = provider
    await provider.initialize?.()
  }

  async shutdown(): Promise<void> {
    if (!this.activeProvider) return
    await this.activeProvider.shutdown?.()
    this.activeProvider = null
  }
}
