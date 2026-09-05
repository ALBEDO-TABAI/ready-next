import assert from 'node:assert/strict'
import test from 'node:test'
import { runRemoteCodexTurn } from '../main/modules/agent-control/runtime-core/remote-codex-turn'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { SendScopedRequest, SendScopedResponse } from '../shared/ipc-contracts/agent-runtime'

test('remote input uses the existing scoped send with stable identities and canonical output', async () => {
  const inputs: SendScopedRequest[] = []
  const send = async (request: SendScopedRequest) => {
    inputs.push(request)
    return { success: true, disposition: 'terminal_success', responseText: 'uncommitted draft',
      canonicalMessage: { content: 'verified answer' } } as SendScopedResponse
  }
  const scope = { id: 'remote-scope', aliasGeneration: 1, messageVisibilityEpoch: 2 } as ConversationScope
  const input = { scope, eventIds: ['event-1'], text: 'hello', attachments: [], sender: 'owner', channelId: 'c', thread: 't' }
  assert.equal(await runRemoteCodexTurn(input, send), 'verified answer')
  await runRemoteCodexTurn(input, send)
  assert.equal(inputs[0].requestId, inputs[1].requestId)
  assert.equal(inputs[0].userMessage.id, inputs[1].userMessage.id)
  assert.equal(inputs[0].expectedMessageVisibilityEpoch, 2)
  assert.equal(inputs[0].currentDocumentAnchor, undefined)
  assert.equal(inputs[0].userMessage.meta.source, 'channel')
  assert.equal(inputs[0].userMessage.meta.workbenchMode, 'browser')
})

test('a rejected remote input is reported as failure and is not automatically retried', async () => {
  let calls = 0
  const reply = await runRemoteCodexTurn({ scope: { id: 's', messageVisibilityEpoch: 0 } as ConversationScope,
    eventIds: ['e'], text: 'hello', attachments: [], sender: 'owner', channelId: 'c', thread: 't' }, async () => {
    calls++
    return { success: false, disposition: 'rejected_before_persistence', error: 'host_unavailable' } as SendScopedResponse
  })
  assert.equal(calls, 1)
  assert.match(reply, /没有完成/)
})

test('a failed committed run cannot publish its candidate text as a successful reply', async () => {
  const reply = await runRemoteCodexTurn({ scope: { id: 's', messageVisibilityEpoch: 0 } as ConversationScope,
    eventIds: ['e'], text: 'hello', attachments: [], sender: 'owner', channelId: 'c', thread: 't' }, async () => ({
      success: false, disposition: 'terminal_failure_after_persistence', error: 'fixture_failure',
      canonicalMessage: { content: 'candidate output' },
    }) as SendScopedResponse)
  assert.match(reply, /^这次任务没有完成/)
  assert.notEqual(reply, 'candidate output')
})
