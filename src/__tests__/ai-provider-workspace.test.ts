import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyProfileActiveModel,
  createCustomAIProviderProfile,
  createDefaultAIWorkspace,
  deriveLegacyAISettingsPayload,
  getActiveAIConfig,
  getActiveAIProfile,
  listChatSwitcherProfiles,
  migrateLegacyAISettingsToWorkspace,
  normalizeAIConfig,
  normalizeAIWorkspace,
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderWorkspace,
} from '../shared/ai-providers'

describe('AI provider workspace', () => {
  it('migrates legacy configs into builtin and custom profiles while preserving the active preset', () => {
    const legacyCurrent: AIModelConfig = {
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-kimi',
      model: 'kimi-for-coding',
      displayName: 'Kimi 代码主力',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
    }

    const workspace = migrateLegacyAISettingsToWorkspace({
      aiModelConfig: legacyCurrent,
      aiSavedConfigs: {
        openai: {
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-openai',
          model: 'gpt-5.4',
          displayName: 'OpenAI 主力',
        },
        anthropic: {
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant',
          model: 'claude-sonnet-4-20250514',
          displayName: 'Claude',
        },
        fox: {
          provider: 'fox',
          baseUrl: 'https://code.newcli.com/codex/v1',
          apiKey: 'sk-fox',
          model: 'gpt-5.4',
          displayName: 'FoxCode',
        },
      },
    })

    assert.equal(workspace.version, 1)
    assert.equal(getActiveAIConfig(workspace)?.provider, 'moonshot')
    assert.equal(getActiveAIProfile(workspace)?.category, 'custom')
    assert.equal(getActiveAIProfile(workspace)?.showInChatSwitcher, true)

    const builtinIds = workspace.profiles
      .filter((profile) => profile.builtIn)
      .map((profile) => profile.category)
      .sort()
    assert.deepEqual(builtinIds, ['anthropic', 'gemini', 'openai'])

    const customProfiles = workspace.profiles.filter((profile) => profile.category === 'custom')
    assert.equal(customProfiles.length, 2)
    assert.equal(customProfiles.find((profile) => profile.config.provider === 'moonshot')?.showInChatSwitcher, true)
    assert.equal(customProfiles.find((profile) => profile.config.provider === 'fox')?.showInChatSwitcher, false)
  })

  it('surfaces the active hidden preset separately from the normal chat switcher list', () => {
    const workspace = migrateLegacyAISettingsToWorkspace({
      aiModelConfig: {
        provider: 'openai-compatible',
        baseUrl: 'https://example.com/v1',
        apiKey: 'sk-custom',
        model: 'custom-model',
        displayName: '自建服务',
      },
      aiSavedConfigs: {
        openai: {
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-openai',
          model: 'gpt-5.4',
          displayName: 'OpenAI',
        },
      },
    })

    const activeId = workspace.activeProfileId
    const hiddenWorkspace = {
      ...workspace,
      profiles: workspace.profiles.map((profile) => (
        profile.id === activeId
          ? { ...profile, showInChatSwitcher: false }
          : profile
      )),
    }

    const groups = listChatSwitcherProfiles(hiddenWorkspace)

    assert.equal(groups.currentHiddenProfile?.id, activeId)
    assert.equal(groups.visibleProfiles.some((profile) => profile.id === activeId), false)
    assert.equal(groups.visibleProfiles.some((profile) => profile.category === 'openai'), true)
  })

  it('keeps multiple model ids on a preset while preserving the primary model across legacy compatibility export', () => {
    const kimiProfile = createCustomAIProviderProfile({
      provider: 'moonshot',
      baseUrl: 'https://api.kimi.com/coding/',
      apiKey: 'sk-kimi',
      model: 'k2.6-code-preview',
      modelIds: ['kimi-for-coding', 'k2.6-code-preview', 'kimi-for-coding'],
      agentProtocol: 'anthropic',
      displayName: 'Kimi 代码主力',
    }, {
      id: 'custom-kimi',
      name: 'Kimi 代码主力',
    })

    const workspace = normalizeAIWorkspace({
      ...createDefaultAIWorkspace(),
      activeProfileId: kimiProfile.id,
      profiles: [
        ...createDefaultAIWorkspace().profiles.filter((profile) => profile.id !== 'custom-default-moonshot'),
        kimiProfile,
      ],
    })

    const legacy = deriveLegacyAISettingsPayload(workspace)

    assert.equal(legacy.aiModelConfig?.provider, 'moonshot')
    assert.equal(legacy.aiModelConfig?.apiKey, 'sk-kimi')
    assert.equal(legacy.aiModelConfig?.model, 'k2.6-code-preview')
    assert.deepEqual(legacy.aiModelConfig?.modelIds, ['k2.6-code-preview', 'kimi-for-coding'])
    assert.equal(legacy.aiModelConfig?.agentProtocol, 'anthropic')
    assert.equal(legacy.aiSavedConfigs?.moonshot?.model, 'k2.6-code-preview')
  })

  it('treats api.kimi.com/coding presets as anthropic-compatible by default', () => {
    const capabilities = resolveAIConfigCapabilities({
      provider: 'moonshot',
      baseUrl: 'https://api.kimi.com/coding/',
      apiKey: 'sk-kimi',
      model: 'k2.6-code-preview',
    })

    assert.equal(capabilities?.agentProtocol, 'anthropic')
  })

  it('normalizes model id lists by keeping the primary model first and removing duplicates', () => {
    const config = normalizeAIConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-5.4',
      modelIds: ['gpt-4o', 'gpt-5.4', 'gpt-4o', ''],
    })

    assert.deepEqual(config.modelIds, ['gpt-5.4', 'gpt-4o'])
  })

  it('normalizes DeepSeek endpoints away from generic placeholder models', () => {
    const config = normalizeAIConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'newcli-codex',
      modelIds: ['newcli-codex'],
    } as unknown as AIModelConfig)

    assert.equal(config.provider, 'openai-compatible')
    assert.equal(config.model, 'deepseek-v4-flash')
    assert.deepEqual(config.modelIds, ['deepseek-v4-flash', 'deepseek-v4-pro'])

    const capabilities = resolveAIConfigCapabilities(config)
    assert.equal(capabilities?.agentProtocol, 'openai')
    assert.equal(capabilities?.wireApi, 'chat/completions')
  })

  it('keeps explicit DeepSeek model choices', () => {
    const config = normalizeAIConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-v4-pro',
      modelIds: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    })

    assert.equal(config.model, 'deepseek-v4-pro')
    assert.deepEqual(config.modelIds, ['deepseek-v4-pro', 'deepseek-v4-flash'])
  })

  it('preserves context window overrides through workspace normalization and legacy export', () => {
    const customProfile = createCustomAIProviderProfile({
      provider: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'long-context-model',
      contextWindowOverride: 1_000_000,
    }, {
      id: 'custom-long-context',
      name: 'Long Context',
    })

    const workspace = normalizeAIWorkspace({
      ...createDefaultAIWorkspace(),
      activeProfileId: customProfile.id,
      profiles: [
        ...createDefaultAIWorkspace().profiles,
        customProfile,
      ],
    })
    const activeConfig = getActiveAIConfig(workspace)
    const legacy = deriveLegacyAISettingsPayload(workspace)

    assert.equal(activeConfig?.contextWindowOverride, 1_000_000)
    assert.equal(legacy.aiModelConfig?.contextWindowOverride, 1_000_000)
    assert.equal(legacy.aiSavedConfigs?.['openai-compatible']?.contextWindowOverride, 1_000_000)
  })
})

