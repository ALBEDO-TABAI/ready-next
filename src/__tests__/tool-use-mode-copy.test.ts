import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveToolUseModePresentation } from '../renderer/pages/settings/tool-use-mode-copy'
import type { AIModelConfig } from '../shared/ai-providers'

const OPENAI_COMPATIBLE: AIModelConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://compatible.example/v1',
  apiKey: 'test',
  model: 'custom-model',
  toolUseMode: 'auto',
}

test('OpenAI-compatible auto mode shows that tools are currently closed and how to opt in', () => {
  const presentation = resolveToolUseModePresentation(OPENAI_COMPATIBLE)

  assert.equal(presentation.effectiveEnabled, false)
  assert.equal(presentation.autoEnabled, false)
  assert.equal(presentation.autoOptionLabel, '自动（当前=关闭）')
  assert.match(presentation.description, /当前为关闭/)
  assert.match(presentation.description, /function calling/)
  assert.match(presentation.description, /强制开启/)
})

test('built-in provider auto mode reports its actual enabled default', () => {
  const presentation = resolveToolUseModePresentation({
    ...OPENAI_COMPATIBLE,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  })

  assert.equal(presentation.effectiveEnabled, true)
  assert.equal(presentation.autoOptionLabel, '自动（当前=开启）')
  assert.equal(presentation.description, '当前为开启。')
})

test('explicit override keeps current state separate from the auto-mode preview', () => {
  const presentation = resolveToolUseModePresentation({
    ...OPENAI_COMPATIBLE,
    toolUseMode: 'on',
  })

  assert.equal(presentation.effectiveEnabled, true)
  assert.equal(presentation.autoEnabled, false)
  assert.equal(presentation.autoOptionLabel, '自动（切换后=关闭）')
  assert.equal(presentation.description, '当前为开启。')
})
