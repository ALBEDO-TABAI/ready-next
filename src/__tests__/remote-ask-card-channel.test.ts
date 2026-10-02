/**
 * Phase I P0（2026-07-05）—— 远程确认链路行为合同（service 层）。
 *
 * 断言四条通路（合同条款 1/3/4/5）：
 *   1. 渠道 scope 的卡经 agent_channel_threads 反查转投微信线程（非渠道
 *      scope 零动作）；
 *   2. 入站文本命中 pending 卡 → 经唯一 submit core 落地并 resolve 卡；
 *   3. 解析失败 → 回格式指引，卡保持 pending，消息被消费不派发新 run；
 *   4. 取消词 → cancel core 拒绝卡并回执。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteChannelService } from '../main/modules/agent-control/runtime-core/remote-channel-service'
import type { RemoteChannelServiceDeps } from '../main/modules/agent-control/runtime-core/remote-channel-service'
import {
  getAskUserQuestionsStore,
  _resetAskUserQuestionsStoreForTests,
  type AskUserQuestionsAnswerSet,
} from '../main/modules/tools/builtins/ask-user-questions-store'
import type { PendingInboundChannel } from '../main/modules/agent-control/runtime-core/runtime-helpers'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { flatDomainStores } from './helpers/flat-domain-stores'

test('remote-ask-card-channel declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'remote-ask-card-channel transitive sqlite load')
})

interface SentRecord {
  id: string
  thread: string
  text: string
}

function makeService(options: {
  threadBySession?: { channel_id: string; remote_thread: string } | null
}): { service: RemoteChannelService; sent: SentRecord[] } {
  const sent: SentRecord[] = []
  const fakeDb = {
    getAgentChannel: () => ({ enabled: 1, config_json: '{}' }),
    getConversationScope: () => ({ meta_json: '{}' }),
    getAgentChannelThreadBySession: () => options.threadBySession ?? null,
    getChatMessageById: () => ({ meta_json: JSON.stringify({ askUserQuestions: { status: 'pending' } }) }),
    updateChatMessageMeta: () => true,
    getSetting: () => null,
  }
  const fakeSidecar = {
    sendChannel: async (payload: { id: string; thread: string; text: string }) => {
      sent.push({ id: payload.id, thread: payload.thread, text: payload.text })
      return { success: true }
    },
  }
  const deps = {
    db: flatDomainStores(fakeDb),
    sidecar: fakeSidecar,
    settingsRepository: {},
    getRuntimeStatus: () => ({}),
    emitConversationEvent: () => {},
    recordChannelDeliveryResult: () => {},
    ensureChannelScope: () => ({ id: 'scope-1', agent: 'butler' }),
    createConversationMessage: () => ({ id: 'msg-1' }),
    refreshScope: () => ({ id: 'scope-1' }),
    refreshActiveRunProgress: () => {},
  } as unknown as RemoteChannelServiceDeps
  return { service: new RemoteChannelService(deps), sent }
}

function registerPendingCard(scopeId: string): {
  cardId: string
  resolved: AskUserQuestionsAnswerSet[]
  rejected: Error[]
} {
  const store = getAskUserQuestionsStore()
  const resolved: AskUserQuestionsAnswerSet[] = []
  const rejected: Error[] = []
  const cardId = 'auq-testcard'
  store.register({
    cardId,
    sessionId: scopeId,
    conversationId: scopeId,
    scopeId,
    agent: 'butler',
    requestId: 'req-1',
    questions: [{
      id: 'frozen_call_confirm',
      question: '将覆盖移动文件 report.pdf，是否执行？',
      kind: 'single_choice',
      options: ['确认执行', '取消'],
      required: true,
    }],
    askedAt: Date.now(),
    resolve: (answerSet) => resolved.push(answerSet),
    reject: (error) => rejected.push(error),
    timeoutHandle: setTimeout(() => {}, 30_000),
  })
  return { cardId, resolved, rejected }
}

const PENDING_INBOUND: PendingInboundChannel = {
  channelId: 'wechat-openclaw',
  thread: 'wxid_demo',
  sender: '白',
  eventIds: ['evt-1'],
  texts: [],
  attachments: [],
  timer: null,
} as unknown as PendingInboundChannel

test('forwards the ask card to the mapped channel thread and stays silent for non-channel scopes', async () => {
  _resetAskUserQuestionsStoreForTests()
  const mapped = makeService({ threadBySession: { channel_id: 'wechat-openclaw', remote_thread: 'wxid_demo' } })
  const delivered = await mapped.service.maybeForwardAskCardToChannel({
    cardId: 'auq-x',
    sessionId: 'scope-1',
    conversationId: 'scope-1',
    scopeId: 'scope-1',
    questions: [{
      id: 'q1',
      question: '继续吗？',
      kind: 'single_choice',
      options: ['继续', '停止'],
      required: true,
    }],
    askedAt: Date.now(),
  })
  assert.equal(delivered, true)
  assert.equal(mapped.sent.length, 1)
  assert.equal(mapped.sent[0].id, 'wechat-openclaw')
  assert.equal(mapped.sent[0].thread, 'wxid_demo')
  assert.match(mapped.sent[0].text, /【需要你确认】/)
  assert.match(mapped.sent[0].text, /1\. 继续/)

  const unmapped = makeService({ threadBySession: null })
  const skipped = await unmapped.service.maybeForwardAskCardToChannel({
    cardId: 'auq-y',
    sessionId: 'local-scope',
    conversationId: 'local-scope',
    scopeId: 'local-scope',
    questions: [{ id: 'q1', question: 'x?', kind: 'free_text', required: true }],
    askedAt: Date.now(),
  })
  assert.equal(skipped, false)
  assert.equal(unmapped.sent.length, 0)
})

test('inbound "1" resolves the pending card through the submit core and sends a receipt', async () => {
  _resetAskUserQuestionsStoreForTests()
  const { service, sent } = makeService({ threadBySession: null })
  const { resolved } = registerPendingCard('scope-1')

  const handled = await service.tryResolvePendingAskCardFromInbound('scope-1', '1', PENDING_INBOUND)
  assert.equal(handled, true)
  assert.equal(resolved.length, 1)
  assert.deepEqual(resolved[0].answers, [{ id: 'frozen_call_confirm', answer: '确认执行' }])
  assert.equal(getAskUserQuestionsStore().findPendingForScope('scope-1'), null, 'card must leave the store')
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /已收到确认：确认执行/)
})

test('unparsable inbound keeps the card pending and replies with guidance (message consumed, no new run)', async () => {
  _resetAskUserQuestionsStoreForTests()
  const { service, sent } = makeService({ threadBySession: null })
  const { resolved, rejected } = registerPendingCard('scope-1')

  const handled = await service.tryResolvePendingAskCardFromInbound('scope-1', '随便聊聊别的', PENDING_INBOUND)
  assert.equal(handled, true, 'message must be consumed by the answer path')
  assert.equal(resolved.length, 0)
  assert.equal(rejected.length, 0)
  assert.notEqual(getAskUserQuestionsStore().findPendingForScope('scope-1'), null, 'card stays pending')
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /没能识别这条回复/)
  assert.match(sent[0].text, /【需要你确认】/)
  getAskUserQuestionsStore().reject('auq-testcard', new Error('test cleanup'))
})

test('cancel word rejects the card via the cancel core and acknowledges', async () => {
  _resetAskUserQuestionsStoreForTests()
  const { service, sent } = makeService({ threadBySession: null })
  const { resolved, rejected } = registerPendingCard('scope-1')

  const handled = await service.tryResolvePendingAskCardFromInbound('scope-1', '取消', PENDING_INBOUND)
  assert.equal(handled, true)
  assert.equal(resolved.length, 0)
  assert.equal(rejected.length, 1, 'cancel core must reject the pending waiter')
  assert.equal(getAskUserQuestionsStore().findPendingForScope('scope-1'), null)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /已取消本次确认/)
})

test('no pending card → not handled, nothing sent (normal run path untouched)', async () => {
  _resetAskUserQuestionsStoreForTests()
  const { service, sent } = makeService({ threadBySession: null })
  const handled = await service.tryResolvePendingAskCardFromInbound('scope-1', '帮我发一条小红书', PENDING_INBOUND)
  assert.equal(handled, false)
  assert.equal(sent.length, 0)
})
