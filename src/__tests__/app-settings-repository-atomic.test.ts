import assert from 'node:assert/strict'
import test from 'node:test'

import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { createDefaultAIWorkspace } from '../shared/ai-providers'

test('AI workspace persistence rolls back every settings key when one write fails', () => {
  const values = new Map<string, string>([
    ['ai_provider_workspace', 'old-workspace'],
    ['ai_model_config', 'old-config'],
    ['ai_saved_configs', 'old-saved-configs'],
  ])
  let snapshot: Map<string, string> | null = null
  const database = {
    getSetting: (key: string) => values.get(key),
    setSetting: (key: string, value: string) => {
      if (key === 'ai_model_config') throw new Error('simulated settings write failure')
      values.set(key, value)
    },
    getRawDb: () => ({
      exec: (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE') {
          snapshot = new Map(values)
          return
        }
        if (sql === 'ROLLBACK' && snapshot) {
          values.clear()
          for (const [key, value] of snapshot) values.set(key, value)
          snapshot = null
          return
        }
        if (sql === 'COMMIT') snapshot = null
      },
    }),
  }
  const repository = new AppSettingsRepository(() => database)

  assert.throws(
    () => repository.setAIWorkspace(createDefaultAIWorkspace()),
    /simulated settings write failure/,
  )
  assert.deepEqual(Object.fromEntries(values), {
    ai_provider_workspace: 'old-workspace',
    ai_model_config: 'old-config',
    ai_saved_configs: 'old-saved-configs',
  })
})
