import { createHash } from 'node:crypto'
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

  getRawDb() { return { exec() {}, inTransaction: false } }
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
    async startWechatLogin(_id: string, _force: boolean, sessionKey: string): Promise<Record<string, unknown>> { return { success: true, sessionKey } },
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

test('Feishu pairing binds one private sender and cannot be replayed for another sender', async () => {
  await withVault(async ({ db, service }) => {
    await service.upsertChannel({ id: 'feishu', type: 'feishu-app', name: 'Fixture', enabled: true,
      config: { appId: 'fixture-app', appSecret: 'fixture-secret' } })
    const pairing = service.startChannelPairing('feishu')
    assert.ok(!db.getSetting('channel_pairing:feishu')!.includes(pairing.code))
    const message = { channelId: 'feishu', thread: 'chat', sender: 'owner', text: `/bind ${pairing.code}`, meta: { chatType: 'group' } }
    await service.consumeChannelPairing(message)
    assert.equal(service.listChannels()[0].config.allowedSenderId, undefined)
    await service.consumeChannelPairing({ ...message, meta: { chatType: 'p2p' } })
    const bound = service.listChannels()[0]
    assert.equal(bound.config.allowedSenderId, 'owner')
    assert.equal(bound.config.remoteAssistantEnabled, true)
    await service.consumeChannelPairing({ ...message, sender: 'stranger', meta: { chatType: 'p2p' } })
    assert.equal(service.listChannels()[0].config.allowedSenderId, 'owner')
    const oldPairing = service.startChannelPairing('feishu')
    await service.upsertChannel({ id: 'feishu', type: 'feishu-app', name: 'Fixture', enabled: true,
      config: { appId: 'different-app', appSecret: 'different-secret' } })
    await service.consumeChannelPairing({ ...message, text: `/bind ${oldPairing.code}`, meta: { chatType: 'p2p' } })
    assert.equal(service.listChannels()[0].config.allowedSenderId, null)
    assert.equal(service.listChannels()[0].config.remoteAssistantEnabled, false)
  })
})

test('a WeChat completion arriving before the QR request returns is saved without the settings page', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    let completion: Promise<void> | undefined
    sidecar.startWechatLogin = async (id, _force, sessionKey) => {
      assert.equal(JSON.parse(db.getSetting(`wechat_login:${id}`)!).sessionKey, sessionKey)
      completion = service.completeWechatBinding({ channelId: id, sessionKey, accountId: 'account', userId: 'owner' })
      return { success: true, sessionKey }
    }
    const started = await service.startWechatLogin({ id: 'wechat' })
    await completion
    const status = await service.getWechatLoginStatus('wechat', String(started.sessionKey))
    assert.equal(status.status, 'connected')
    assert.equal(service.listChannels()[0].config.allowedSenderId, 'owner')
  })
})

test('cancelling while the adapter receives a completed binding cannot re-enable it', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    await service.startWechatLogin({ id: 'wechat' })
    const { sessionKey } = JSON.parse(db.getSetting('wechat_login:wechat')!)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const mirror = sidecar.upsertChannel
    let paused = false
    let adapterEnabled = false
    sidecar.upsertChannel = async payload => {
      adapterEnabled = Boolean(payload.enabled)
      if (payload.enabled && !paused) { paused = true; entered(); await gate }
      return mirror(payload)
    }
    const completion = service.completeWechatBinding({ channelId: 'wechat', sessionKey, accountId: 'account', userId: 'owner' })
    await started
    const cancelled = service.setChannelEnabled('wechat', false)
    release()
    await Promise.all([completion, cancelled])
    assert.equal(service.listChannels()[0].enabled, false)
    assert.equal(adapterEnabled, false)
    assert.equal((await service.getWechatLoginStatus('wechat', sessionKey)).status, 'cancelled')
  })
})

