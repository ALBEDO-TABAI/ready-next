import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIProviderWorkspace } from '../shared/ai-providers'
import { createCodexUpstreamProfileSnapshot } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { READY_GATEWAY_MAX_CONTROLLED_RETRIES } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-retry'
import {
  assertCodexProfileRouteCurrent,
  createCodexProfileRouteSnapshot,
} from '../main/modules/agent-control/codex-runtime/codex-profile-admission'
import { ActiveAIProfileMutationGuard } from '../main/modules/settings-engine/active-ai-profile-mutation-guard'
import { registerAIWorkspaceAdmissionGuard } from '../main/modules/repositories/app-settings-repository'

function workspace(input?: {
  activeProfileId?: string
  apiKey?: string
  model?: string
}): AIProviderWorkspace {
  return {
    version: 1,
    activeProfileId: input?.activeProfileId ?? 'profile-a',
    profiles: [
      {
        id: 'profile-a',
        category: 'custom',
        name: 'Profile A',
        builtIn: false,
        showInChatSwitcher: true,
        config: {
          provider: 'openai-compatible',
          baseUrl: 'https://provider.example/v1',
          apiKey: input?.apiKey ?? 'secret-a',
          model: input?.model ?? 'model-a',
          agentProtocol: 'openai',
          wireApi: 'chat/completions',
          toolUseMode: 'on',
        },
      },
      {
        id: 'profile-b',
        category: 'custom',
        name: 'Profile B',
        builtIn: false,
        showInChatSwitcher: true,
        config: {
          provider: 'openai-compatible',
          baseUrl: 'https://other.example/v1',
          apiKey: 'secret-b',
          model: 'model-b',
          agentProtocol: 'openai',
          wireApi: 'chat/completions',
          toolUseMode: 'on',
        },
      },
    ],
  }
}

function snapshotDigest(value: AIProviderWorkspace): string {
  const profile = value.profiles.find((candidate) => candidate.id === 'profile-a')!
  return createCodexUpstreamProfileSnapshot({
    profileId: profile.id,
    config: profile.config,
    maxRetries: READY_GATEWAY_MAX_CONTROLLED_RETRIES,
  }).snapshotDigest
}

test('active turn allows credential rotation and active-profile switching but blocks route drift', () => {
  const current = workspace()
  const guard = new ActiveAIProfileMutationGuard(() => [{
    profileId: 'profile-a',
    snapshotDigest: snapshotDigest(current),
  }])

  assert.doesNotThrow(() => guard.assertWorkspaceMutationAllowed(
    current,
    workspace({ apiKey: 'rotated-secret' }),
  ))
  assert.doesNotThrow(() => guard.assertWorkspaceMutationAllowed(
    current,
    workspace({ activeProfileId: 'profile-b' }),
  ))
  assert.throws(() => guard.assertWorkspaceMutationAllowed(
    current,
    workspace({ model: 'model-changed' }),
  ), /ai_profile_in_use_by_active_turn/)
})

test('active turn blocks deleting or destructively reconnecting its exact profile', () => {
  const current = workspace()
  const guard = new ActiveAIProfileMutationGuard(() => [{
    profileId: 'profile-a',
    snapshotDigest: snapshotDigest(current),
  }])
  const withoutActive = {
    ...current,
    activeProfileId: 'profile-b',
    profiles: current.profiles.filter((profile) => profile.id !== 'profile-a'),
  }

  assert.throws(
    () => guard.assertWorkspaceMutationAllowed(current, withoutActive),
    /ai_profile_in_use_by_active_turn/,
  )
  assert.throws(
    () => guard.assertProfileMutationAllowed('profile-a'),
    /ai_profile_in_use_by_active_turn/,
  )
  assert.doesNotThrow(() => guard.assertProfileMutationAllowed('profile-b'))
})

test('atomic ingress route check accepts credential rotation but rejects prepared route drift', () => {
  const preparedWorkspace = workspace()
  const preparedProfile = preparedWorkspace.profiles.find((profile) => profile.id === 'profile-a')!
  const expected = createCodexProfileRouteSnapshot({
    profileId: preparedProfile.id,
    config: preparedProfile.config,
  })

  assert.doesNotThrow(() => assertCodexProfileRouteCurrent({
    settings: { getAIWorkspace: () => workspace({ apiKey: 'rotated-secret' }) },
    expected,
  }))
  assert.doesNotThrow(() => assertCodexProfileRouteCurrent({
    settings: { getAIWorkspace: () => workspace({ activeProfileId: 'profile-b' }) },
    expected,
  }))
  assert.throws(() => assertCodexProfileRouteCurrent({
    settings: { getAIWorkspace: () => workspace({ model: 'model-changed' }) },
    expected,
  }), /codex_upstream_profile_changed_before_admission/)
})

test('atomic ingress route check closes while the OAuth lifecycle is changing', () => {
  const preparedWorkspace = workspace()
  const preparedProfile = preparedWorkspace.profiles.find((profile) => profile.id === 'profile-a')!
  const expected = createCodexProfileRouteSnapshot({
    profileId: preparedProfile.id,
    config: preparedProfile.config,
  })
  let busy = true
  registerAIWorkspaceAdmissionGuard(() => {
    if (busy) throw new Error('codex_chatgpt_oauth_lifecycle_busy')
  })

  assert.throws(() => assertCodexProfileRouteCurrent({
    settings: { getAIWorkspace: () => preparedWorkspace },
    expected,
  }), /codex_chatgpt_oauth_lifecycle_busy/)
  busy = false
  assert.doesNotThrow(() => assertCodexProfileRouteCurrent({
    settings: { getAIWorkspace: () => preparedWorkspace },
    expected,
  }))
})
