import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { ensureRemoteChannelAlias } from '../main/modules/agent-control/codex-runtime/remote-channel-alias'
import { RemoteChannelService, type RemoteChannelServiceDeps } from '../main/modules/agent-control/runtime-core/remote-channel-service'
import { ConversationScopeStore } from '../main/modules/agent-control/runtime-core/conversation-scope-store'
import { ChannelConfigService } from '../main/modules/agent-control/runtime-core/channel-config-service'
import { SidecarPollService, type SidecarPollServiceDeps } from '../main/modules/agent-control/runtime-core/sidecar-poll-service'
import type { SendScopedRequest, SendScopedResponse } from '../shared/ipc-contracts/agent-runtime'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('WeChat identity and completion receipt commit together or roll back together', async t => {
  if (skipIfSqliteUnavailable(t, 'atomic remote binding')) return
  const db = new DatabaseManager(true); t.after(() => db.close())
  db.upsertAgentChannel({ id: 'w', type: 'wechat-openclaw', name: 'WeChat', enabled: false, configJson: '{}' })
  db.setSetting('wechat_login:w', JSON.stringify({ status: 'pending', sessionKey: 'session' }))
  const service = new ChannelConfigService({ db, sidecar: { isRunning: () => false } as never,
    startSidecar: async () => {}, heartbeat: {} as never })
  const setSetting = db.setSetting.bind(db)
  db.setSetting = () => { throw new Error('receipt_write_failed') }
  const completion = { channelId: 'w', sessionKey: 'session', accountId: 'account', userId: 'owner' }
  await assert.rejects(service.completeWechatBinding(completion), /receipt_write_failed/)
  assert.equal(db.getAgentChannel('w')?.enabled, 0)
  assert.equal(db.getAgentChannel('w')?.config_json, '{}')
  db.setSetting = setSetting
  await service.completeWechatBinding(completion)
  assert.equal(db.getAgentChannel('w')?.enabled, 1)
  assert.equal((await service.getWechatLoginStatus('w', 'session')).status, 'connected')
})

test('sidecar startup failures become visible health errors without escaping the poll loop', async () => {
  const heartbeat = { sidecar: { status: 'stopped' } } as SidecarPollServiceDeps['heartbeat']
  const service = new SidecarPollService({ heartbeat, sidecar: { isRunning: () => false } as never,
    startSidecar: async () => { throw new Error('fixture_start_failed') }, getSettingBool: () => true } as SidecarPollServiceDeps)
  await (service as unknown as { pollSidecarEvents(): Promise<void> }).pollSidecarEvents()
  assert.equal(heartbeat.sidecar.status, 'error')
  assert.equal(heartbeat.sidecar.error, 'fixture_start_failed')
})

