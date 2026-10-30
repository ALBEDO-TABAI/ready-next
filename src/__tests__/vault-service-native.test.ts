import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SettingsStore } from '../main/modules/database/settings-store'
import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { VaultService } from '../main/modules/settings-engine/vault-service'
import { VAULT_ROOT_SETTING_KEY } from '../shared/vault'
import { registerVaultIPC } from '../main/modules/settings-engine/vault-ipc'
import { createGenericSettingIPCHandler } from '../main/modules/settings-engine/generic-setting-ipc-handler'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// Host Node skips with an [ABI-SKIP] token; verify:native runs this file under Electron.
test('vault validates before writing, reads persisted state, and only explicitly creates its default', (t) => {
  if (skipIfSqliteUnavailable(t, 'Vault settings persistence')) return
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ready-vault-')))
  const db = new Database(join(temp, 'settings.db'))
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)')
  const settings = new SettingsStore(() => db)
  const repository = new AppSettingsRepository(() => ({ settings, getRawDb: () => db }))
  const home = join(temp, 'home')
  const userData = join(temp, 'Ready Next')
  const documents = join(home, 'Documents')
  mkdirSync(documents, { recursive: true })
  const options = { home, userData, isPackaged: false }
  const service = new VaultService(repository, options)
  try {
    assert.deepEqual(service.get(), { status: 'unconfigured', defaultSuggestion: join(userData, 'test-vault') })
    assert.equal(existsSync(userData), false)
    assert.equal(new VaultService(repository, { ...options, isPackaged: true }).get().defaultSuggestion, join(documents, 'Ready'))
    for (const path of ['', 'relative/path', documents, join(documents, 'nested', '..'), null, 123]) {
      assert.throws(() => service.set(path))
    }
    const missing = join(documents, 'absent')
    assert.throws(() => service.set(missing), /ENOENT/)
    assert.equal(existsSync(missing), false)
    const file = join(documents, 'file')
    writeFileSync(file, 'not a directory')
    assert.throws(() => service.set(file), /文件夹/)
    const daily = join(home, 'Library', 'Application Support', 'Ready')
    mkdirSync(daily, { recursive: true })
    const alias = join(documents, 'alias')
    symlinkSync(daily, alias)
    for (const path of [daily, join(daily, 'new-vault'), alias, join(alias, 'new-vault'), join(documents, 'Ready')]) {
      assert.throws(() => service.set(path), /daily Ready data/)
    }
    assert.equal(repository.getSetting(VAULT_ROOT_SETTING_KEY), undefined)
    assert.equal(existsSync(join(daily, 'new-vault')), false)
    const ready = service.createDefault()
    assert.equal(ready.status, 'ready')
    assert.equal(repository.getSetting(VAULT_ROOT_SETTING_KEY), ready.root)
    assert.deepEqual(new VaultService(repository, options).get(), ready)
    assert.deepEqual(service.createDefault(), ready)
    rmSync(ready.root!, { recursive: true })
    assert.deepEqual(service.get(), { ...ready, status: 'missing' })
    rmSync(userData, { recursive: true })
    writeFileSync(userData, 'parent is no longer a directory')
    assert.deepEqual(service.get(), { ...ready, status: 'missing' })
    const existing = join(documents, 'Project')
    mkdirSync(existing)
    assert.deepEqual(service.set(existing), { status: 'ready', root: existing, defaultSuggestion: ready.defaultSuggestion })
    const generic = createGenericSettingIPCHandler({ repository })
    assert.equal(generic({}, { key: VAULT_ROOT_SETTING_KEY, value: daily }).success, false)
    assert.equal(service.get().root, existing)
    repository.setSetting(VAULT_ROOT_SETTING_KEY, daily)
    assert.throws(() => service.get(), /daily Ready data/)
    assert.throws(() => new VaultService(repository, { ...options, userData: daily }).createDefault(), /daily Ready data/)
    assert.equal(existsSync(join(daily, 'test-vault')), false)
  } finally {
    db.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('vault IPC returns readback and propagates persistence failure without publishing a ready state', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Vault IPC persistence')) return
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ready-vault-ipc-')))
  const handlers = new Map<string, (event: unknown, path?: unknown) => unknown>()
  let reads = 0
  const service = new VaultService({
    getSetting: () => { reads++; return undefined },
    setSetting: () => { throw new Error('disk full') },
  }, { home: join(temp, 'home'), userData: join(temp, 'Ready Next'), isPackaged: false })
  registerVaultIPC({ handle: (channel, handler) => { handlers.set(channel, handler) } }, service)
  try {
    assert.deepEqual([...handlers.keys()], ['vault:get', 'vault:set', 'vault:createDefault'])
    assert.equal((await handlers.get('vault:get')!({}) as { status: string }).status, 'unconfigured')
    assert.throws(() => handlers.get('vault:set')!({}, temp), /disk full/)
    assert.throws(() => handlers.get('vault:createDefault')!({}), /disk full/)
    assert.equal(service.get().status, 'unconfigured')
    let value: string | undefined
    const readbackService = new VaultService({
      getSetting: () => { reads++; return value },
      setSetting: (_key, path) => { value = path },
    }, { home: join(temp, 'home'), userData: join(temp, 'Ready Next'), isPackaged: false })
    const before = reads
    readbackService.set(temp)
    assert.ok(reads > before, 'successful set must read the saved setting')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
