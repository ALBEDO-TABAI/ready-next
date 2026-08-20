import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  AIModelConfig,
  getProviderDef,
  normalizeAIConfig,
  normalizeProviderId,
  resolveAIConfigCapabilities,
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
  applyKimiK3AnthropicHeaders,
  applyKimiK3AnthropicRequestContract,
  isKimiK3Config,
} from '../../../shared/ai-providers/kimi-k3'
import {
  AppSettingsRepository,
  registerAIWorkspaceAdmissionGuard,
  registerAIWorkspaceMutationGuard,
} from '../repositories/app-settings-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { parseJsonResponse } from '../openai-responses'
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
        [],
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
              savedModels: existingConfig?.modelIds || (existingConfig?.model ? [existingConfig.model] : []),
            }
          },
          afterReady: (readyStatus) => repository.setAIWorkspace(upsertChatGptOAuthProfile(
            repository.getAIWorkspace(),
            readyStatus.models,
            chatGptOAuth.getProxyApiKey(),
          )),
        },
      )
      logSettings(`[oauth] authorize ready durationMs=${Date.now() - startedAt} models=${status.models.length}`)
      return { success: true, data: status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logSettings(`[oauth] authorize failed durationMs=${Date.now() - startedAt} error=${message}`)
      return { success: false, data: chatGptOAuth.getStatus(), error: message }
    }
  })

  ipcMain.handle('settings:resumeChatGptOAuth', async (): Promise<SettingsIPCResponse<ChatGptOAuthStatus>> => {
    try {
      const workspace = repository.getAIWorkspace()
      const profile = workspace.profiles.find((candidate) => isChatGptOAuthConfig(candidate.config))
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
      const capabilities = resolveAIConfigCapabilities(normalizedConfig)
      const resolvedProviderId = normalizeProviderId(normalizedConfig.provider, normalizedConfig.baseUrl)
      const provider = capabilities?.provider || getProviderDef(resolvedProviderId || normalizedConfig.provider, normalizedConfig.baseUrl)
      if (!provider && resolvedProviderId !== 'openai-compatible') {
        return { success: false, error: `Unknown provider: ${normalizedConfig.provider}` }
      }

      const configToUse = capabilities?.config || normalizedConfig
      const baseUrl = capabilities?.baseUrl || configToUse.baseUrl.replace(/\/+$/, '')
      const startTime = Date.now()
      const useAnthropicCompatForKimiCoding = baseUrl.includes('api.kimi.com/coding')

      if (capabilities?.agentProtocol === 'anthropic') {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        }
        if ((provider?.id === 'anthropic' && !configToUse.agentProtocol) || useAnthropicCompatForKimiCoding) {
          headers['x-api-key'] = configToUse.apiKey
        } else {
          const authHeader = provider?.authHeader || 'Authorization'
          const authPrefix = provider?.authPrefix ?? 'Bearer '
          headers[authHeader] = `${authPrefix}${configToUse.apiKey}`
          if (provider?.extraHeaders) {
            Object.assign(headers, provider.extraHeaders)
          }
        }

        const model = (configToUse.model || '').trim()
        const finalModel = model && model !== '__custom__' && model !== 'custom'
          ? model
          : (useAnthropicCompatForKimiCoding ? 'kimi-for-coding' : 'claude-haiku-3-5-20241022')
        const isKimiK3 = isKimiK3Config(configToUse)
        applyKimiK3AnthropicHeaders(headers, configToUse)
        const requestBody: Record<string, unknown> = {
          model: finalModel,
          max_tokens: isKimiK3 ? 1024 : 1,
          messages: [{ role: 'user', content: 'hi' }],
        }
        applyKimiK3AnthropicRequestContract(requestBody, configToUse)
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(15000),
        })
        const latencyMs = Date.now() - startTime

        if (resp.ok || (!isKimiK3 && resp.status === 400)) {
          return { success: true, data: { latencyMs } }
        }
        if (resp.status === 401 || resp.status === 403) {
          return { success: false, error: 'API Key 无效或无权限' }
        }
        const body = await resp.text().catch(() => '')
        return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      const authHeader = provider?.authHeader || 'Authorization'
      const authPrefix = provider?.authPrefix ?? 'Bearer '
      headers[authHeader] = `${authPrefix}${configToUse.apiKey}`

      if (provider?.extraHeaders) {
        Object.assign(headers, provider.extraHeaders)
      }

      const resolvedWireApi = capabilities?.wireApi || configToUse.wireApi || provider?.wireApi || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions')
      if (resolvedWireApi === 'responses') {
        const model = (configToUse.model || '').trim()
        const finalModel = model && model !== '__custom__' && model !== 'custom'
          ? model
          : 'gpt-5.4'
        const responsesResp = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: finalModel,
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            stream: false,
            max_output_tokens: 16,
            reasoning: { effort: configToUse.reasoningEffort || provider?.defaultReasoningEffort || 'high' },
          }),
          signal: AbortSignal.timeout(15000),
        })
        const latencyMs = Date.now() - startTime

        if (responsesResp.ok || (
          responsesResp.status === 400
          && !isChatGptOAuthConfig(configToUse)
        )) {
          return { success: true, data: { latencyMs } }
        }
        if (responsesResp.status === 401 || responsesResp.status === 403) {
          return { success: false, error: 'API Key 无效或无权限' }
        }
        const body = await responsesResp.text().catch(() => '')
        return { success: false, error: `连接失败 (HTTP ${responsesResp.status}): ${body.slice(0, 200)}` }
      }

      // Try /models endpoint first (works for OpenAI, Moonshot, Gemini shim)
      const modelsUrl = `${baseUrl}/models`
      const resp = await fetch(modelsUrl, {
        headers,
        signal: AbortSignal.timeout(15000),
      })

      if (resp.ok) {
        try {
          const json = await parseJsonResponse(resp, { requestUrl: modelsUrl }) as { data?: Array<{ id?: string } | string> }
          const modelList = json.data
            ?.map(m => typeof m === 'string' ? m : m.id)
            .filter((id): id is string => Boolean(id))
            .slice(0, 20)
          const chatModel = (configToUse.model || '').trim() && configToUse.model !== '__custom__' && configToUse.model !== 'custom'
            ? configToUse.model
            : (modelList?.[0] || provider?.models[0]?.id || 'gpt-4o-mini')
          const chatResp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: chatModel,
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 1,
            }),
            signal: AbortSignal.timeout(15000),
          })
          const chatLatency = Date.now() - startTime

          if (chatResp.ok) {
            return { success: true, data: { latencyMs: chatLatency, modelList } }
          }
          if (chatResp.status === 401 || chatResp.status === 403) {
            return { success: false, error: 'API Key 无效或无权限' }
          }
          const body = await chatResp.text().catch(() => '')
          return { success: false, error: `模型 ${chatModel} 不可用 (HTTP ${chatResp.status}): ${body.slice(0, 200)}` }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: 'API Key 无效或无权限' }
      }

      // Fallback: try a minimal chat completion
      const chatResp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: configToUse.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const chatLatency = Date.now() - startTime

      if (chatResp.ok) {
        return { success: true, data: { latencyMs: chatLatency } }
      }

      if (chatResp.status === 401 || chatResp.status === 403) {
        return { success: false, error: 'API Key 无效或无权限' }
      }

      const body = await chatResp.text().catch(() => '')
      return { success: false, error: `连接失败 (HTTP ${chatResp.status}): ${body.slice(0, 200)}` }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { success: false, error: '连接超时 (15秒)' }
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  return chatGptOAuth
}