describe('applyProfileActiveModel', () => {
  const buildMimoWorkspace = (): AIProviderWorkspace => {
    const mimoProfile = createCustomAIProviderProfile({
      provider: 'openai-compatible',
      baseUrl: 'https://token-plan-sgp.xiaomimo.com/v1',
      apiKey: 'sk-mimo',
      model: 'mimo-v2.5',
      modelIds: ['mimo-v2.5', 'mimo-v2.5-pro'],
      displayName: 'mimo',
    }, {
      id: 'custom-mimo',
      name: 'mimo',
    })
    const defaults = createDefaultAIWorkspace()
    return normalizeAIWorkspace({
      ...defaults,
      activeProfileId: 'builtin-openai',
      profiles: [...defaults.profiles, mimoProfile],
    })
  }

  it('switches profile.config.model to a valid modelId and activates the profile', () => {
    const workspace = buildMimoWorkspace()
    const next = applyProfileActiveModel(workspace, 'custom-mimo', 'mimo-v2.5-pro')

    assert.equal(next.activeProfileId, 'custom-mimo')
    const mimo = next.profiles.find((p) => p.id === 'custom-mimo')
    assert.equal(mimo?.config.model, 'mimo-v2.5-pro')

    const openai = next.profiles.find((p) => p.id === 'builtin-openai')
    const openaiBefore = workspace.profiles.find((p) => p.id === 'builtin-openai')
    assert.equal(openai?.config.model, openaiBefore?.config.model)
  })

  it('returns a no-op workspace when the modelId is not in the profile modelIds list', () => {
    const workspace = buildMimoWorkspace()
    const next = applyProfileActiveModel(workspace, 'custom-mimo', 'gpt-4o')

    assert.equal(next.activeProfileId, workspace.activeProfileId)
    const mimoBefore = workspace.profiles.find((p) => p.id === 'custom-mimo')
    const mimoAfter = next.profiles.find((p) => p.id === 'custom-mimo')
    assert.equal(mimoAfter?.config.model, mimoBefore?.config.model)
    assert.deepEqual(mimoAfter?.config.modelIds, mimoBefore?.config.modelIds)
  })

  it('normalizes modelIds after switching so the new primary is still in the deduped list', () => {
    const workspace = buildMimoWorkspace()
    const next = applyProfileActiveModel(workspace, 'custom-mimo', 'mimo-v2.5-pro')

    const mimo = next.profiles.find((p) => p.id === 'custom-mimo')
    assert.equal(mimo?.config.model, 'mimo-v2.5-pro')
    assert.deepEqual(mimo?.config.modelIds, ['mimo-v2.5-pro', 'mimo-v2.5'])
  })

  it('is a no-op when the profileId is unknown', () => {
    const workspace = buildMimoWorkspace()
    const next = applyProfileActiveModel(workspace, 'nonexistent-id', 'mimo-v2.5-pro')

    assert.equal(next.activeProfileId, workspace.activeProfileId)
    assert.equal(next.profiles.length, workspace.profiles.length)
  })
})
