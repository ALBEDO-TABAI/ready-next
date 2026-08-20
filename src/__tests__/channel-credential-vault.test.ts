import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentChannelRecord } from '../main/modules/database'
import { ChannelConfigService } from '../main/modules/agent-control/runtime-core/channel-config-service'
import {
  decryptChannelConfig,
} from '../main/modules/agent-control/memory/secret-storage'
import {
  CredentialVault,
  __setCredentialVaultForTests,
} from '../main/modules/settings-engine/credential-vault'

class ChannelDatabaseFixture {
  readonly rows = new Map<string, AgentChannelRecord>()
  readonly settings = new Map<string, string>()
  failNextUpsert = false

  listAgentChannels(): AgentChannelRecord[] { return Array.from(this.rows.values()) }
  getAgentChannel(id: string): AgentChannelRecord | null { return this.rows.get(id) ?? null }
  upsertAgentChannel(input: {
    id: string
    type: AgentChannelRecord['type']
    name: string
    enabled: boolean
    configJson: string
    lastError?: string | null
    lastSeenAt?: string | null
  }): AgentChannelRecord {
    if (this.failNextUpsert) {
      this.failNextUpsert = false
      throw new Error('fixture_db_write_failed')
    }
    const previous = this.rows.get(input.id)
    const now = new Date().toISOString()
    const row: AgentChannelRecord = {
      id: input.id,
      type: input.type,
      name: input.name,
      enabled: input.enabled ? 1 : 0,
      config_json: input.configJson,
      last_error: input.lastError ?? null,
      last_seen_at: input.lastSeenAt ?? null,
      created_at: previous?.created_at || now,
      updated_at: now,
    }
    this.rows.set(row.id, row)
    return row
  }
  deleteAgentChannel(id: string): boolean { return this.rows.delete(id) }
  setAgentChannelEnabled(id: string, enabled: boolean): AgentChannelRecord | null {
    const row = this.rows.get(id)
    if (!row) return null
    row.enabled = enabled ? 1 : 0
    return row
  }
  setAgentChannelError(id: string, error: string | null): AgentChannelRecord | null {
    const row = this.rows.get(id)
    if (!row) return null
    row.last_error = error
    return row
  }
  markAgentChannelSeen(id: string): AgentChannelRecord | null { return this.rows.get(id) ?? null }
  getSetting(key: string): string | null { return this.settings.get(key) ?? null }
  setSetting(key: string, value: string): void { this.settings.set(key, value) }
}

function createSidecarFixture() {
  const upserts: Array<Record<string, unknown>> = []
  let deleteFails = false
  return {
    upserts,
    setDeleteFails(value: boolean) { deleteFails = value },
    isRunning: () => true,
    async upsertChannel(payload: Record<string, unknown>) { upserts.push(payload); return { success: true } },
    async startChannel() { return { success: true } },
    async stopChannel() { return { success: true } },
    async deleteChannel() { return deleteFails ? { success: false, error: 'sidecar_delete_failed' } : { success: true } },
    async testChannel(payload: Record<string, unknown>) { upserts.push(payload); return { success: true } },
    async sendChannel() { return { success: true } },
    async startWechatLogin() { return { success: true } },
    async getWechatLoginStatus() { return { success: true } },
    async submitWechatLoginVerifyCode() { return { success: true } },
  }
}

