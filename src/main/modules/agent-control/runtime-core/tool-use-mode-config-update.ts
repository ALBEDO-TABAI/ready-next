import {
  normalizeAIConfig,
  type AICapabilityMode,
  type AIModelConfig
} from '../../../../shared/ai-providers'

export interface AIConfigFingerprint {
  activeProfileId: string | null
  provider: AIModelConfig['provider']
  baseUrl: string
  model: string
}

export interface ActiveToolUseModeUpdateRequest {
  mode: 'on'
  expectedFingerprint: AIConfigFingerprint
}

export type ActiveToolUseModeUpdateResult =
  | {
      applied: true
      previousMode: AICapabilityMode
      alreadyEnabled: boolean
    }
  | {
      applied: false
      reason: 'config_missing' | 'config_changed'
    }

export interface ActiveAIConfigRepository {
  getAIConfig(): AIModelConfig | null
  getActiveAIProfileId?(): string | null
  setAIConfig(config: AIModelConfig): void
}

export function fingerprintAIConfig(
  config: AIModelConfig,
  activeProfileId: string | null = null,
): AIConfigFingerprint {
  const normalized = normalizeAIConfig(config)
  return {
    activeProfileId,
    provider: normalized.provider,
    baseUrl: normalized.baseUrl,
    model: normalized.model
  }
}

function fingerprintsMatch(a: AIConfigFingerprint, b: AIConfigFingerprint): boolean {
  return a.activeProfileId === b.activeProfileId
    && a.provider === b.provider
    && a.baseUrl === b.baseUrl
    && a.model === b.model
}

export function updateActiveToolUseMode(
  repository: ActiveAIConfigRepository,
  request: ActiveToolUseModeUpdateRequest
): ActiveToolUseModeUpdateResult {
  const current = repository.getAIConfig()
  if (!current) return { applied: false, reason: 'config_missing' }
  const normalized = normalizeAIConfig(current)
  const activeProfileId = repository.getActiveAIProfileId?.() ?? null
  if (!fingerprintsMatch(
    fingerprintAIConfig(normalized, activeProfileId),
    request.expectedFingerprint,
  )) {
    return { applied: false, reason: 'config_changed' }
  }
  const previousMode = normalized.toolUseMode || 'auto'
  if (previousMode !== request.mode) {
    repository.setAIConfig({ ...current, toolUseMode: request.mode })
  }
  return {
    applied: true,
    previousMode,
    alreadyEnabled: previousMode === request.mode
  }
}
