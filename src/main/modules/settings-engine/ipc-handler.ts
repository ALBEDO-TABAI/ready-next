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
import { AppSettingsRepository } from '../repositories/app-settings-repository'

interface SettingsIPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export function setupSettingsIPC(): void {
  const repository = new AppSettingsRepository()

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

  // Get AI model config
  ipcMain.handle('settings:getAIConfig', (): SettingsIPCResponse<AIModelConfig | null> => {
    try {
      return { success: true, data: repository.getAIConfig() }
    } catch (error) {
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
      return { success: true, data: repository.getAIWorkspace() }
    } catch (error) {
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
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: finalModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(15000),
        })
        const latencyMs = Date.now() - startTime

        if (resp.ok || resp.status === 400) {
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
      const latencyMs = Date.now() - startTime

      if (resp.ok) {
        try {
          const json = await resp.json() as { data?: Array<{ id: string }> }
          const modelList = json.data?.map(m => m.id).slice(0, 20)
          return { success: true, data: { latencyMs, modelList } }
        } catch {
          return { success: true, data: { latencyMs } }
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