async function withVault(run: (input: {
  db: ChannelDatabaseFixture
  sidecar: ReturnType<typeof createSidecarFixture>
  service: ChannelConfigService
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ready-channel-vault-'))
  const vault = new CredentialVault(join(root, 'credentials', 'ready-credentials.json'))
  await vault.initialize()
  __setCredentialVaultForTests(vault)
  const db = new ChannelDatabaseFixture()
  const sidecar = createSidecarFixture()
  const service = new ChannelConfigService({
    db: db as never,
    sidecar: sidecar as never,
    startSidecar: async () => undefined,
    heartbeat: {
      sidecar: { status: 'running' },
      adapters: [],
      orchestrator: { healthy: true, activeTasks: 0 },
      toolGateway: { healthy: true, availableTools: 0 },
    },
  })
  try {
    await run({ db, sidecar, service })
  } finally {
    __setCredentialVaultForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
}

test('channel public projection never returns a secret while runtime hydration still works', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    const saved = await service.upsertChannel({
      id: 'channel-telegram',
      type: 'telegram-bot',
      name: 'Telegram',
      enabled: true,
      config: { token: 'telegram-secret', defaultChatId: 'chat-1' },
    })

    assert.equal(saved.config.token, undefined)
    assert.equal(saved.config.defaultChatId, 'chat-1')
    assert.equal(saved.credentialState, 'ready')
    assert.equal(saved.secretStatus.token.state, 'ready')
    assert.doesNotMatch(db.getAgentChannel('channel-telegram')!.config_json, /telegram-secret/)
    assert.equal((sidecar.upserts.at(-1)?.config as Record<string, unknown>).token, 'telegram-secret')

    const tested = await service.testChannel({
      id: 'channel-telegram',
      type: 'telegram-bot',
      name: 'Telegram',
      enabled: true,
      config: { defaultChatId: 'chat-2' },
    })
    assert.equal(tested.success, true)
    assert.equal((sidecar.upserts.at(-1)?.config as Record<string, unknown>).token, 'telegram-secret')
  })
})

test('failed channel replacement keeps the previously committed credential usable', async () => {
  await withVault(async ({ db, service }) => {
    await service.upsertChannel({
      id: 'channel-telegram',
      type: 'telegram-bot',
      name: 'Telegram',
      config: { token: 'old-secret' },
    })
    const before = db.getAgentChannel('channel-telegram')!
    db.failNextUpsert = true
    await assert.rejects(
      service.upsertChannel({
        id: 'channel-telegram',
        type: 'telegram-bot',
        name: 'Telegram',
        config: { token: 'new-secret' },
      }),
      /fixture_db_write_failed/,
    )

    const after = db.getAgentChannel('channel-telegram')!
    assert.equal(after.config_json, before.config_json)
    assert.equal(
      decryptChannelConfig(JSON.parse(after.config_json), 'channel:channel-telegram').token,
      'old-secret',
    )
  })
})

test('startup classifies legacy channel credentials without opening system credential storage', async () => {
  await withVault(async ({ db, service }) => {
    db.upsertAgentChannel({
      id: 'channel-feishu',
      type: 'feishu-app',
      name: '飞书',
      enabled: true,
      configJson: JSON.stringify({
        appId: 'cli-1',
        appSecret: `__enc__${Buffer.from('recoverable').toString('base64')}`,
        verificationToken: '__enc__AAAA',
      }),
    })
    assert.equal(service.listChannels()[0].credentialState, 'recovery_required')
    assert.equal(service.isChannelTypeAvailable('feishu-app'), false)
    assert.deepEqual(await service.migrateStoredCredentialsOnce(), {
      migrated: 0,
      unresolved: 2,
      alreadyDone: false,
    })
    const channel = service.listChannels()[0]
    assert.equal(channel.secretStatus.appSecret.state, 'recovery_required')
    assert.equal(channel.secretStatus.verificationToken.state, 'recovery_required')
    assert.equal(channel.credentialState, 'recovery_required')
    assert.equal(db.getAgentChannel('channel-feishu')?.config_json.includes('__enc__'), true)
    assert.equal((await service.migrateStoredCredentialsOnce()).alreadyDone, true)
  })
})

test('channel deletion stays disabled and retryable until sidecar deletion is acknowledged', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    await service.upsertChannel({
      id: 'channel-telegram',
      type: 'telegram-bot',
      name: 'Telegram',
      config: { token: 'delete-me' },
    })
    sidecar.setDeleteFails(true)
    await assert.rejects(service.deleteChannel('channel-telegram'), /sidecar_delete_failed/)
    const pending = db.getAgentChannel('channel-telegram')!
    assert.equal(pending.enabled, 0)
    assert.equal(pending.last_error, 'channel_delete_pending')
    assert.equal(service.listChannels()[0].credentialState, 'recovery_required')

    sidecar.setDeleteFails(false)
    await service.reconcilePendingDeletes()
    assert.equal(db.getAgentChannel('channel-telegram'), null)
  })
})
