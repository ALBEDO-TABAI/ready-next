/**
 * Agent context source — single helper for "what model is the user currently
 * using?" Read by `SkillHostController` so each skill spawn can inject the
 * active model into spawn-time config files / env vars.
 *
 * Source of truth: `AppSettingsRepository.getAIConfig()` (active workspace
 * profile, persisted in the SQLite settings table). This is the same getter
 * direct-chat.ts / agent-manager.ts / runtime.ts use to start a new agent run,
 * so reading it here guarantees skills spawn with the same provider/model the
 * user just talked to.
 *
 * Constraints:
 *   - No caching: users may switch model mid-session; controller must always
 *     observe the current value.
 *   - Returns a fresh object on each call (no shared refs into Ready settings).
 *   - api_key is plaintext in the settings table today (safeStorage is only
 *     wired for `agent_channels`). Do NOT log it.
 *   - `fallback_chain` is empty `[]` for now: Ready does not track a
 *     multi-model fallback for the primary agent. Skills that want a fallback
 *     must declare one in `host_requirements` (manifest), or rely on the
 *     novacode last-resort default baked into the skill itself.
 */

import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { resolveAIConfigCapabilities, type AIModelConfig } from '../../../shared/ai-providers'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'

export interface AgentContextSourceOptions {
  /**
   * Override the AI config reader. Defaults to a module-scoped
   * `AppSettingsRepository`. Tests inject this to avoid the SQLite dependency.
   */
  readAIConfig?: () => AIModelConfig | null
  /**
   * Optional warning sink (defaults to `console.warn`). Tests can intercept.
   * MUST NOT be passed an api_key; we never log it.
   */
  warn?: (message: string) => void
}

const defaultRepository = new AppSettingsRepository()
const defaultReadAIConfig = (): AIModelConfig | null => defaultRepository.getAIConfig()

/**
 * Provider → wire-protocol mapping. Lives in Ready (not in skill manifests)
 * because it's universal Ready knowledge — every skill that wants to call the
 * user's currently-selected model needs the same answer.
 *
 * Skills reference this via `${agent.api_kind}` in their `host_requirements`.
 *
 * Default for unknown providers: `openai-completions` (the most widely
 * supported request format among OpenAI-compatible endpoints).
 */
const PROVIDER_API_KIND: Record<string, AgentSpawnContext['api_kind']> = {
  moonshot: 'anthropic-messages', // Kimi coding endpoint at api.kimi.com/coding
  anthropic: 'anthropic-messages',
  openai: 'openai-responses', // GPT-5.4 / Codex use /responses
  'novacode-openai': 'openai-responses',
  'openai-compatible': 'openai-completions',
  gemini: 'openai-completions',
  fox: 'openai-completions',
  volcengine: 'openai-completions',
}

function deriveApiKind(provider: string): AgentSpawnContext['api_kind'] {
  return PROVIDER_API_KIND[provider] ?? 'openai-completions'
}

function deriveApiKindFromConfig(
  config: AIModelConfig,
  provider: string,
): AgentSpawnContext['api_kind'] {
  if (config.agentProtocol === 'anthropic') return 'anthropic-messages'
  if (config.agentProtocol === 'openai') {
    if (config.wireApi === 'responses') return 'openai-responses'
    if (config.wireApi === 'chat/completions') return 'openai-completions'
  }
  return deriveApiKind(provider)
}

function isCustomProvider(provider: string): boolean {
  return provider === 'openai-compatible'
}

function isKnownTextOnlyModel(provider: string, model: string): boolean {
  const p = provider.toLowerCase()
  const m = model.toLowerCase()
  if (p === 'moonshot') return true
  if (m.includes('codex')) return true
  if (m.includes('kimi-for-coding')) return true
  if (m.startsWith('moonshot-v1')) return true
  if (m === 'o3-mini') return true
  if (m.startsWith('doubao-')) return true
  if (m.startsWith('seedream-') || m.startsWith('seedance-')) return true
  return false
}

function isKnownVisionModel(provider: string, model: string): boolean {
  const p = provider.toLowerCase()
  const m = model.toLowerCase()
  if (p === 'anthropic' && (m.startsWith('claude-3') || m.startsWith('claude-opus-4') || m.startsWith('claude-sonnet-4'))) return true
  if (p === 'gemini' && m.startsWith('gemini-')) return true
  if ((p === 'openai' || p === 'fox') && (m.startsWith('gpt-4o') || m.startsWith('gpt-4.1') || m.startsWith('gpt-5.4'))) return true
  if (m.includes('glm-5v') || m.includes('glm-4v') || m.includes('qwen-vl') || m.includes('mimo-v2-omni')) return true
  return false
}

function hasExplicitAgentProtocol(config: AIModelConfig): boolean {
  return config.agentProtocol === 'anthropic' || config.agentProtocol === 'openai'
}

function deriveInputModes(
  config: AIModelConfig,
  provider: string,
  model: string,
): AgentSpawnContext['input_modes'] {
  if (config.visionMode === 'on') return ['text', 'image']
  if (config.visionMode === 'off') return ['text']
  if (isKnownTextOnlyModel(provider, model)) return ['text']
  if (isKnownVisionModel(provider, model)) return ['text', 'image']
  const capabilities = resolveAIConfigCapabilities(config)
  if (capabilities?.supportsVision && (!isCustomProvider(provider) || hasExplicitAgentProtocol(config))) {
    return ['text', 'image']
  }
  return ['text']
}

export function buildAgentSpawnContextFromAIConfig(
  config: AIModelConfig,
  options: { baseUrl?: string } = {},
): AgentSpawnContext | null {
  const provider = String(config.provider || '').trim()
  const modelId = String(config.model || '').trim()
  const baseUrl = String(options.baseUrl ?? config.baseUrl ?? '').trim()
  const apiKey = String(config.apiKey || '')

  if (!provider || !modelId) return null

  return {
    provider,
    model_id: modelId,
    base_url: baseUrl,
    api_key: apiKey,
    api_kind: deriveApiKindFromConfig(config, provider),
    fallback_chain: [],
    input_modes: deriveInputModes(config, provider, modelId),
  }
}

/**
 * Returns the agent context that should be injected into skill spawns.
 * Returns `null` (with a logged warning) if no agent is currently configured
 * — e.g. fresh install, settings table empty, or user wiped credentials.
 *
 * Each call returns a fresh object: no shared refs leak into Ready's
 * settings store, so callers may safely mutate / serialize the result.
 */
export async function getCurrentAgentContext(
  options: AgentContextSourceOptions = {},
): Promise<AgentSpawnContext | null> {
  const read = options.readAIConfig ?? defaultReadAIConfig
  const warn = options.warn ?? ((message: string) => { console.warn(`[agent-context-source] ${message}`) })

  let config: AIModelConfig | null = null
  try {
    config = read()
  } catch (error) {
    warn(`failed to read AI config: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  if (!config) {
    warn('no AI config found in settings — skill spawn will run without agent context')
    return null
  }

  const context = buildAgentSpawnContextFromAIConfig(config)
  if (!context) {
    warn('AI config is missing provider or model — skill spawn will run without agent context')
    return null
  }

  // Fresh object literal; readonly array literal; no refs to `config`.
  return context
}
