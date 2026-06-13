import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { AppSettingsRepository } from '../repositories/app-settings-repository'

interface AISeedFile {
  ai_model_config?: unknown
  ai_saved_configs?: unknown
  ai_provider_workspace?: unknown
  external_service_profiles_v1?: unknown
}

const EXTERNAL_SERVICE_SETTINGS_KEY = 'external_service_profiles_v1'

function resolveSeedPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'ai-settings.seed.json')
  }
  return join(app.getAppPath(), 'build', 'runtime-seeds', 'ai-settings.seed.json')
}

export function applyBundledAISettingsSeed(): void {
  const repository = new AppSettingsRepository()

  const backfillWorkspaceIfNeeded = (): void => {
    if (!repository.getSetting('ai_provider_workspace') && (
      repository.getSetting('ai_model_config') || repository.getSetting('ai_saved_configs')
    )) {
      repository.getAIWorkspace()
    }
  }

  backfillWorkspaceIfNeeded()

  const hasAISettings = Boolean(
    repository.getSetting('ai_provider_workspace')
    || repository.getSetting('ai_model_config')
    || repository.getSetting('ai_saved_configs')
  )
  const hasExternalServiceProfiles = Boolean(repository.getSetting(EXTERNAL_SERVICE_SETTINGS_KEY))

  if (hasAISettings && hasExternalServiceProfiles) {
    return
  }

  const seedPath = resolveSeedPath()
  if (!existsSync(seedPath)) return

  try {
    const raw = readFileSync(seedPath, 'utf8')
    const parsed = JSON.parse(raw) as AISeedFile

    if (!hasAISettings && parsed.ai_model_config) {
      repository.setSetting('ai_model_config', JSON.stringify(parsed.ai_model_config))
    }
    if (!hasAISettings && parsed.ai_provider_workspace) {
      repository.setSetting('ai_provider_workspace', JSON.stringify(parsed.ai_provider_workspace))
    }
    if (!hasAISettings && parsed.ai_saved_configs) {
      repository.setSetting('ai_saved_configs', JSON.stringify(parsed.ai_saved_configs))
    }
    if (!hasExternalServiceProfiles && parsed.external_service_profiles_v1) {
      repository.setSetting(EXTERNAL_SERVICE_SETTINGS_KEY, JSON.stringify(parsed.external_service_profiles_v1))
    }
  } catch (error) {
    console.warn('[settings] Failed to apply bundled AI seed:', error)
  }

  backfillWorkspaceIfNeeded()
}
