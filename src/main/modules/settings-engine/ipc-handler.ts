import { randomBytes } from 'node:crypto'
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  AIModelConfig,
  normalizeAIConfig,
  type AIProviderWorkspace,
} from '../../../shared/ai-providers'
import {
  CHATGPT_OAUTH_PROFILE_ID,
  isChatGptOAuthConfig,
  isChatGptOAuthConfigContractValid,
  removeChatGptOAuthProfile,
  type ChatGptOAuthStatus,
  upsertChatGptOAuthProfile,
} from '../../../shared/chatgpt-oauth'
import {
  AppSettingsRepository,
  registerAIWorkspaceAdmissionGuard,
  registerAIWorkspaceMutationGuard,
} from '../repositories/app-settings-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { testCodexProviderConnection } from '../agent-control/codex-runtime/codex-provider-connection-test'
import { ExternalServiceStore } from './external-service-store'
import type { ExternalServiceUpdateInput, PublicExternalServiceProfile, ExternalServiceTestResult } from '../../../shared/external-services'
import { BROWSER_POWER_MODE_SETTING_KEY } from '../../../shared/browser-power'
import { setBrowserPowerGlobalModeReader } from '../browser-engine/browser-power-policy'
import {
  ChatGptOAuthService,
  createChatGptOAuthService,
} from './chatgpt-oauth-service'
import { getDatabase } from '../database'
import { CodexBindingRepository } from '../agent-control/codex-runtime/codex-binding-repository'
import { ActiveAIProfileMutationGuard } from './active-ai-profile-mutation-guard'
import { createGenericSettingIPCHandler } from './generic-setting-ipc-handler'
import { VaultService } from './vault-service'
import { registerVaultIPC } from './vault-ipc'
import {
  disconnectChatGptOAuthWithWorkspaceLifecycle,
  persistAIWorkspaceWithChatGptOAuthLifecycle,
} from './chatgpt-oauth-workspace-mutation'

interface SettingsIPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

