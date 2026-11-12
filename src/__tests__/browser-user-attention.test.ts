import assert from 'node:assert/strict'
import test from 'node:test'
import { readBrowserUserAttention } from '../main/modules/browser-engine/browser-user-attention'
import { sendBrowserAttentionInput } from '../main/modules/agent-control/runtime-core/browser-attention-action'
import { parseBrowserAttentionAction, type BrowserAttentionReason } from '../shared/browser-user-attention'
import type { BrowserCapabilityTaskHandle } from '../main/modules/browser-engine/capability-types'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'

const task: BrowserCapabilityTaskHandle = { taskId: 'browser-1', parentTaskId: 'task-1', createdByRunId: 'run-1',
  kind: 'browser_workflow', status: 'failed', progress: { total: 1, completed: 0, failed: 1, currentLabel: null } }
const request = {
  browserTaskId: task.taskId, attentionId: 'attention-1', expectedMessageVisibilityEpoch: 0,
  actionAdmissionRef: { headProjectionDigest: 'a'.repeat(64),
    actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 1 },
    actionHeadIdentity: { aliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'thread-1', headRevision: 1 } },
}
function attention(reason: BrowserAttentionReason) {
  return readBrowserUserAttention(task, { userAttention: { id: 'attention-1', reason, tabId: 'tab-1', physicalTargetToken: 'physical-1' } })!
}
for (const reason of ['login', 'captcha', 'takeover', 'review_rejected'] as const) {
  test(`${reason} action sends one fixed new user input through ordinary admission`, async () => {
    const state = attention(reason)
    const sent: SendScopedRequest[] = []
    await assert.rejects(sendBrowserAttentionInput(parseBrowserAttentionAction(request), {
      readAttention: () => state,
      readPhysicalTarget: () => 'physical-1',
      readParent: () => ({ scopeId: 'scope-1', runId: 'run-1', messageVisibilityEpoch: 0 }),
      readScope: () => ({ source_kind: 'local', message_visibility_epoch: 0 }),
      messageExists: () => false,
      send: async input => { sent.push(input); throw new Error('ordinary_admission_rejected') },
    }), /ordinary_admission_rejected/)
    assert.equal(sent.length, 1)
    const input = sent[0]
    assert.equal(input.message, state.action.text)
    assert.equal(input.userMessage.content, input.message)
    assert.match(input.userMessage.content, /task-1.*browser-1.*run-1/)
    assert.equal(input.explicitRetry, undefined)
    assert.equal(input.userMessage.meta.browserTaskRef && typeof input.userMessage.meta.browserTaskRef, 'object')
    assert.deepEqual(input.actionAdmissionRef, request.actionAdmissionRef)
  })
}

test('old attention, reset scope, foreign run, remote scope and repeated click never send', async () => {
  const base = {
    readAttention: () => attention('takeover'),
    readPhysicalTarget: () => 'physical-1',
    readParent: () => ({ scopeId: 'scope-1', runId: 'run-1', messageVisibilityEpoch: 0 }),
    readScope: () => ({ source_kind: 'local', message_visibility_epoch: 0 }),
    messageExists: () => false,
    send: async () => { assert.fail('must not send') },
  }
  await assert.rejects(sendBrowserAttentionInput({ ...request, attentionId: 'old' }, base), /stale/)
  await assert.rejects(sendBrowserAttentionInput(request, { ...base, readScope: () => ({ source_kind: 'local', message_visibility_epoch: 1 }) }), /scope_changed/)
  await assert.rejects(sendBrowserAttentionInput(request, { ...base, readParent: () => ({ scopeId: 'scope-1', runId: 'new', messageVisibilityEpoch: 0 }) }), /scope_changed/)
  await assert.rejects(sendBrowserAttentionInput(request, { ...base, readScope: () => ({ source_kind: 'remote', message_visibility_epoch: 0 }) }), /scope_changed/)
  await assert.rejects(sendBrowserAttentionInput(request, { ...base, messageExists: () => true }), /already_sent/)
  await assert.rejects(sendBrowserAttentionInput(request, { ...base, readPhysicalTarget: () => 'replaced' }), /target_changed/)
})

