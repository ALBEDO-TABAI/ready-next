import { isDeepStrictEqual } from 'node:util'

import {
  getActiveAIConfig,
  normalizeAIWorkspace,
  type AIModelConfig,
  type AIProviderProfile,
  type AIProviderWorkspace,
} from '../../../shared/ai-providers'
import {
  CHATGPT_OAUTH_PROFILE_ID,
  isChatGptOAuthConfig,
  isChatGptOAuthConfigContractValid,
  removeChatGptOAuthProfile,
} from '../../../shared/chatgpt-oauth'
import type { ActiveAIProfileMutationGuard } from './active-ai-profile-mutation-guard'
import type {
  ChatGptOAuthLifecycleScope,
  ChatGptOAuthService,
} from './chatgpt-oauth-service'

type AIWorkspaceRepository = {
  getAIWorkspace(): AIProviderWorkspace
  setAIWorkspace(workspace: AIProviderWorkspace): void
}

type FixedOAuthProfile = AIProviderProfile

function isFixedOAuthProfile(profile: AIProviderProfile): boolean {
  return profile.id === CHATGPT_OAUTH_PROFILE_ID || isChatGptOAuthConfig(profile.config)
}

function fixedOAuthProfile(workspace: AIProviderWorkspace): FixedOAuthProfile | null {
  return workspace.profiles.find(isFixedOAuthProfile) || null
}

function assertFixedOAuthProfileContract(workspace: AIProviderWorkspace): void {
  const profiles = workspace.profiles.filter(isFixedOAuthProfile)
  if (profiles.length > 1 || profiles.some((profile) => (
    profile.id !== CHATGPT_OAUTH_PROFILE_ID
    || profile.builtIn
    || !isChatGptOAuthConfigContractValid(profile.config)
  ))) {
    throw new Error('ChatGPT OAuth 预设不符合固定安全合同，请断开后重新连接。')
  }
}

function replaceFixedOAuthProfile(
  workspace: AIProviderWorkspace,
  profile: FixedOAuthProfile,
): AIProviderWorkspace {
  const existingIndex = workspace.profiles.findIndex(isFixedOAuthProfile)
  return {
    ...workspace,
    profiles: existingIndex >= 0
      ? workspace.profiles.map((candidate, index) => index === existingIndex ? profile : candidate)
      : [...workspace.profiles, profile],
  }
}

function resolveLatestOAuthProfile(
  observed: AIProviderWorkspace,
  latest: AIProviderWorkspace,
  requested: AIProviderWorkspace,
): AIProviderWorkspace {
  assertFixedOAuthProfileContract(observed)
  assertFixedOAuthProfileContract(latest)
  assertFixedOAuthProfileContract(requested)
  const observedProfile = fixedOAuthProfile(observed)
  const latestProfile = fixedOAuthProfile(latest)
  const requestedProfile = fixedOAuthProfile(requested)

  if (!observedProfile && requestedProfile) {
    throw new Error('chatgpt_oauth_profile_requires_connect')
  }
  if (observedProfile && !requestedProfile) {
    throw new Error('chatgpt_oauth_profile_requires_disconnect')
  }
  if (observedProfile && requestedProfile && !isDeepStrictEqual(observedProfile, requestedProfile)) {
    if (!latestProfile || !isDeepStrictEqual(latestProfile, observedProfile)) {
      throw new Error('chatgpt_oauth_workspace_stale')
    }
    return requested
  }
  if (latestProfile) {
    return replaceFixedOAuthProfile(requested, latestProfile)
  }
  if (requested.activeProfileId === CHATGPT_OAUTH_PROFILE_ID) {
    throw new Error('chatgpt_oauth_workspace_stale')
  }
  return removeChatGptOAuthProfile(requested)
}

export async function persistAIWorkspaceWithChatGptOAuthLifecycle(input: {
  requestedWorkspace: AIProviderWorkspace
  repository: AIWorkspaceRepository
  profileMutationGuard: Pick<ActiveAIProfileMutationGuard, 'assertWorkspaceMutationAllowed'>
  chatGptOAuth: Pick<
    ChatGptOAuthService,
    'isLifecycleBusy' | 'readBoundProxyApiKey' | 'runInLifecycleLane'
  >
  ensureOAuthReady?: (
    scope: ChatGptOAuthLifecycleScope,
    config: AIModelConfig,
  ) => Promise<void>
}): Promise<void> {
  const requested = normalizeAIWorkspace(input.requestedWorkspace)
  assertFixedOAuthProfileContract(requested)
  const observed = input.repository.getAIWorkspace()
  assertFixedOAuthProfileContract(observed)
  const observedHasOAuth = Boolean(fixedOAuthProfile(observed))
  const requestedHasOAuth = Boolean(fixedOAuthProfile(requested))

  if (!observedHasOAuth && !requestedHasOAuth) {
    const latest = input.repository.getAIWorkspace()
    if (!fixedOAuthProfile(latest) && !input.chatGptOAuth.isLifecycleBusy()) {
      input.profileMutationGuard.assertWorkspaceMutationAllowed(latest, requested)
      input.repository.setAIWorkspace(requested)
      return
    }
  }

  await input.chatGptOAuth.runInLifecycleLane(async (scope) => {
    const latest = input.repository.getAIWorkspace()
    const resolved = resolveLatestOAuthProfile(observed, latest, requested)
    const resolvedOAuthProfile = fixedOAuthProfile(resolved)
    const boundProxyApiKey = input.chatGptOAuth.readBoundProxyApiKey()
    if (
      boundProxyApiKey
      && resolvedOAuthProfile
      && String(resolvedOAuthProfile.config.apiKey || '').trim() !== boundProxyApiKey
    ) {
      throw new Error('chatgpt_oauth_proxy_key_requires_reconnect')
    }
    input.profileMutationGuard.assertWorkspaceMutationAllowed(latest, resolved)
    const activeConfig = getActiveAIConfig(resolved)
    if (activeConfig && isChatGptOAuthConfig(activeConfig)) {
      if (input.ensureOAuthReady) {
        await input.ensureOAuthReady(scope, activeConfig)
      } else {
        await scope.ensureReady(
          activeConfig.modelIds || (activeConfig.model ? [activeConfig.model] : []),
          activeConfig.apiKey,
        )
      }
    }
    input.repository.setAIWorkspace(resolved)
  })
}

export async function disconnectChatGptOAuthWithWorkspaceLifecycle(input: {
  repository: AIWorkspaceRepository
  profileMutationGuard: Pick<ActiveAIProfileMutationGuard, 'assertProfileMutationAllowed'>
  chatGptOAuth: Pick<ChatGptOAuthService, 'disconnect'>
}): Promise<void> {
  let detachedWorkspace: AIProviderWorkspace | null = null
  await input.chatGptOAuth.disconnect({
    beforeDisconnect: () => {
      input.profileMutationGuard.assertProfileMutationAllowed(CHATGPT_OAUTH_PROFILE_ID)
      const latest = input.repository.getAIWorkspace()
      assertFixedOAuthProfileContract(latest)
      detachedWorkspace = latest
      input.repository.setAIWorkspace(removeChatGptOAuthProfile(latest))
    },
    restoreAfterFailure: ({ credentialExists }) => {
      if (!detachedWorkspace) return
      if (credentialExists) {
        input.repository.setAIWorkspace(detachedWorkspace)
        return
      }
      input.repository.setAIWorkspace(removeChatGptOAuthProfile(input.repository.getAIWorkspace()))
    },
  })
}
