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
  const repository = new AppSettingsRepository(() => ({ settings: database, getRawDb: database.getRawDb }))

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

test('AI workspace mutation guard runs inside the write transaction and rolls back rejection', () => {
  const current = createDefaultAIWorkspace()
  const values = new Map<string, string>([
    ['ai_provider_workspace', JSON.stringify(current)],
  ])
  let inTransaction = false
  let snapshot: Map<string, string> | null = null
  const database = {
    getSetting: (key: string) => values.get(key),
    setSetting: (key: string, value: string) => values.set(key, value),
    getRawDb: () => ({
      exec: (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE') {
          assert.equal(inTransaction, false)
          inTransaction = true
          snapshot = new Map(values)
          return
        }
        if (sql === 'ROLLBACK') {
          assert.equal(inTransaction, true)
          values.clear()
          for (const [key, value] of snapshot ?? []) values.set(key, value)
          snapshot = null
          inTransaction = false
          return
        }
        if (sql === 'COMMIT') {
          assert.equal(inTransaction, true)
          snapshot = null
          inTransaction = false
        }
      },
    }),
  }
  const repository = new AppSettingsRepository(
    () => ({ settings: database, getRawDb: database.getRawDb }),
    () => {
      assert.equal(inTransaction, true)
      throw new Error('ai_profile_in_use_by_active_turn')
    },
  )

  assert.throws(
    () => repository.setAIWorkspace({ ...current, activeProfileId: 'builtin-openai' }),
    /ai_profile_in_use_by_active_turn/,
  )
  assert.equal(inTransaction, false)
  assert.equal(values.get('ai_provider_workspace'), JSON.stringify(current))
})
