import { ipcMain } from 'electron'
import {
  AIModelConfig,
  getProviderDef,
  normalizeAIConfig,
  normalizeAIWorkspace,
  normalizeProviderId,
  resolveAIConfigCapabilities,
  type AIProviderWorkspace,
} from '../../../shared/ai-providers'
import {
  applyKimiK3AnthropicHeaders,
  applyKimiK3AnthropicRequestContract,
  isKimiK3Config,
} from '../../../shared/ai-providers/kimi-k3'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { createRotatingLogger } from '../../utils/rotating-logger'
import { parseJsonResponse } from '../openai-responses'
import { ExternalServiceStore } from './external-service-store'
import type { ExternalServiceUpdateInput, PublicExternalServiceProfile, ExternalServiceTestResult } from '../../../shared/external-services'
import {
  readAgentAutoNarrationContinuationSetting,
  writeAgentAutoNarrationContinuationSetting,
} from './agent-auto-narration-setting'
import {
  readAgentSessionPrerouteMode,
  writeAgentSessionPrerouteMode,
  type AgentSessionPrerouteMode,
} from './agent-session-preroute-setting'
import { BROWSER_POWER_MODE_SETTING_KEY } from '../../../shared/browser-power'
import { setBrowserPowerGlobalModeReader } from '../browser-engine/browser-power-policy'

interface SettingsIPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

const settingsLogger = createRotatingLogger('ready-settings.log')
function logSettings(msg: string) {
  try { settingsLogger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
}

export function setupSettingsIPC(options?: { onSettingChanged?: (key: string, value: string) => void }): void {
  const repository = new AppSettingsRepository()
  const externalServices = new ExternalServiceStore(repository)
  setBrowserPowerGlobalModeReader(() => repository.getSetting(BROWSER_POWER_MODE_SETTING_KEY) === 'true')

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
  ipcMain.handle('settings:set', (_, { key, value }: { key: string; value: string }): SettingsIPCResponse => {
    try {
      repository.setSetting(key, value)
      options?.onSettingChanged?.(key, value)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Get all settings
  ipcMain.handle('settings:getAll', (): SettingsIPCResponse<Record<string, string>> => {
    try {
      const all = repository.getAllSettings()
      return { success: true, data: all }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:getAgentAutoNarrationContinuation', (): SettingsIPCResponse<boolean> => {
    try {
      return { success: true, data: readAgentAutoNarrationContinuationSetting(repository) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:setAgentAutoNarrationContinuation', (_, payload: { enabled: boolean }): SettingsIPCResponse => {
    try {
      writeAgentAutoNarrationContinuationSetting(repository, payload?.enabled !== false)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // EP4-A5 — agent_auto_routing (off | suggest | auto, default suggest)
  ipcMain.handle('settings:getAgentSessionPrerouteMode', (): SettingsIPCResponse<AgentSessionPrerouteMode> => {
    try {
      return { success: true, data: readAgentSessionPrerouteMode(repository) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:setAgentSessionPrerouteMode', (_, payload: { mode: AgentSessionPrerouteMode }): SettingsIPCResponse => {
    try {
      writeAgentSessionPrerouteMode(repository, payload?.mode)
      return { success: true }
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
  ipcMain.handle('settings:setAIConfig', (_, config: AIModelConfig): SettingsIPCResponse => {
    try {
      repository.setAIConfig(normalizeAIConfig(config))
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

  ipcMain.handle('settings:setAIWorkspace', (_, workspace: AIProviderWorkspace): SettingsIPCResponse => {
    try {
      repository.setAIWorkspace(normalizeAIWorkspace(workspace))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:listExternalServices', (): SettingsIPCResponse<PublicExternalServiceProfile[]> => {
    try {
      return { success: true, data: externalServices.listPublicProfiles() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:updateExternalService', (_, input: ExternalServiceUpdateInput): SettingsIPCResponse<PublicExternalServiceProfile> => {
    try {
      return { success: true, data: externalServices.upsertProfile(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('settings:resetExternalService', (_, payload: { id: string }): SettingsIPCResponse<PublicExternalServiceProfile> => {
    try {
      const id = payload?.id
      if (!id) return { success: false, error: 'Missing service id' }
      return { success: true, data: externalServices.resetProfile(id) }
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
            max_output_tokens: 1,
            reasoning: { effort: configToUse.reasoningEffort || provider?.defaultReasoningEffort || 'high' },
          }),
          signal: AbortSignal.timeout(15000),
        })
        const latencyMs = Date.now() - startTime

        if (responsesResp.ok || responsesResp.status === 400) {
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
}
