import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { AppSettingsRepository } from '../repositories/app-settings-repository'

interface AISeedFile {
  ai_model_config?: unknown
  ai_saved_configs?: unknown
}

function resolveSeedPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'ai-settings.seed.json')
  }
  return join(app.getAppPath(), 'build', 'runtime-seeds', 'ai-settings.seed.json')
}

export function applyBundledAISettingsSeed(): void {
  const repository = new AppSettingsRepository()
  if (repository.getSetting('ai_model_config')) return

  const seedPath = resolveSeedPath()
  if (!existsSync(seedPath)) return

  try {
    const raw = readFileSync(seedPath, 'utf8')
    const parsed = JSON.parse(raw) as AISeedFile

    if (parsed.ai_model_config) {
      repository.setSetting('ai_model_config', JSON.stringify(parsed.ai_model_config))
    }
    if (parsed.ai_saved_configs) {
      repository.setSetting('ai_saved_configs', JSON.stringify(parsed.ai_saved_configs))
    }
  } catch (error) {
    console.warn('[settings] Failed to apply bundled AI seed:', error)
  }
}
