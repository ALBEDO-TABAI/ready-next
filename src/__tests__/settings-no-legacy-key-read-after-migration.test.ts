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

test('U8.3 default config does NOT read legacy Tavily/Jina keys (no emergency flag)', () => {
  delete process.env.READY_SETTINGS_RESTORE_LEGACY_KEYS

  const repo = new InMemorySettingsRepository()
  // Pretend the migration was never run — legacy rows still present.
  repo.setSetting('web_search_tavily_key', 'tvly-leftover-secret')
  repo.setSetting('web_fetch_jina_key', 'jina-leftover-secret')

  const store = new ExternalServiceStore(repo as unknown as ConstructorParameters<typeof ExternalServiceStore>[0])
  const cfg = store.getGeneralResearchConfig()

  // Legacy fallback was the bug — must be undefined now that emergency flag is unset.
  assert.equal(cfg.tavilyKey, undefined, 'tavilyKey must NOT fall back to legacy DB row')
  assert.equal(cfg.jinaKey, undefined, 'jinaKey must NOT fall back to legacy DB row')
})
