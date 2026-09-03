import assert from 'node:assert/strict'
import test from 'node:test'

import {
  preflightExplicitRetryControl,
  validateExplicitRetryControl,
} from '../main/modules/agent-control/codex-runtime/codex-explicit-retry-control'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'

const scope = {
  id: 'scope-1', source_kind: 'local', source_id: 'app', thread_key: 'scope-1',
  meta_json: JSON.stringify({ actionAuthorizationMode: 'ask' }),
}

function request(content = '再试一次'): SendScopedRequest {
  return {
    scopeId: 'scope-1', requestId: 'request-1', message: content,
    expectedMessageVisibilityEpoch: 0,
    userMessage: {
      id: 'message-1', content, timestamp: '2026-09-02T00:00:00.000Z',
      meta: {
        sourceKind: 'local', sourceId: 'app', threadKey: 'scope-1',
        direction: 'local-input', workbenchMode: 'browser', actionAuthorizationMode: 'ask',
      },
      attachmentConfirmation: {
        selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0,
      },
    },
    explicitRetry: { predecessorRunId: 'run-1', predecessorPresentationDigest: 'a'.repeat(64) },
  }
}

test('semantic retry rejection is a typed zero-persistence response', () => {
  const rejected = preflightExplicitRetryControl({ request: request('新任务'), scope })
  assert.ok(rejected)
  assert.equal(rejected?.disposition, 'rejected_before_persistence')
  assert.equal(rejected?.preserveInput, true)
  assert.equal(rejected?.persistence.message, 'skipped')
  assert.equal(rejected?.errorKind, 'explicit_retry_control_invalid')
})

test('only the exact control envelope can pass the preflight', () => {
  const candidate = request()
  assert.equal(validateExplicitRetryControl({ request: candidate, scope }).ok, true)
  assert.equal(preflightExplicitRetryControl({ request: candidate, scope }), null)
})


test('continuation and new instructions are never accepted as exact Retry controls', () => {
  for (const text of ['继续', '接着做', 'continue', 'resume', '重试并总结另一个网页']) {
    const rejected = preflightExplicitRetryControl({ request: request(text), scope })
    assert.equal(rejected?.errorKind, 'explicit_retry_control_invalid', text)
    assert.equal(rejected?.persistence.message, 'skipped', text)
  }
})
