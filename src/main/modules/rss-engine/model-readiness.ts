import { isChatGptOAuthConfig } from '../../../shared/chatgpt-oauth'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { isRSSModelConfigured } from './model-completion'

const settings = new AppSettingsRepository()
// Startup replaces this with the live ChatGPT OAuth lifecycle check.
let providerReady = (config: AIModelConfig): boolean => !isChatGptOAuthConfig(config)

export function setRSSProviderReadiness(check: (config: AIModelConfig) => boolean): void {
  providerReady = check
}

/** The model RSS judgments and translations use, and whether it can answer now. */
export function rssModelConfig(): AIModelConfig | null {
  return settings.getAIConfig()
}

export function hasRSSProcessingModel(): boolean {
  const config = settings.getAIConfig()
  return isRSSModelConfigured(config) && providerReady(config)
}
