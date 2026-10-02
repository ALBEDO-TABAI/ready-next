import {
  assertAIWorkspaceThinkingModesValid,
  assertThinkingModeConfigValid,
  createCustomAIProviderProfile,
  createDefaultAIWorkspace,
  deriveLegacyAISettingsPayload,
  getActiveAIConfig,
  normalizeAIConfig,
  normalizeAIWorkspace,
  type AIModelConfig,
  type AIProviderWorkspace,
  migrateLegacyAISettingsToWorkspace,
} from '../../../shared/ai-providers'
import { getDatabase } from '../database'

interface SettingsDatabaseLike {
  settings: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void }
  getRawDb(): { exec(sql: string): void } | null
}

type AIWorkspaceMutationGuard = (
  current: AIProviderWorkspace,
  next: AIProviderWorkspace,
) => void

let registeredAIWorkspaceMutationGuard: AIWorkspaceMutationGuard | null = null
let registeredAIWorkspaceAdmissionGuard: (() => void) | null = null

export function registerAIWorkspaceMutationGuard(guard: AIWorkspaceMutationGuard): void {
  if (registeredAIWorkspaceMutationGuard && registeredAIWorkspaceMutationGuard !== guard) {
    throw new Error('ai_workspace_mutation_guard_already_registered')
  }
  registeredAIWorkspaceMutationGuard = guard
}

export function registerAIWorkspaceAdmissionGuard(guard: () => void): void {
  if (registeredAIWorkspaceAdmissionGuard && registeredAIWorkspaceAdmissionGuard !== guard) {
    throw new Error('ai_workspace_admission_guard_already_registered')
  }
  registeredAIWorkspaceAdmissionGuard = guard
}

export function assertAIWorkspaceAdmissionAllowed(): void {
  registeredAIWorkspaceAdmissionGuard?.()
}

export class AppSettingsRepository {
  constructor(
    private readonly getSettingsDatabase: () => SettingsDatabaseLike = getDatabase,
    private readonly assertAIWorkspaceMutationAllowed?: AIWorkspaceMutationGuard,
  ) {}

  getSetting(key: string): string | undefined {
    return this.getSettingsDatabase().settings.getSetting(key)
  }

  setSetting(key: string, value: string): void {
    this.getSettingsDatabase().settings.setSetting(key, value)
  }

  getAllSettings(): Record<string, string> {
    return getDatabase().settings.getAllSettings()
  }

  private parseJSONSetting<T>(key: string): T | null {
    try {
      const raw = this.getSetting(key)
      if (!raw) return null
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  getAIWorkspace(): AIProviderWorkspace {
    const rawWorkspace = this.parseJSONSetting<AIProviderWorkspace>('ai_provider_workspace')
    if (rawWorkspace) {
      return normalizeAIWorkspace(rawWorkspace)
    }

    const migrated = migrateLegacyAISettingsToWorkspace({
      aiModelConfig: this.parseJSONSetting<AIModelConfig>('ai_model_config'),
      aiSavedConfigs: this.parseJSONSetting<Record<string, AIModelConfig>>('ai_saved_configs'),
    })

    if (this.getSetting('ai_model_config') || this.getSetting('ai_saved_configs')) {
      const normalized = normalizeAIWorkspace(migrated)
      this.persistAIWorkspace(normalized, normalized)
      return migrated
    }

    return createDefaultAIWorkspace()
  }

  getAIConfig(): AIModelConfig | null {
    return getActiveAIConfig(this.getAIWorkspace())
  }

  getActiveAIProfileId(): string | null {
    return this.getAIWorkspace().activeProfileId || null
  }

  setAIConfig(config: AIModelConfig): void {
    const normalizedConfig = normalizeAIConfig(config)
    assertThinkingModeConfigValid(normalizedConfig)
    const workspace = this.getAIWorkspace()
    const nextWorkspace = normalizeAIWorkspace({
      ...workspace,
      profiles: workspace.profiles.map((profile) => {
        const isBuiltinTarget = (
          (normalizedConfig.provider === 'openai' && profile.id === 'builtin-openai')
          || (normalizedConfig.provider === 'anthropic' && profile.id === 'builtin-anthropic')
          || (normalizedConfig.provider === 'gemini' && profile.id === 'builtin-gemini')
        )

        if (isBuiltinTarget) {
          const nextName = String(normalizedConfig.displayName || '').trim() || profile.name
          return {
            ...profile,
            name: nextName,
            config: {
              ...profile.config,
              ...normalizedConfig,
              displayName: nextName,
            },
          }
        }

        if (profile.id === workspace.activeProfileId && !profile.builtIn) {
          const nextName = String(normalizedConfig.displayName || '').trim() || profile.name
          return {
            ...profile,
            name: nextName,
            config: {
              ...profile.config,
              ...normalizedConfig,
              displayName: nextName,
            },
          }
        }

        return profile
      }),
      activeProfileId:
        normalizedConfig.provider === 'openai'
          ? 'builtin-openai'
          : normalizedConfig.provider === 'anthropic'
            ? 'builtin-anthropic'
            : normalizedConfig.provider === 'gemini'
              ? 'builtin-gemini'
              : workspace.activeProfileId,
    })

    const activeProfile = nextWorkspace.profiles.find((profile) => profile.id === nextWorkspace.activeProfileId)
    if (activeProfile && !activeProfile.builtIn) {
      this.setAIWorkspace(nextWorkspace)
      return
    }

    if (normalizedConfig.provider !== 'openai' && normalizedConfig.provider !== 'anthropic' && normalizedConfig.provider !== 'gemini') {
      const customProfile = createCustomAIProviderProfile(normalizedConfig, {
        name: normalizedConfig.displayName,
      })
      this.setAIWorkspace({
        ...workspace,
        activeProfileId: customProfile.id,
        profiles: [...workspace.profiles.filter((profile) => profile.id !== customProfile.id), customProfile],
      })
      return
    }

    this.setAIWorkspace(nextWorkspace)
  }

  setAIWorkspace(workspace: AIProviderWorkspace): void {
    const normalizedWorkspace = normalizeAIWorkspace(workspace)
    assertAIWorkspaceThinkingModesValid(normalizedWorkspace)
    this.persistAIWorkspace(normalizedWorkspace, this.getAIWorkspace())
  }

  private persistAIWorkspace(
    normalizedWorkspace: AIProviderWorkspace,
    currentWorkspace: AIProviderWorkspace,
  ): void {
    const legacyPayload = deriveLegacyAISettingsPayload(normalizedWorkspace)
    const activeConfig = legacyPayload.aiModelConfig || getActiveAIConfig(normalizedWorkspace)
    const database = this.getSettingsDatabase()
    const rawDb = database.getRawDb()
    if (!rawDb) throw new Error('Database not available')

    rawDb.exec('BEGIN IMMEDIATE')
    try {
      const mutationGuard = this.assertAIWorkspaceMutationAllowed ?? registeredAIWorkspaceMutationGuard
      mutationGuard?.(currentWorkspace, normalizedWorkspace)
      database.settings.setSetting('ai_provider_workspace', JSON.stringify(normalizedWorkspace))
      if (activeConfig) {
        database.settings.setSetting('ai_model_config', JSON.stringify(activeConfig))
      }
      if (legacyPayload.aiSavedConfigs) {
        database.settings.setSetting('ai_saved_configs', JSON.stringify(legacyPayload.aiSavedConfigs))
      }
      rawDb.exec('COMMIT')
    } catch (error) {
      try {
        rawDb.exec('ROLLBACK')
      } catch {
        // silent-catch: preserve the original settings write failure.
      }
      throw error
    }
  }
}
