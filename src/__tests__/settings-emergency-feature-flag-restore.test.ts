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

test('U8.3 READY_SETTINGS_RESTORE_LEGACY_KEYS=1 re-enables legacy fallback (emergency only)', () => {
  process.env.READY_SETTINGS_RESTORE_LEGACY_KEYS = '1'
  try {
    const repo = new InMemorySettingsRepository()
    repo.setSetting('web_search_tavily_key', 'tvly-emergency-restore')
    repo.setSetting('web_fetch_jina_key', 'jina-emergency-restore')

    const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
    const cfg = store.getGeneralResearchConfig()

    assert.equal(cfg.tavilyKey, 'tvly-emergency-restore', 'emergency flag must restore legacy Tavily key path')
    assert.equal(cfg.jinaKey, 'jina-emergency-restore', 'emergency flag must restore legacy Jina key path')
  } finally {
    delete process.env.READY_SETTINGS_RESTORE_LEGACY_KEYS
  }
})

test('U8.3 emergency flag NOT set to "1" does NOT enable legacy fallback', () => {
  for (const value of ['0', 'true', '', 'yes', undefined]) {
    if (value === undefined) {
      delete process.env.READY_SETTINGS_RESTORE_LEGACY_KEYS
    } else {
      process.env.READY_SETTINGS_RESTORE_LEGACY_KEYS = value
    }
    const repo = new InMemorySettingsRepository()
    repo.setSetting('web_search_tavily_key', 'tvly-leftover')
    const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
    const cfg = store.getGeneralResearchConfig()
    assert.equal(cfg.tavilyKey, undefined, `emergency flag value ${JSON.stringify(value)} must NOT enable legacy fallback`)
  }
  delete process.env.READY_SETTINGS_RESTORE_LEGACY_KEYS
})
