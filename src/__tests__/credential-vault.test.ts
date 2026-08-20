import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CredentialVault,
  createCredentialHandle,
  credentialHandle,
  isCredentialHandle,
} from '../main/modules/settings-engine/credential-vault'
import { pruneUnreferencedCredentials } from '../main/modules/settings-engine/credential-vault-reconciliation'

test('credential vault survives a new app instance without an app-signing identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-credential-vault-'))
  const filePath = join(root, 'credentials', 'ready-credentials.json')
  const handle = credentialHandle('external-service:amap-default', 'apiKey')
  try {
    const first = new CredentialVault(filePath)
    await first.initialize()
    await first.update({ [handle]: 'amap-secret-value' })

    const second = new CredentialVault(filePath)
    await second.initialize()
    assert.deepEqual(second.read(handle), { state: 'ready', value: 'amap-secret-value' })
    assert.equal(statSync(join(root, 'credentials')).mode & 0o777, 0o700)
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('credential vault keeps referenced generations and prunes abandoned staged values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-credential-vault-prune-'))
  const filePath = join(root, 'credentials', 'ready-credentials.json')
  try {
    const vault = new CredentialVault(filePath)
    await vault.initialize()
    const committed = createCredentialHandle('external-service:amap-default', 'apiKey')
    const abandoned = createCredentialHandle('external-service:amap-default', 'apiKey')
    assert.equal(isCredentialHandle(committed, 'external-service:amap-default', 'apiKey'), true)
    assert.equal(isCredentialHandle(committed, 'external-service:tavily-default', 'apiKey'), false)
    await vault.update({ [committed]: 'current', [abandoned]: 'staged-before-crash' })

    assert.equal(await vault.prune(new Set([committed])), 1)
    assert.deepEqual(vault.read(committed), { state: 'ready', value: 'current' })
    assert.equal(vault.read(abandoned).state, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('credential cleanup preserves every entry when external-service settings are malformed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-credential-vault-malformed-external-'))
  const filePath = join(root, 'credentials', 'ready-credentials.json')
  try {
    const vault = new CredentialVault(filePath)
    await vault.initialize()
    const handle = createCredentialHandle('external-service:amap-default', 'apiKey')
    await vault.update({ [handle]: 'recoverable-map-secret' })

    await assert.rejects(
      pruneUnreferencedCredentials(vault, '{broken', []),
      /credential_reference_external_invalid_json/,
    )
    assert.deepEqual(vault.read(handle), { state: 'ready', value: 'recoverable-map-secret' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('credential cleanup preserves every entry when a channel config is malformed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-credential-vault-malformed-channel-'))
  const filePath = join(root, 'credentials', 'ready-credentials.json')
  try {
    const vault = new CredentialVault(filePath)
    await vault.initialize()
    const handle = createCredentialHandle('channel:channel-feishu', 'appSecret')
    await vault.update({ [handle]: 'recoverable-channel-secret' })

    await assert.rejects(
      pruneUnreferencedCredentials(vault, undefined, [{
        id: 'channel-feishu',
        config_json: '{broken',
      }]),
      /credential_reference_channel_invalid_json/,
    )
    assert.deepEqual(vault.read(handle), { state: 'ready', value: 'recoverable-channel-secret' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('credential vault rejects corrupt files and symlinks without overwriting them', async () => {
  const corruptRoot = mkdtempSync(join(tmpdir(), 'ready-credential-vault-corrupt-'))
  const corruptPath = join(corruptRoot, 'credentials', 'ready-credentials.json')
  const symlinkRoot = mkdtempSync(join(tmpdir(), 'ready-credential-vault-link-'))
  const symlinkPath = join(symlinkRoot, 'credentials', 'ready-credentials.json')
  try {
    const seed = new CredentialVault(corruptPath)
    await seed.initialize()
    await seed.update({ [credentialHandle('test', 'token')]: 'secret' })
    writeFileSync(corruptPath, '{broken', { mode: 0o600 })

    const corrupt = new CredentialVault(corruptPath)
    await assert.rejects(corrupt.initialize(), /credential_vault_invalid/)
    assert.equal(corrupt.read(credentialHandle('test', 'token')).state, 'vault_unavailable')

    const target = join(symlinkRoot, 'target.json')
    writeFileSync(target, '{"version":1,"entries":{}}', { mode: 0o600 })
    const linkDir = join(symlinkRoot, 'credentials')
    const linkSeed = new CredentialVault(join(linkDir, 'seed.json'))
    await linkSeed.initialize()
    rmSync(join(linkDir, 'seed.json'), { force: true })
    symlinkSync(target, symlinkPath)

    const linked = new CredentialVault(symlinkPath)
    await assert.rejects(linked.initialize(), /credential_vault_symlink/)
    assert.equal(linked.read(credentialHandle('test', 'token')).state, 'vault_unavailable')
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true })
    rmSync(symlinkRoot, { recursive: true, force: true })
  }
})
