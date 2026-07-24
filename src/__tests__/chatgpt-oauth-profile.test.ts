import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDefaultAIWorkspace,
  resolveAIConfigCapabilities,
} from '../shared/ai-providers'
import {
  CHATGPT_OAUTH_BASE_URL,
  CHATGPT_OAUTH_PROFILE_ID,
  isChatGptOAuthConfig,
  isChatGptOAuthConfigContractValid,
  removeChatGptOAuthProfile,
  upsertChatGptOAuthProfile,
} from '../shared/chatgpt-oauth'

const PROXY_API_KEY = 'ready-oauth-proxy-key-12345678901234567890'

test('OAuth upsert preserves the built-in OpenAI API key profile', () => {
  const workspace = createDefaultAIWorkspace()
  const builtInBefore = workspace.profiles.find((profile) => profile.id === 'builtin-openai')

  const next = upsertChatGptOAuthProfile(
    workspace,
    ['gpt-5.6-terra', 'gpt-5.6-sol'],
    PROXY_API_KEY,
  )
  const builtInAfter = next.profiles.find((profile) => profile.id === 'builtin-openai')
  const oauth = next.profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)

  assert.deepEqual(builtInAfter, builtInBefore)
  assert.equal(next.activeProfileId, CHATGPT_OAUTH_PROFILE_ID)
  assert.equal(oauth?.builtIn, false)
  assert.equal(oauth?.category, 'custom')
  assert.equal(oauth?.config.baseUrl, CHATGPT_OAUTH_BASE_URL)
  assert.equal(oauth?.config.apiKey, PROXY_API_KEY)
  assert.equal(oauth?.config.model, 'gpt-5.6-terra')
  assert.deepEqual(oauth?.config.modelIds, ['gpt-5.6-terra', 'gpt-5.6-sol'])
  assert.equal(isChatGptOAuthConfig(oauth?.config), true)
  assert.equal(isChatGptOAuthConfigContractValid(oauth?.config), true)
})

test('OAuth profile rejects a short or placeholder loopback key', () => {
  assert.throws(
    () => upsertChatGptOAuthProfile(
      createDefaultAIWorkspace(),
      ['gpt-5.6-terra'],
      'openai-oauth',
    ),
    /访问口令无效/,
  )
})

test('OAuth upsert is idempotent and preserves a still-available model choice', () => {
  const first = upsertChatGptOAuthProfile(
    createDefaultAIWorkspace(),
    ['gpt-5.6-terra', 'gpt-5.6-sol'],
    PROXY_API_KEY,
  )
  const selected = {
    ...first,
    profiles: first.profiles.map((profile) => (
      profile.id === CHATGPT_OAUTH_PROFILE_ID
        ? { ...profile, config: { ...profile.config, model: 'gpt-5.6-sol' } }
        : profile
    )),
  }
  const next = upsertChatGptOAuthProfile(
    selected,
    ['gpt-5.6-sol', 'gpt-5.6-terra'],
    PROXY_API_KEY,
  )
  const oauthProfiles = next.profiles.filter((profile) => isChatGptOAuthConfig(profile.config))

  assert.equal(oauthProfiles.length, 1)
  assert.equal(oauthProfiles[0]?.config.model, 'gpt-5.6-sol')
})

test('OAuth upsert preserves supported reasoning effort and migrates obsolete values', () => {
  const first = upsertChatGptOAuthProfile(
    createDefaultAIWorkspace(),
    ['gpt-5.6-terra'],
    PROXY_API_KEY,
  )
  const configured = {
    ...first,
    profiles: first.profiles.map((profile) => (
      profile.id === CHATGPT_OAUTH_PROFILE_ID
        ? { ...profile, config: { ...profile.config, reasoningEffort: 'xhigh' as const } }
        : profile
    )),
  }
  const next = upsertChatGptOAuthProfile(
    configured,
    ['gpt-5.6-terra'],
    PROXY_API_KEY,
  )
  const oauth = next.profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)

  assert.equal(oauth?.config.reasoningEffort, 'xhigh')

  const migrated = upsertChatGptOAuthProfile(
    {
      ...next,
      profiles: next.profiles.map((profile) => (
        profile.id === CHATGPT_OAUTH_PROFILE_ID
          ? { ...profile, config: { ...profile.config, reasoningEffort: 'minimal' as const } }
          : profile
      )),
    },
    ['gpt-5.6-terra'],
    PROXY_API_KEY,
  )
  assert.equal(
    migrated.profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)?.config.reasoningEffort,
    'low',
  )
})

test('OAuth config resolves to Responses with native tools and no native video', () => {
  const workspace = upsertChatGptOAuthProfile(
    createDefaultAIWorkspace(),
    ['gpt-5.6-terra'],
    PROXY_API_KEY,
  )
  const oauth = workspace.profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)
  const capabilities = resolveAIConfigCapabilities(oauth?.config)

  assert.equal(capabilities?.agentProtocol, 'openai')
  assert.equal(capabilities?.wireApi, 'responses')
  assert.equal(capabilities?.supportsToolCalls, true)
  assert.equal(capabilities?.supportsNativeToolCalls, true)
  assert.equal(capabilities?.supportsNativeVideo, false)
})

test('disconnect removes only the OAuth profile and restores built-in OpenAI', () => {
  const workspace = upsertChatGptOAuthProfile(
    createDefaultAIWorkspace(),
    ['gpt-5.6-terra'],
    PROXY_API_KEY,
  )
  const next = removeChatGptOAuthProfile(workspace)

  assert.equal(next.activeProfileId, 'builtin-openai')
  assert.equal(next.profiles.some((profile) => isChatGptOAuthConfig(profile.config)), false)
  assert.equal(next.profiles.some((profile) => profile.id === 'builtin-openai'), true)
  assert.equal(next.profiles.length, workspace.profiles.length - 1)
})