function harness(send?: (request: SendScopedRequest) => Promise<SendScopedResponse>) {
  const db = new DatabaseManager(true)
  const manifest = { runtimeManifestDigest: 'test-runtime', protocolSchemaDigest: 'test-protocol' }
  const repository = new CodexBindingRepository(db.getRawDb()!, manifest)
  db.upsertAgentChannel({ id: 'c', type: 'feishu-app', name: 'Fixture', enabled: true,
    configJson: JSON.stringify({ allowedSenderId: 'owner', bindingId: 'binding-1', remoteAssistantEnabled: true }) })
  const inputs: SendScopedRequest[] = []
  const sent: Array<{ text: string; thread?: string; deliveryId?: string }> = []
  let service!: RemoteChannelService
  const store = new ConversationScopeStore({ ensureChannelAlias: scopeId => ensureRemoteChannelAlias({ database: db, repository, scopeId, ...manifest }), db, emitConversationEvent() {}, mapChannelRow: () => ({ name: 'Fixture', type: 'feishu-app', config: { bindingId: 'binding-1' } }) as never,
    getScopedRemoteThreadKey: (...args) => service.getScopedRemoteThreadKey(...args),
    getRemoteChannelSessionSettingKey: (...args) => service.getRemoteChannelSessionSettingKey(...args),
    restoreReferenceHintFromScope() {}, persistReferenceHintToScope() {}, resolveConversationAgentId: () => 'butler',
    readAliasGeneration: (id) => repository.readActiveAliasBinding(id)?.aliasGeneration ?? null })
  const deps: RemoteChannelServiceDeps = {
    db, sidecar: { sendChannel: async (request: typeof sent[number]) => { sent.push(request); return { success: true } } } as never,
    settingsRepository: {} as never, getRuntimeStatus: async () => ({} as never),
    emitConversationEvent() {}, recordChannelDeliveryResult() {}, consumeChannelPairing: async () => false,
    stopScoped: async () => false,
    sendScoped: async request => {
      inputs.push(request)
      return send ? send(request) : { success: true, disposition: 'terminal_success',
        canonicalMessage: { content: 'answer' } } as SendScopedResponse
    },
    ensureChannelScope: (...args) => store.ensureChannelScope(...args),
    createConversationMessage: (...args) => store.createConversationMessage(...args),
    refreshScope: id => store.refreshScope(id),
    ensureCodexScope: scope => { ensureRemoteChannelAlias({ database: db, repository, scopeId: scope.id, ...manifest }); return store.refreshScope(scope.id) },
  }
  service = new RemoteChannelService(deps)
  const receive = (id: string, text: string, extra: Record<string, unknown> = {}) => service.handleInboundChannel({
    id, text, channelId: 'c', thread: 'chat', sender: 'owner', meta: { bindingId: 'binding-1' }, ...extra,
  })
  const flush = (id: string) => (service as unknown as { flushInboundChannel(key: string): Promise<void> }).flushInboundChannel(`c::chat::${id}`)
  return { db, inputs, sent, repository, store, receive, flush,
    restart: async () => { service.stop(); service = new RemoteChannelService(deps); await service.recoverPendingInbound() },
    close: () => { service.stop(); db.close() },
  }
}

test('duplicate remote events produce one Codex input, and separate messages keep their identities', async t => {
  if (skipIfSqliteUnavailable(t, 'remote durable input')) return
  const h = harness(); t.after(h.close)
  await h.receive('one', 'hello')
  await h.receive('one', 'hello')
  assert.equal(h.db.getAgentChannelEvent('one')?.status, 'queued')
  assert.ok(h.db.getAgentChannelEvent('one')?.payload_json)
  await h.flush('one')
  await h.receive('one', 'hello')
  await h.flush('one')
  await h.receive('two', 'next')
  await h.flush('two')
  assert.deepEqual(h.inputs.map(r => r.message), ['hello', 'next'])
  assert.equal(h.inputs[0].expectedAliasGeneration, 1)
  assert.equal(h.inputs[0].scopeId, h.inputs[1].scopeId)
  assert.equal(h.repository.readLatestAliasGeneration(h.inputs[0].scopeId), 1)
  assert.equal(h.sent.length, 2)
  assert.ok(h.sent.every(r => r.thread === 'chat'))
})

test('unbound senders and attachment-only receipts cannot start Codex', async t => {
  if (skipIfSqliteUnavailable(t, 'remote owner authorization')) return
  const h = harness(); t.after(h.close)
  await h.receive('stranger', 'run this', { sender: 'someone-else' })
  await h.flush('stranger')
  await h.receive('file', '', { attachments: [{ name: 'brief.txt', path: '/tmp/brief.txt', type: 'text', size: 3 }] })
  await h.flush('file')
  assert.equal(h.inputs.length, 0)
  assert.equal(h.sent.length, 0)
  assert.equal(h.db.getAgentChannelEvent('stranger'), null)
  assert.equal(h.db.getAgentChannelEvent('file')?.status, 'done')
  const binding = h.db.getAgentChannelThread('c', 'chat')!
  assert.equal(h.db.getChatMessages(binding.session_id).length, 1)
})

test('queued input recovers after restart without changing its visible context', async t => {
  if (skipIfSqliteUnavailable(t, 'remote queue restart')) return
  const h = harness(); t.after(h.close)
  await h.receive('queued', 'after restart')
  const before = h.db.getAgentChannelEvent('queued')?.payload_json
  await h.restart()
  await h.flush('queued')
  assert.equal(h.inputs.length, 1)
  assert.equal(h.inputs[0].scopeId, JSON.parse(before!).frozenScopeId)
  assert.equal(h.db.getAgentChannelEvent('queued')?.status, 'done')
})

