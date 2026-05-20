import test from 'node:test'
import assert from 'node:assert/strict'
import { ExternalServiceStore } from '../main/modules/settings-engine/external-service-store'

class InMemorySettingsRepository {
  private store = new Map<string, string>()
  getSetting(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setSetting(key: string, value: string): void {
    this.store.set(key, value)
  }
}

test('U8.3 migrateLegacyKeysOnce moves legacy Tavily key into profile and clears legacy row', () => {
  const repo = new InMemorySettingsRepository()
  repo.setSetting('web_search_tavily_key', 'tvly-legacy-secret-123')
  repo.setSetting('web_fetch_jina_key', 'jina-legacy-secret-456')

  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  const result = store.migrateLegacyKeysOnce()

  assert.equal(result.alreadyDone, false)
  assert.equal(result.migrated, 2)
  // Legacy rows cleared
  assert.equal(repo.getSetting('web_search_tavily_key'), '')
  assert.equal(repo.getSetting('web_fetch_jina_key'), '')
  // Done flag set
  assert.equal(repo.getSetting('external_service_legacy_key_migration_done_v1'), 'true')

  // New profiles carry the secret
  const tavily = store.getRuntimeService('tavily-default')
  const jina = store.getRuntimeService('jina-default')
  assert.ok(tavily, 'tavily profile must exist')
  assert.ok(jina, 'jina profile must exist')
  assert.equal(tavily?.secrets.apiKey, 'tvly-legacy-secret-123')
  assert.equal(jina?.secrets.apiKey, 'jina-legacy-secret-456')
  assert.equal(tavily?.enabled, true)
  assert.equal(jina?.enabled, true)
})

test('U8.3 migrateLegacyKeysOnce is idempotent — re-running after done is a noop', () => {
  const repo = new InMemorySettingsRepository()
  repo.setSetting('external_service_legacy_key_migration_done_v1', 'true')
  repo.setSetting('web_search_tavily_key', 'should-not-be-read')

  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  const result = store.migrateLegacyKeysOnce()

  assert.equal(result.alreadyDone, true)
  assert.equal(result.migrated, 0)
  // Legacy row not touched (because already done)
  assert.equal(repo.getSetting('web_search_tavily_key'), 'should-not-be-read')
})

test('U8.3 migrateLegacyKeysOnce with no legacy values still sets done flag', () => {
  const repo = new InMemorySettingsRepository()
  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  const result = store.migrateLegacyKeysOnce()

  assert.equal(result.alreadyDone, false)
  assert.equal(result.migrated, 0)
  assert.equal(repo.getSetting('external_service_legacy_key_migration_done_v1'), 'true')
})
