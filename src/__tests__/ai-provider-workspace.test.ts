import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
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
})