test('cold read derives review rejection from committed task result and rejects corrupt attention', () => {
  assert.equal(readBrowserUserAttention({ ...task, result: { userAttentionReason: 'review_rejected' } }, {})?.reason, 'review_rejected')
  assert.equal(readBrowserUserAttention({ ...task, status: 'completed' }, {}) , null)
  assert.equal(readBrowserUserAttention(task, {}), null)
  assert.throws(() => readBrowserUserAttention(task, { userAttention: { reason: 'guessed' } }))
  assert.throws(() => parseBrowserAttentionAction({ ...request, actionAdmissionRef: undefined }))
  assert.throws(() => parseBrowserAttentionAction({ ...request, message: 'injected' }))
})

test('persisted attention input invalidates the original task only; rejected input emits nothing', async () => {
  const changed: string[] = []
  let persisted = false
  const deps = {
    readAttention: () => attention('login'),
    readPhysicalTarget: () => 'physical-1',
    readParent: () => ({ scopeId: 'scope-1', runId: 'run-1', messageVisibilityEpoch: 0 }),
    readScope: () => ({ source_kind: 'local', message_visibility_epoch: 0 }),
    messageExists: () => persisted,
    changed: (id: string) => { changed.push(id) },
    send: async () => { throw new Error('rejected_before_persistence') },
  }
  await assert.rejects(sendBrowserAttentionInput(request, deps), /rejected_before_persistence/)
  assert.deepEqual(changed, [])
  await assert.rejects(sendBrowserAttentionInput(request, { ...deps, send: async () => {
    persisted = true
    throw new Error('run_failed_after_user_message_saved')
  } }), /run_failed_after_user_message_saved/)
  assert.deepEqual(changed, ['browser-1'])
  await assert.rejects(sendBrowserAttentionInput(request, deps), /already_sent/)
  assert.deepEqual(changed, ['browser-1'])
})

test('successful attention action emits one invalidation after the ordinary send result', async () => {
  let saved = false
  const events: string[] = []
  const result = await sendBrowserAttentionInput(request, {
    readAttention: () => attention('takeover'), readPhysicalTarget: () => 'physical-1',
    readParent: () => ({ scopeId: 'scope-1', runId: 'run-1', messageVisibilityEpoch: 0 }),
    readScope: () => ({ source_kind: 'local', message_visibility_epoch: 0 }),
    messageExists: () => saved, changed: id => { events.push(`changed:${id}`) },
    send: async input => {
      saved = true
      events.push(`sent:${input.scopeId}`)
      return { success: true, disposition: 'terminal_success', ownerRunId: 'new-run', aliasGeneration: 1, retryableByUser: false,
        persistence: { scope: 'pre-existing', message: 'persisted', attachments: 'none', inputAttachments: 'none' },
        responseText: 'done', canonicalMessage: { id: 'answer', conversationId: 'scope-1', role: 'assistant', content: 'done', timestamp: '2026-11-12T00:00:00Z', meta: {} }, canonicalMessageDigest: 'digest' }
    },
  })
  assert.equal(result.success, true)
  assert.deepEqual(events, ['sent:scope-1', 'changed:browser-1'])
})

test('attention consumption publishes at ingress persistence without waiting for the new run, and unsubscribes on failure', async () => {
  let admitted: (() => void) | undefined, finish!: () => void, saved = false
  const changed: string[] = []
  const pending = sendBrowserAttentionInput(request, {
    readAttention: () => attention('login'), readPhysicalTarget: () => 'physical-1',
    readParent: () => ({ scopeId: 'scope-1', runId: 'run-1', messageVisibilityEpoch: 0 }),
    readScope: () => ({ source_kind: 'local', message_visibility_epoch: 0 }),
    messageExists: () => saved, changed: id => { changed.push(id) },
    watchPersisted: (scopeId, messageId, handler) => {
      assert.equal(scopeId, 'scope-1')
      assert.equal(messageId, 'browser-help:browser-1:attention-1')
      admitted = handler
      return () => { admitted = undefined }
    },
    send: async () => {
      saved = true
      admitted!()
      await new Promise<void>(resolve => { finish = resolve })
      throw new Error('new run finished')
    },
  })
  assert.deepEqual(changed, ['browser-1'], 'the old attention is cleared while the new run is still pending')
  finish()
  await assert.rejects(pending, /new run finished/)
  assert.deepEqual(changed, ['browser-1', 'browser-1'])
  assert.equal(admitted, undefined)
})
