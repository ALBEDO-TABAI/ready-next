import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexRetryAuthorizationRequest } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'

const control = {
  scopeId: 'scope-1', requestId: 'request-r', message: '重试',
  userMessage: {
    id: 'message-r', content: '重试', timestamp: '2026-09-02T00:00:00.000Z',
    meta: {}, attachmentConfirmation: {
      selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0,
    },
  },
  explicitRetry: { predecessorRunId: 'run-b', predecessorPresentationDigest: 'a'.repeat(64) },
} satisfies SendScopedRequest

test('semantic consumers receive B exactly once and never receive retry control R', () => {
  const effective = buildCodexRetryAuthorizationRequest(control, [
    { type: 'text', text: 'B', text_elements: [] },
  ])
  assert.equal(effective.message, 'B')
  assert.equal(effective.userMessage.content, 'B')
  assert.equal(JSON.stringify(effective).includes('重试'), false)
})

test('nontext task roots cannot be disguised as a zero-resource retry', () => {
  assert.throws(() => buildCodexRetryAuthorizationRequest(control, [
    { type: 'image', url: 'https://example.invalid/a.png', detail: null },
  ]), /requires_restatement/)
})
