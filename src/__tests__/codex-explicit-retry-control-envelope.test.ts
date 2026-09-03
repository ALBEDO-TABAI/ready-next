import assert from 'node:assert/strict'
import test from 'node:test'

import { validateExplicitRetryControl } from '../main/modules/agent-control/codex-runtime/codex-explicit-retry-control'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'

const scope = {
  id: 'scope-1',
  source_kind: 'local',
  source_id: 'app',
  thread_key: 'scope-1',
  meta_json: JSON.stringify({ actionAuthorizationMode: 'ask' }),
}

function request(overrides: Partial<SendScopedRequest> = {}): SendScopedRequest {
  return {
    scopeId: 'scope-1',
    requestId: 'request-1',
    expectedMessageVisibilityEpoch: 0,
    message: '再试一次',
    userMessage: {
      id: 'message-1',
      content: '再试一次',
      timestamp: '2026-09-02T00:00:00.000Z',
      meta: {
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'scope-1',
        direction: 'local-input',
        workbenchMode: 'browser',
        actionAuthorizationMode: 'ask',
      },
      attachmentConfirmation: {
        selectedCount: 0,
        metadataCount: 0,
        inputIncludedCount: 0,
        inputFailedCount: 0,
      },
    },
    explicitRetry: {
      predecessorRunId: 'run-1',
      predecessorPresentationDigest: 'a'.repeat(64),
    },
    ...overrides,
  }
}

test('explicit retry accepts only a strict zero-resource control envelope', () => {
  assert.equal(validateExplicitRetryControl({ request: request(), scope }).ok, true)
})

test('explicit retry rejects new text, nontext input, resources, counts, and extra meta', () => {
  const cases: SendScopedRequest[] = [
    request({ message: '总结另一份文档' }),
    request({ message: [{ type: 'text', text: '再试一次' }] }),
    request({ resources: [{ kind: 'quoted_text', id: 'q', name: 'q', text: 'context' }] }),
    request({
      userMessage: {
        ...request().userMessage,
        attachmentConfirmation: {
          selectedCount: 1,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
    }),
    request({
      userMessage: {
        ...request().userMessage,
        meta: { ...request().userMessage.meta, attachments: [] },
      },
    }),
  ]
  for (const candidate of cases) {
    assert.equal(validateExplicitRetryControl({ request: candidate, scope }).ok, false)
  }
})