test('an adapter acknowledgement cannot erase a pending deletion', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    await service.upsertChannel({ id: 'wechat', type: 'wechat-openclaw', name: 'Fixture', enabled: true, config: { accountId: 'account' } })
    sidecar.setDeleteFails(true)
    await assert.rejects(service.deleteChannel('wechat'), /sidecar_delete_failed/)
    service.recordChannelDeliveryResult('wechat', { success: true })
    assert.equal(db.getAgentChannel('wechat')?.last_error, 'channel_delete_pending')
    await assert.rejects(service.setChannelEnabled('wechat', true), /正在删除/)
    await assert.rejects(service.startWechatLogin({ id: 'wechat' }), /正在删除/)
  })
})

test('an incomplete WeChat identity remains unbound and does not poison the durable inbox', async () => {
  await withVault(async ({ db, service }) => {
    const started = await service.startWechatLogin({ id: 'wechat' })
    const sessionKey = String(started.sessionKey)
    await service.completeWechatBinding({ channelId: 'wechat', sessionKey, accountId: 'account', userId: '' })
    assert.equal(db.getAgentChannel('wechat')?.enabled, 0)
    assert.equal((await service.getWechatLoginStatus('wechat', sessionKey)).status, 'error')
    await service.completeWechatBinding({ channelId: 'wechat', sessionKey, accountId: 'account', userId: 'late-owner' })
    assert.equal(service.listChannels()[0].config.allowedSenderId, undefined)
  })
})

test('WeChat binding completes in Main once and ignores an old result after cancellation', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    await service.upsertChannel({ id: 'wechat', type: 'wechat-openclaw', name: 'Fixture', enabled: false, config: {} })
    db.setSetting('wechat_login:wechat', JSON.stringify({ sessionKey: 'fixture-session', status: 'pending' }))
    const before = sidecar.upserts.length
    const result = { channelId: 'wechat', sessionKey: 'fixture-session', accountId: 'fixture-account', userId: 'owner' }
    await Promise.all([service.completeWechatBinding(result), service.completeWechatBinding(result)])
    assert.equal(sidecar.upserts.length, before + 1)
    assert.equal(service.listChannels()[0].config.allowedSenderId, 'owner')
    assert.equal(service.listChannels()[0].enabled, true)
    await service.setChannelEnabled('wechat', false)
    await service.completeWechatBinding(result)
    assert.equal(service.listChannels()[0].enabled, false)
  })
})

test('a channel startup failure is returned and recorded instead of claiming connected', async () => {
  await withVault(async ({ db, sidecar, service }) => {
    sidecar.startChannel = async () => ({ success: false, error: 'fixture_connection_failed' })
    await assert.rejects(service.upsertChannel({ id: 'wechat', type: 'wechat-openclaw', name: 'Fixture', enabled: true,
      config: { accountId: 'fixture-account' } }), /fixture_connection_failed/)
    assert.equal(db.getAgentChannel('wechat')?.last_error, 'fixture_connection_failed')
  })
})

test('verified stored WeChat credentials restore their existing owner without accepting an unrelated account', async () => {
  await withVault(async ({ service }) => {
    await service.upsertChannel({ id: 'wechat', type: 'wechat-openclaw', name: 'Fixture', enabled: true,
      config: { accountId: 'existing-account' } })
    await service.completeWechatBinding({ channelId: 'wechat', restored: true, accountId: 'unrelated-account', userId: 'stranger' })
    assert.equal(service.listChannels()[0].config.allowedSenderId, undefined)
    await service.completeWechatBinding({ channelId: 'wechat', restored: true, accountId: 'existing-account', userId: 'owner', bindingId: `restored-${createHash('sha256').update('wechat:existing-account:owner').digest('hex').slice(0, 32)}` })
    assert.equal(service.listChannels()[0].config.allowedSenderId, 'owner')
    await service.completeWechatBinding({ channelId: 'wechat', restored: true, accountId: 'existing-account', userId: 'stranger' })
    assert.equal(service.listChannels()[0].config.allowedSenderId, 'owner')
  })
})

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
