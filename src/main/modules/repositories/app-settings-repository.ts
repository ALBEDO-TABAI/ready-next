import { type AIModelConfig, normalizeAIConfig } from '../../../shared/ai-providers'
import { getDatabase } from '../database'

export class AppSettingsRepository {
  getSetting(key: string): string | undefined {
    return getDatabase().getSetting(key)
  }

  setSetting(key: string, value: string): void {
    getDatabase().setSetting(key, value)
  }

  getAllSettings(): Record<string, string> {
    return getDatabase().getAllSettings()
  }

  getAIConfig(): AIModelConfig | null {
    try {
      const raw = this.getSetting('ai_model_config')
      if (!raw) return null
      return normalizeAIConfig(JSON.parse(raw) as AIModelConfig)
    } catch {
      return null
    }
  }

  setAIConfig(config: AIModelConfig): void {
    this.setSetting('ai_model_config', JSON.stringify(normalizeAIConfig(config)))
  }
}
