import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIProviderWorkspace } from '../shared/ai-providers'
import { createCodexProfileRouteSnapshot } from '../main/modules/agent-control/codex-runtime/codex-profile-admission'
import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { ActiveAIProfileMutationGuard } from '../main/modules/settings-engine/active-ai-profile-mutation-guard'
import { createGenericSettingIPCHandler } from '../main/modules/settings-engine/generic-setting-ipc-handler'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database

const workspace: AIProviderWorkspace = {
  version: 1,
  activeProfileId: 'profile-a',
  profiles: [{
    id: 'profile-a',
    category: 'custom',
    name: 'Profile A',
    builtIn: false,
    showInChatSwitcher: true,
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-a',
      model: 'model-a',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
    },
  }],
}

async function withSettingsDatabase(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  work: (db: NativeDb, repository: AppSettingsRepository) => void | Promise<void>,
): Promise<void> {
  if (skipIfSqliteUnavailable(t, 'generic settings write guard')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  const profile = workspace.profiles[0]
  const snapshotDigest = createCodexProfileRouteSnapshot({
    profileId: profile.id,
    config: profile.config,
  }).snapshotDigest
  const guard = new ActiveAIProfileMutationGuard(() => [{
    profileId: profile.id,
    snapshotDigest,
  }])
  const database = {
    getSetting: (key: string) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value as string | undefined,
    setSetting: (key: string, value: string) => {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(key, value)
    },
    getRawDb: () => db,
  }
  const repository = new AppSettingsRepository(
    () => database,
    (current, next) => guard.assertWorkspaceMutationAllowed(current, next),
  )
  try {
    await work(db, repository)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
}

test('generic settings IPC cannot mutate reserved AI workspace rows during active usage', async (t) => {
  if (skipIfSqliteUnavailable(t, 'generic settings write guard outer coverage')) return
  await withSettingsDatabase(t, (db, repository) => {
    const originalValues = {
      ai_provider_workspace: JSON.stringify(workspace),
      ai_model_config: JSON.stringify(workspace.profiles[0].config),
      ai_saved_configs: JSON.stringify({ 'profile-a': workspace.profiles[0].config }),
    }
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(originalValues)) insert.run(key, value)

    const changed: string[] = []
    const handler = createGenericSettingIPCHandler({
      repository,
      onSettingChanged: (key) => changed.push(key),
    })

    for (const key of Object.keys(originalValues)) {
      assert.deepEqual(handler({}, { key, value: 'attacker-write' }), {
        success: false,
        error: 'ai_workspace_setting_requires_dedicated_ipc',
      })
    }

    const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.key, row.value])), originalValues)
    assert.deepEqual(changed, [])
  })
})

test('generic settings IPC still persists ordinary settings and emits change notification', async (t) => {
  await withSettingsDatabase(t, (_db, repository) => {
    const changed: Array<[string, string]> = []
    const handler = createGenericSettingIPCHandler({
      repository,
      onSettingChanged: (key, value) => changed.push([key, value]),
    })

    assert.deepEqual(handler({}, { key: 'cache_quota_bytes', value: '1073741824' }), { success: true })
    assert.equal(repository.getSetting('cache_quota_bytes'), '1073741824')
    assert.deepEqual(changed, [['cache_quota_bytes', '1073741824']])
  })
})
