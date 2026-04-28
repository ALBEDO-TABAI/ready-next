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
import type { AIModelConfig } from '../../../shared/ai-providers'
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
    api_kind: deriveApiKind(provider),
    fallback_chain: [],
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
