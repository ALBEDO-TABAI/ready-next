import type { AIModelConfig } from '../../../../shared/ai-providers'
import {
  CHATGPT_OAUTH_PROFILE_ID,
  isChatGptOAuthConfig,
  isChatGptOAuthConfigContractValid,
} from '../../../../shared/chatgpt-oauth'
import type { ChatGptOAuthService } from '../../settings-engine/chatgpt-oauth-service'

export type CodexProviderReadinessPort = {
  ensureReady(input: { profileId: string; config: AIModelConfig }): Promise<void>
}

class CodexProviderReadinessError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexProviderReadinessError'
  }
}

export function createCodexProviderReadinessPort(
  chatGptOAuth: Pick<ChatGptOAuthService, 'ensureReady' | 'getStatus' | 'isLifecycleBusy'>,
): CodexProviderReadinessPort {
  return {
    async ensureReady({ profileId, config }) {
      if (chatGptOAuth.isLifecycleBusy()) {
        throw new CodexProviderReadinessError('codex_chatgpt_oauth_lifecycle_busy')
      }
      if (!isChatGptOAuthConfig(config)) return
      if (
        profileId !== CHATGPT_OAUTH_PROFILE_ID
        || !isChatGptOAuthConfigContractValid(config)
      ) {
        throw new CodexProviderReadinessError('codex_chatgpt_oauth_configuration_invalid')
      }
      if (!chatGptOAuth.getStatus().connected) {
        throw new CodexProviderReadinessError('codex_chatgpt_oauth_not_connected')
      }
      try {
        const status = await chatGptOAuth.ensureReady(
          config.modelIds || (config.model ? [config.model] : []),
          config.apiKey,
        )
        if (!status.running || status.state !== 'ready') {
          throw new Error('oauth_runtime_not_ready')
        }
      } catch {
        throw new CodexProviderReadinessError('codex_chatgpt_oauth_runtime_unavailable')
      }
    },
  }
}