test('two remote tasks run in order and a revoked binding cannot receive an old reply', async t => {
  if (skipIfSqliteUnavailable(t, 'remote ordering and revocation')) return
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const h = harness(async request => {
    if (request.message === 'first') { started(); await pending }
    return { success: true, disposition: 'terminal_success', canonicalMessage: { content: 'answer' } } as SendScopedResponse
  }); t.after(h.close)
  await h.receive('first', 'first'); const first = h.flush('first'); await began
  await h.receive('second', 'second'); const second = h.flush('second')
  assert.equal(h.inputs.length, 1)
  h.db.setAgentChannelEnabled('c', false)
  release()
  await Promise.all([first, second])
  assert.equal(h.inputs.length, 1)
  assert.equal(h.sent.length, 0)
  assert.equal(h.db.getAgentChannelEvent('first')?.status, 'failed')
})

test('restart never automatically executes a previously running request', async t => {
  if (skipIfSqliteUnavailable(t, 'remote interrupted execution')) return
  const h = harness(); t.after(h.close)
  await h.receive('interrupted', 'change something')
  h.db.upsertAgentChannelEvent({ eventId: 'interrupted', channelId: 'c', status: 'running' })
  await h.restart()
  assert.equal(h.inputs.length, 0)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /没有自动重做/)
  await h.restart()
  assert.equal(h.sent.length, 1)
})

test('an event from the previous binding cannot enter the replacement binding even for the same sender', async t => {
  if (skipIfSqliteUnavailable(t, 'remote producer binding identity')) return
  const h = harness(); t.after(h.close)
  await h.receive('old-binding', 'old request', { meta: { bindingId: 'previous-binding' } })
  await h.flush('old-binding')
  assert.equal(h.db.getAgentChannelEvent('old-binding'), null)
  assert.equal(h.inputs.length, 0)
})

test('a queued sidecar event for a deleted channel is discarded without recreating that channel or blocking polling', async t => {
  if (skipIfSqliteUnavailable(t, 'deleted remote channel')) return
  const h = harness(); t.after(h.close)
  h.db.deleteAgentChannel('c')
  await assert.doesNotReject(h.receive('deleted', 'late message'))
  assert.equal(h.db.getAgentChannelEvent('deleted'), null)
  assert.equal(h.db.listConversationScopes().length, 0)
})

test('new remote session preserves history and prevents a queued old input from running in it', async t => {
  if (skipIfSqliteUnavailable(t, 'remote new session boundary')) return
  const h = harness(); t.after(h.close)
  await h.receive('first', 'first'); await h.flush('first')
  const oldScope = h.inputs[0].scopeId
  await h.receive('queued', 'old queued request')
  await h.receive('new', '/new'); await h.flush('new')
  await h.flush('queued')
  const nextScope = h.db.getAgentChannelThread('c', 'chat')!.session_id
  assert.notEqual(nextScope, oldScope)
  assert.ok(h.db.getConversationScope(oldScope))
  assert.equal(h.inputs.length, 1)
  assert.equal(h.db.getAgentChannelEvent('queued')?.status, 'failed')
  await h.receive('fresh', 'fresh request'); await h.flush('fresh')
  assert.equal(h.inputs[1].scopeId, nextScope)
})

test('an unexpected current-turn failure reports failure to its owner without replaying the task', async t => {
  if (skipIfSqliteUnavailable(t, 'remote failure notification')) return
  const h = harness(async () => { throw new Error('fixture_dispatch_failed') }); t.after(h.close)
  await h.receive('failed', 'run task'); await h.flush('failed')
  assert.equal(h.inputs.length, 1)
  assert.equal(h.db.getAgentChannelEvent('failed')?.status, 'failed')
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /没有处理完成/)
  await h.restart()
  assert.equal(h.inputs.length, 1)
})
