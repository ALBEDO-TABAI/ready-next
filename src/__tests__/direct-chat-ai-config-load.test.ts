import assert from 'node:assert/strict'
import test from 'node:test'

import { readAIConfigDetailed } from '../main/modules/claude-bridge/direct-chat-ai-config'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

function captureMetrics(): { events: AgentMetricEvent[]; restore: () => void } {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  return { events, restore: () => __setMetricSinkForTests(null) }
}

const VALID_CONFIG_JSON = JSON.stringify({
  provider: 'openai',
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-abc',
  model: 'gpt-4o-mini',
})

test('readAIConfigDetailed returns absent when setting is missing', () => {
  const { events, restore } = captureMetrics()
  try {
    for (const value of [null, undefined, '']) {
      const result = readAIConfigDetailed(() => value)
      assert.equal(result.ok, true, `value=${String(value)}`)
      if (result.ok) {
        assert.equal(result.config, null)
        assert.equal(result.reason, 'absent')
      }
    }
    assert.equal(events.length, 0, 'absent path emits no metric')
  } finally {
    restore()
  }
})

test('readAIConfigDetailed returns normalized config when setting is present', () => {
  const { events, restore } = captureMetrics()
  try {
    const result = readAIConfigDetailed(() => VALID_CONFIG_JSON)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.reason, 'present')
      assert.notEqual(result.config, null)
      assert.equal(result.config?.provider, 'openai')
      assert.equal(result.config?.apiKey, 'sk-abc')
    }
    assert.equal(events.length, 0, 'present path emits no metric')
  } finally {
    restore()
  }
})

test('readAIConfigDetailed flags json_corrupt and emits ai_config_corrupt metric', () => {
  const { events, restore } = captureMetrics()
  try {
    const result = readAIConfigDetailed(() => '{not-json"')
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'json_corrupt')
      assert.equal(typeof result.message, 'string')
    }
    const corrupt = events.filter((e) => e.metric === 'ai_config_corrupt')
    assert.equal(corrupt.length, 1)
    assert.equal(typeof corrupt[0].sample, 'string')
    assert.ok((corrupt[0].sample as string).length <= 80)
  } finally {
    restore()
  }
})

test('readAIConfigDetailed flags db_error and emits ai_config_db_error metric', () => {
  const { events, restore } = captureMetrics()
  try {
    const result = readAIConfigDetailed(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, 'db_error')
      assert.match(result.message, /SQLITE_BUSY/)
    }
    const dbErr = events.filter((e) => e.metric === 'ai_config_db_error')
    assert.equal(dbErr.length, 1)
    assert.match(String(dbErr[0].message), /SQLITE_BUSY/)
  } finally {
    restore()
  }
})
