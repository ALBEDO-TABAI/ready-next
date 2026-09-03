import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codexUserInputSchema,
  normalizeCodexUserInput,
  type CodexUserInput,
} from '../main/modules/agent-control/codex-runtime/codex-user-input'
import { normalizeCodexNativeNotification } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexTurnInputBuilder } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

const allInputs: CodexUserInput[] = [
  { type: 'text', text: 'hello', text_elements: [] },
  { type: 'image', url: 'https://example.com/image.png', detail: null },
  { type: 'localImage', path: '/tmp/image.png', detail: 'original' },
  { type: 'audio', url: 'https://example.com/audio.wav' },
  { type: 'localAudio', path: '/tmp/audio.wav' },
  { type: 'skill', name: 'summary', path: '/tmp/skills/summary' },
  { type: 'mention', name: 'notes.txt', path: '/tmp/notes.txt' },
]

test('pinned Codex user inputs share one strict outgoing schema and one readback normalizer', () => {
  for (const input of allInputs) {
    assert.equal(codexUserInputSchema.safeParse(input).success, true, input.type)
    assert.deepEqual(normalizeCodexUserInput(input), input, input.type)
  }
  assert.deepEqual(normalizeCodexUserInput({ type: 'localImage', path: '/tmp/image.png' }), {
    type: 'localImage', path: '/tmp/image.png', detail: null,
  })
  assert.equal(normalizeCodexUserInput({ type: 'mention', name: '', path: '/tmp/x' }), null)
  assert.equal(codexUserInputSchema.safeParse({
    type: 'skill', name: 'x', path: '/tmp/x', body: 'must not cross the boundary',
  }).success, false)
})

test('thread item readback preserves every pinned Codex user input variant', () => {
  const notification = normalizeCodexNativeNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 1,
      item: {
        type: 'userMessage',
        id: 'message-1',
        clientId: 'client-1',
        content: allInputs,
      },
    },
  })
  assert.equal(notification.kind, 'accepted')
  if (notification.kind !== 'accepted' || notification.notification.method !== 'item/completed') return
  assert.deepEqual(notification.notification.params.item, {
    type: 'userMessage', id: 'message-1', clientId: 'client-1', content: allInputs,
  })
})

test('turn builder forwards native resource inputs without translating them into prompt text', () => {
  const result = new CodexTurnInputBuilder().build({
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: {
      messageId: 'message-1',
      input: [{ type: 'text', text: 'use the resources', text_elements: [] }],
    },
    explicitResourceEnvelope: { input: allInputs.slice(2), resourceRefs: [] },
    resourceAdditionalContext: [],
    actionAdmissionRef: {
      headProjectionDigest: 'f'.repeat(64),
      actionProjectionVersion: { scopeEpoch: 0, headGeneration: 1, actionProjectionSequence: 0 },
      actionHeadIdentity: { aliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'binding-1', headRevision: 1 },
    },
    uncommittedTailAssignments: [],
    supersededUncommittedItems: [],
  }, {
    threadId: 'thread-1',
    turnRequestId: 'turn-request-1',
    reasoningEffort: 'medium',
    readyRunId: 'run-1',
    toolSurfaceDigest: 'surface-1',
    turnContractDigest: 'turn-contract-1',
    upstreamProfileSnapshotDigest: 'profile-1',
    readyMemorySnapshot: disabledReadyMemorySnapshot(),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.params.input, [
    { type: 'text', text: 'use the resources', text_elements: [] },
    ...allInputs.slice(2),
  ])
})