const settingsLogger = createRotatingLogger('ready-settings.log')
function logSettings(msg: string) {
  try { settingsLogger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
}

export function setupSettingsIPC(options?: {
  onSettingChanged?: (key: string, value: string) => void
  onModelChanged?: () => void
  chatGptOAuthService?: ChatGptOAuthService
}): ChatGptOAuthService {
  const database = getDatabase()
  const rawDb = database.getRawDb()
  if (!rawDb) throw new Error('Database not available')
  const codexBindings = new CodexBindingRepository(rawDb)
  const profileMutationGuard = new ActiveAIProfileMutationGuard(
    () => codexBindings.readActiveUpstreamProfileUsages(),
  )
  registerAIWorkspaceMutationGuard(
    (current, next) => profileMutationGuard.assertWorkspaceMutationAllowed(current, next),
  )
  const repository = new AppSettingsRepository(() => database)
  registerVaultIPC(ipcMain, new VaultService(repository, {
    home: app.getPath('home'),
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
  }))
  const externalServices = new ExternalServiceStore(repository)
  const chatGptOAuth = options?.chatGptOAuthService || createChatGptOAuthService(
    join(app.getPath('userData'), 'openai-oauth', 'auth.json')
  )
  registerAIWorkspaceAdmissionGuard(() => {
    if (chatGptOAuth.isLifecycleBusy()) {
      throw new Error('codex_chatgpt_oauth_lifecycle_busy')
    }
  })
  setBrowserPowerGlobalModeReader(() => repository.getSetting(BROWSER_POWER_MODE_SETTING_KEY) === 'true')

  const ensureChatGptOAuthReady = async (
    config: AIModelConfig | null | undefined,
    source = 'workspace',
    afterReady?: (status: ChatGptOAuthStatus) => void | Promise<void>,
  ): Promise<void> => {
    if (!isChatGptOAuthConfig(config)) return
    if (!isChatGptOAuthConfigContractValid(config)) {
      throw new Error('ChatGPT OAuth 预设不符合固定安全合同，请断开后重新连接。')
    }
    const wasRunning = chatGptOAuth.getStatus().running
    const startedAt = Date.now()
    if (!wasRunning) {
      logSettings(`[oauth] resume start source=${source} cachedModels=${config?.modelIds?.length || (config?.model ? 1 : 0)}`)
    }
    await chatGptOAuth.ensureReady(
      config?.modelIds || (config?.model ? [config.model] : []),
      config?.apiKey,
      afterReady,
    )
    if (!wasRunning) {
      logSettings(`[oauth] resume ready source=${source} durationMs=${Date.now() - startedAt} models=${chatGptOAuth.getStatus().models.length}`)
    }
    options?.onModelChanged?.()
  }

  const initialAIConfig = repository.getAIConfig()
  if (isChatGptOAuthConfig(initialAIConfig)) {
    void ensureChatGptOAuthReady(initialAIConfig, 'cold-start').catch((error) => {
      logSettings(`[oauth] cold-start failed error=${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Get a single setting by key
  ipcMain.handle('settings:get', (_, key: string): SettingsIPCResponse<string | null> => {
    try {
      const value = repository.getSetting(key)
      return { success: true, data: value ?? null }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Set a setting
  ipcMain.handle('settings:set', createGenericSettingIPCHandler({
    repository,
    onSettingChanged: options?.onSettingChanged,
  }))

  // Get all settings
  ipcMain.handle('settings:getAll', (): SettingsIPCResponse<Record<string, string>> => {
    try {
      const all = repository.getAllSettings()
      return { success: true, data: all }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Get AI model config
  ipcMain.handle('settings:getAIConfig', (): SettingsIPCResponse<AIModelConfig | null> => {
    try {
      const config = repository.getAIConfig()
      logSettings(`[ipc] settings:getAIConfig provider=${config?.provider || 'none'} baseUrl=${config?.baseUrl || 'none'} model=${config?.model || 'none'}`)
      return { success: true, data: config }
    } catch (error) {
      logSettings(`[ipc] settings:getAIConfig failed error=${error instanceof Error ? error.message : String(error)}`)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Save AI model config
  ipcMain.handle('settings:setAIConfig', async (_, config: AIModelConfig): Promise<SettingsIPCResponse> => {
    try {
      const normalized = normalizeAIConfig(config)
      if (isChatGptOAuthConfig(normalized)) {
        throw new Error('ChatGPT OAuth 只能通过独立预设保存。')
      }
      await ensureChatGptOAuthReady(normalized)
      repository.setAIConfig(normalized)
      options?.onModelChanged?.()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:getAIWorkspace', (): SettingsIPCResponse<AIProviderWorkspace> => {
    try {
      const workspace = repository.getAIWorkspace()
      logSettings(`[ipc] settings:getAIWorkspace activeProfileId=${workspace.activeProfileId} profiles=${workspace.profiles.length}`)
      return { success: true, data: workspace }
    } catch (error) {
      logSettings(`[ipc] settings:getAIWorkspace failed error=${error instanceof Error ? error.message : String(error)}`)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:setAIWorkspace', async (_, workspace: AIProviderWorkspace): Promise<SettingsIPCResponse> => {
    try {
      await persistAIWorkspaceWithChatGptOAuthLifecycle({
        requestedWorkspace: workspace,
        repository,
        profileMutationGuard,
        chatGptOAuth,
        ensureOAuthReady: async (scope, config) => {
          const wasRunning = chatGptOAuth.getStatus().running
          const startedAt = Date.now()
          if (!wasRunning) {
            logSettings(`[oauth] resume start source=profile-switch cachedModels=${config.modelIds?.length || (config.model ? 1 : 0)}`)
          }
          await scope.ensureReady(
            config.modelIds || (config.model ? [config.model] : []),
            config.apiKey,
          )
          if (!wasRunning) {
            logSettings(`[oauth] resume ready source=profile-switch durationMs=${Date.now() - startedAt} models=${chatGptOAuth.getStatus().models.length}`)
          }
        },
      })
      options?.onModelChanged?.()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:getChatGptOAuthStatus', (): SettingsIPCResponse<ChatGptOAuthStatus> => {
    return { success: true, data: chatGptOAuth.getStatus() }
  })

  ipcMain.handle('settings:connectChatGptOAuth', async (): Promise<SettingsIPCResponse<ChatGptOAuthStatus>> => {
    const startedAt = Date.now()
    try {
      logSettings('[oauth] authorize start')
      const status = await chatGptOAuth.connect(
        undefined,
        {
          beforeRestart: () => {
            const latest = repository.getAIWorkspace()
            const existingProfile = latest.profiles.find((profile) => isChatGptOAuthConfig(profile.config))
            const existingConfig = isChatGptOAuthConfigContractValid(existingProfile?.config)
              ? existingProfile?.config
              : undefined
            repository.setAIWorkspace(removeChatGptOAuthProfile(latest))
            return {
              existingProxyApiKey: existingConfig?.apiKey,
            }
          },
          afterReady: (readyStatus) => repository.setAIWorkspace(upsertChatGptOAuthProfile(
            repository.getAIWorkspace(),
            readyStatus.models,
            chatGptOAuth.getProxyApiKey(),
          )),
        },
      )
      options?.onModelChanged?.()
      logSettings(`[oauth] authorize ready durationMs=${Date.now() - startedAt} models=${status.models.length}`)
      return { success: true, data: status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logSettings(`[oauth] authorize failed durationMs=${Date.now() - startedAt} error=${message}`)
      return { success: false, data: chatGptOAuth.getStatus(), error: message }
    }
  })

  ipcMain.handle('settings:cancelChatGptOAuth', async (_, operationId: string): Promise<SettingsIPCResponse<ChatGptOAuthStatus>> => {
    try { return { success: true, data: await chatGptOAuth.cancelConnect(operationId) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })

  ipcMain.handle('settings:reopenChatGptOAuth', async (_, operationId: string): Promise<SettingsIPCResponse> => {
    try { await chatGptOAuth.reopenAuthorization(operationId); return { success: true } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })

  ipcMain.handle('settings:resumeChatGptOAuth', async (): Promise<SettingsIPCResponse<ChatGptOAuthStatus>> => {
    try {
      if (chatGptOAuth.getStatus().operation) throw new Error('登录正在进行，请继续当前授权或取消后重试。')
      const workspace = repository.getAIWorkspace()
      const profile = workspace.profiles.find((candidate) => isChatGptOAuthConfig(candidate.config))
      if (!profile && chatGptOAuth.getStatus().connected) {
        const status = await chatGptOAuth.ensureReady([], chatGptOAuth.readBoundProxyApiKey() || randomBytes(32).toString('base64url'),
          readyStatus => repository.setAIWorkspace(upsertChatGptOAuthProfile(repository.getAIWorkspace(), readyStatus.models, chatGptOAuth.getProxyApiKey())))
        return { success: true, data: status }
      }
      if (
        !profile
        || profile.id !== CHATGPT_OAUTH_PROFILE_ID
        || profile.builtIn
        || !isChatGptOAuthConfigContractValid(profile.config)
      ) {
        throw new Error('没有可恢复的 ChatGPT OAuth 预设，请重新授权。')
      }
      await ensureChatGptOAuthReady(
        profile.config,
        'manual-resume',
        () => {
          const latest = repository.getAIWorkspace()
          if (latest.activeProfileId !== profile.id) {
            repository.setAIWorkspace({ ...latest, activeProfileId: profile.id })
          }
        },
      )
      return { success: true, data: chatGptOAuth.getStatus() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logSettings(`[oauth] resume failed error=${message}`)
      return { success: false, data: chatGptOAuth.getStatus(), error: message }
    }
  })

  ipcMain.handle('settings:disconnectChatGptOAuth', async (): Promise<SettingsIPCResponse<ChatGptOAuthStatus>> => {
    try {
      await disconnectChatGptOAuthWithWorkspaceLifecycle({
        repository,
        profileMutationGuard,
        chatGptOAuth,
      })
      options?.onModelChanged?.()
      logSettings('[oauth] disconnected credentialRemoved=true')
      return { success: true, data: chatGptOAuth.getStatus() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logSettings(`[oauth] disconnect failed error=${message}`)
      return { success: false, data: chatGptOAuth.getStatus(), error: message }
    }
  })

  ipcMain.handle('settings:listExternalServices', (): SettingsIPCResponse<PublicExternalServiceProfile[]> => {
    try {
      return { success: true, data: externalServices.listPublicProfiles() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:updateExternalService', async (_, input: ExternalServiceUpdateInput): Promise<SettingsIPCResponse<PublicExternalServiceProfile>> => {
    try {
      return { success: true, data: await externalServices.upsertProfile(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:resetExternalService', async (_, payload: { id: string }): Promise<SettingsIPCResponse<PublicExternalServiceProfile>> => {
    try {
      const id = payload?.id
      if (!id) return { success: false, error: 'Missing service id' }
      return { success: true, data: await externalServices.resetProfile(id) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:testExternalService', async (_, payload: { id: string }): Promise<SettingsIPCResponse<ExternalServiceTestResult>> => {
    try {
      const id = payload?.id
      if (!id) return { success: false, error: 'Missing service id' }
      const result = await externalServices.testProfile(id)
      return result.ok
        ? { success: true, data: result }
        : { success: false, data: result, error: result.message }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:testExternalServiceDraft', async (_, input: ExternalServiceUpdateInput): Promise<SettingsIPCResponse<ExternalServiceTestResult>> => {
    try {
      const result = await externalServices.testProfileDraft(input)
      return result.ok
        ? { success: true, data: result }
        : { success: false, data: result, error: result.message }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Test API connection
  ipcMain.handle('settings:testAIConnection', async (_, config: AIModelConfig): Promise<SettingsIPCResponse<{ latencyMs: number; modelList?: string[] }>> => {
    try {
      const normalizedConfig = normalizeAIConfig(config)
      if (isChatGptOAuthConfig(normalizedConfig) && !isChatGptOAuthConfigContractValid(normalizedConfig)) {
        throw new Error('ChatGPT OAuth 预设不符合固定安全合同，请断开后重新连接。')
      }
      await ensureChatGptOAuthReady(normalizedConfig)
      return { success: true, data: await testCodexProviderConnection(normalizedConfig) }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { success: false, error: '连接超时，请稍后重试' }
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  return chatGptOAuth
}
