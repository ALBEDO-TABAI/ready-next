import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CredentialVault,
  createCredentialHandle,
} from '../main/modules/settings-engine/credential-vault'
import {
  EXTERNAL_SERVICE_SETTINGS_KEY,
  ExternalServiceStore,
  shouldReserveAmapRouteTool,
} from '../main/modules/settings-engine/external-service-store'

class InMemorySettingsRepository {
  private readonly values = new Map<string, string>()
  failNextSet = false
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('fixture_settings_write_failed')
    }
    this.values.set(key, value)
  }
}

function legacyAmapProfiles(secret: string): string {
  return JSON.stringify([{
    id: 'amap-default',
    kind: 'amap',
    name: '高德地图',
    enabled: true,
    baseUrl: 'https://restapi.amap.com',
    options: {},
    secrets: { apiKey: secret },
  }])
}

test('unreadable legacy external-service secrets are visible as recovery-required but never executable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-external-vault-legacy-'))
  const repository = new InMemorySettingsRepository()
  repository.setSetting(EXTERNAL_SERVICE_SETTINGS_KEY, legacyAmapProfiles('__enc__AAAA'))
  const vault = new CredentialVault(join(root, 'credentials', 'ready-credentials.json'))
  await vault.initialize()
  const store = new ExternalServiceStore(repository as never, vault)
  const originalFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount += 1
    return new Response('{}')
  }) as typeof fetch
  try {
    const publicProfile = store.getPublicProfile('amap-default')
    const runtime = store.getAmapConfig()
    assert.equal(publicProfile?.secretStatus.apiKey.state, 'recovery_required')
    assert.equal(publicProfile?.secretStatus.apiKey.configured, false)
    assert.equal(runtime?.secretState, 'recovery_required')
    assert.equal(runtime?.apiKey, '')

    const probe = await store.testProfile('amap-default')
    assert.equal(probe.ok, false)
    assert.match(probe.message, /重新填写/)
    const draftProbe = await store.testProfileDraft({
      id: 'amap-default',
      kind: 'amap',
      enabled: true,
      baseUrl: 'https://restapi.amap.com',
      secrets: {},
    })
    assert.equal(draftProbe.ok, false)
    assert.match(draftProbe.message, /重新填写/)
    assert.equal(fetchCount, 0)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

test('a referenced but missing map credential stays on the explicit recovery path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-external-vault-dangling-'))
  const repository = new InMemorySettingsRepository()
  const handle = createCredentialHandle('external-service:amap-default', 'apiKey')
  repository.setSetting(EXTERNAL_SERVICE_SETTINGS_KEY, legacyAmapProfiles(handle))
  const vault = new CredentialVault(join(root, 'credentials', 'ready-credentials.json'))
  await vault.initialize()
  try {
    const store = new ExternalServiceStore(repository as never, vault)
    const config = store.getAmapConfig()
    assert.equal(config?.secretState, 'recovery_required')
    assert.equal(config?.apiKey, '')
    assert.equal(shouldReserveAmapRouteTool(config), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed external-service replacement keeps the previously committed credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-external-vault-failed-save-'))
  const repository = new InMemorySettingsRepository()
  const vault = new CredentialVault(join(root, 'credentials', 'ready-credentials.json'))
  await vault.initialize()
  try {
    const store = new ExternalServiceStore(repository as never, vault)
    await store.upsertProfile({
      id: 'amap-default',
      kind: 'amap',
      enabled: true,
      secrets: { apiKey: 'old-amap-key' },
    })
    repository.failNextSet = true
    await assert.rejects(
      store.upsertProfile({ id: 'amap-default', secrets: { apiKey: 'new-amap-key' } }),
      /fixture_settings_write_failed/,
    )
    assert.equal(store.getAmapConfig()?.apiKey, 'old-amap-key')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('saved external-service secrets survive a new store and vault instance while SQLite keeps only a handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-external-vault-restart-'))
  const vaultPath = join(root, 'credentials', 'ready-credentials.json')
  const repository = new InMemorySettingsRepository()
  try {
    const firstVault = new CredentialVault(vaultPath)
    await firstVault.initialize()
    const firstStore = new ExternalServiceStore(repository as never, firstVault)
    await firstStore.upsertProfile({
      id: 'amap-default',
      kind: 'amap',
      enabled: true,
      secrets: { apiKey: 'stable-amap-secret' },
    })

    const persisted = repository.getSetting(EXTERNAL_SERVICE_SETTINGS_KEY) || ''
    assert.doesNotMatch(persisted, /stable-amap-secret/)
    assert.match(persisted, /__ready_credential_v1__/)
    const storedHandle = JSON.parse(persisted).find(
      (profile: { id?: string }) => profile.id === 'amap-default',
    ).secrets.apiKey as string

    const restartedVault = new CredentialVault(vaultPath)
    await restartedVault.initialize()
    const restartedStore = new ExternalServiceStore(repository as never, restartedVault)
    assert.equal(restartedStore.getAmapConfig()?.apiKey, 'stable-amap-secret')
    assert.equal(restartedStore.getPublicProfile('amap-default')?.secretStatus.apiKey.state, 'ready')

    await restartedStore.upsertProfile({
      id: 'amap-default',
      clearSecrets: ['apiKey'],
      enabled: false,
    })
    assert.equal(
      restartedVault.read(storedHandle).state,
      'missing',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup classifies every legacy secret without opening system credential storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-external-vault-migration-'))
  const repository = new InMemorySettingsRepository()
  const recoverable = Buffer.from('recoverable').toString('base64')
  const unavailable = Buffer.from('unavailable').toString('base64')
  repository.setSetting(EXTERNAL_SERVICE_SETTINGS_KEY, JSON.stringify([
    {
      id: 'amap-default',
      kind: 'amap',
      name: '高德地图',
      enabled: true,
      secrets: { apiKey: `__enc__${recoverable}` },
    },
    {
      id: 'tavily-default',
      kind: 'tavily',
      name: 'Tavily',
      enabled: true,
      secrets: { apiKey: `__enc__${unavailable}` },
    },
  ]))
  const vault = new CredentialVault(join(root, 'credentials', 'ready-credentials.json'))
  await vault.initialize()
  try {
    const store = new ExternalServiceStore(repository as never, vault)
    const result = await store.migrateStoredCredentialsOnce()
    assert.deepEqual(result, { migrated: 0, unresolved: 2, alreadyDone: false })
    assert.equal(store.getAmapConfig()?.secretState, 'recovery_required')
    assert.equal(store.getAmapConfig()?.apiKey, '')
    assert.equal(store.getPublicProfile('tavily-default')?.secretStatus.apiKey.state, 'recovery_required')
    assert.equal(repository.getSetting(EXTERNAL_SERVICE_SETTINGS_KEY)?.includes('__enc__'), true)
    assert.equal((await store.migrateStoredCredentialsOnce()).alreadyDone, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
