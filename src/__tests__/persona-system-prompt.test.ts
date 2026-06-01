import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultSystemPrompt } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { composePersonaSystemPrompt } from '../main/modules/agent-control/runtime-core/persona-system-prompt'

test('composePersonaSystemPrompt uses the selected agent personality, tone, and default-user profile', async () => {
  const result = await composePersonaSystemPrompt(
    'copywriter',
    {
      getPersonality: async (agentName: string) => ({
        id: `persona-${agentName}`,
        agentName,
        personalityText: `人格正文：${agentName}`,
        tone: '温和直接',
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    {
      getProfile: async (userId: string) => ({
        id: userId,
        name: '白',
        preferredLanguage: 'zh-CN',
        communicationStyle: '短句，先结论',
        preferencesJson: { longTermPreferences: ['保留证据', '少说空话'] },
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    defaultSystemPrompt,
  )

  assert.match(result, /人格正文：copywriter/)
  assert.match(result, /语气：温和直接/)
  assert.match(result, /用户档案（关于当前用户）/)
  assert.match(result, /昵称：白/)
  assert.match(result, /语言：zh-CN/)
  assert.match(result, /回复风格：短句，先结论/)
  assert.match(result, /长期偏好：保留证据；少说空话/)
})

test('composePersonaSystemPrompt falls back when a persona is missing and omits empty profile fields', async () => {
  const result = await composePersonaSystemPrompt(
    'new-agent',
    {
      getPersonality: async () => null,
    },
    {
      getProfile: async () => ({
        id: 'default-user',
        preferredLanguage: 'zh',
        preferencesJson: { longTermPreferences: '' },
        createdAt: 1,
        updatedAt: 1,
      }),
    },
    defaultSystemPrompt,
  )

  assert.match(result, /你是 Ready 应用中的 AI 助手/)
  assert.match(result, /用户档案（关于当前用户）/)
  assert.match(result, /语言：zh/)
  assert.doesNotMatch(result, /昵称：/)
  assert.doesNotMatch(result, /回复风格：/)
  assert.doesNotMatch(result, /长期偏好：/)
})
