import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeCodexNativeNotification,
  type CodexNativeRuntime,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'

test('CodexNativeRuntime exposes only pinned native lifecycle methods', () => {
  const approved: Array<keyof CodexNativeRuntime> = [
    'initialize',
    'threadStart',
    'threadRead',
    'threadResume',
    'threadArchive',
    'turnStart',
    'turnInterrupt',
    'threadCompactStart',
    'subscribe',
  ]
  assert.equal(approved.includes('sendMessage' as keyof CodexNativeRuntime), false)
  assert.equal(approved.includes('newSession' as keyof CodexNativeRuntime), false)
  assert.equal(approved.includes('compactSession' as keyof CodexNativeRuntime), false)
  assert.equal(approved.includes('setSystemPrompt' as keyof CodexNativeRuntime), false)
})

test('native notification normalization accepts pinned item and terminal frames', () => {
  const item = normalizeCodexNativeNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 1,
      item: {
        type: 'agentMessage',
        id: 'final-1',
        text: 'done',
        phase: 'final_answer',
      },
    },
  })
  assert.equal(item.kind, 'accepted')

  const terminal = normalizeCodexNativeNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        items: [],
        status: 'completed',
        error: null,
      },
    },
  })
  assert.equal(terminal.kind, 'accepted')
})

test('thread started normalization requires the pinned stable thread fields', () => {
  const thread = {
    id: 'thread-1',
    sessionId: 'thread-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/isolated/thread-1',
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.0.0-test',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 2,
    turns: [],
  }
  assert.equal(normalizeCodexNativeNotification({
    method: 'thread/started',
    params: { thread },
  }).kind, 'accepted')

  for (const source of [
    { custom: 'ready-e1' },
    { subAgent: 'review' },
    {
      subAgent: {
        thread_spawn: {
          depth: 1,
          parent_thread_id: 'thread-parent',
          agent_nickname: 'reviewer',
          agent_path: null,
          agent_role: 'review',
        },
      },
    },
    { subAgent: { other: 'future-native-agent' } },
  ]) {
    assert.equal(normalizeCodexNativeNotification({
      method: 'thread/started',
      params: { thread: { ...thread, source } },
    }).kind, 'accepted')
  }

  for (const key of [
    'id',
    'sessionId',
    'cwd',
    'source',
    'modelProvider',
    'cliVersion',
    'createdAt',
    'ephemeral',
    'preview',
    'status',
    'updatedAt',
    'turns',
  ] as const) {
    const malformed = { ...thread } as Record<string, unknown>
    delete malformed[key]
    assert.deepEqual(normalizeCodexNativeNotification({
      method: 'thread/started',
      params: { thread: malformed },
    }), { kind: 'invalid', code: 'invalid_params' }, key)
  }
})

test('thread normalization rejects forged optional identities and malformed sources', () => {
  const thread = {
    id: 'thread-1',
    sessionId: 'thread-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/isolated/thread-1',
    source: 'appServer',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.0.0-test',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 2,
    turns: [],
  }
  const malformedThreads = [
    { ...thread, parentThreadId: 7 },
    { ...thread, forkedFromId: false },
    { ...thread, threadSource: { kind: 'forged' } },
    { ...thread, createdAt: 1e100 },
    { ...thread, updatedAt: 1e100 },
    { ...thread, recencyAt: 1e100 },
    { ...thread, isPinned: 'true' },
    { ...thread, gitInfo: { sha: 'abc', branch: 'main', originUrl: 7 } },
    { ...thread, source: 'custom' },
    { ...thread, source: 'subAgent' },
    { ...thread, source: { custom: 7 } },
    { ...thread, source: { custom: 'ready-e1', extra: true } },
    { ...thread, source: { subAgent: 'future-agent-kind' } },
    {
      ...thread,
      source: { subAgent: { thread_spawn: { depth: 1.5, parent_thread_id: 'thread-parent' } } },
    },
  ]
  for (const malformed of malformedThreads) {
    assert.deepEqual(normalizeCodexNativeNotification({
      method: 'thread/started',
      params: { thread: malformed },
    }), { kind: 'invalid', code: 'invalid_params' })
  }
})

test('native notification normalization accepts only the pinned error frame shape', () => {
  const accepted = normalizeCodexNativeNotification({
    method: 'error',
    params: {
      error: {
        message: 'native transport closed',
        additionalDetails: 'socket reset',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  })
  assert.equal(accepted.kind, 'accepted')
  if (accepted.kind === 'accepted') {
    assert.deepEqual(accepted.notification, {
      method: 'error',
      params: {
        error: {
          message: 'native transport closed',
          additionalDetails: 'socket reset',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        },
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
      },
    })
  }

  const invalidFrames = [
    { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, message: 'flat legacy shape' },
    { error: { message: 'missing thread' }, turnId: 'turn-1', willRetry: false },
    { error: { message: 'missing turn' }, threadId: 'thread-1', willRetry: false },
    { error: { message: 'missing retry flag' }, threadId: 'thread-1', turnId: 'turn-1' },
    {
      error: { message: 'bad error info', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: '502' } } },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
    {
      error: { message: 'unknown error info', codexErrorInfo: { futureError: {} } },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  ]
  for (const params of invalidFrames) {
    assert.deepEqual(normalizeCodexNativeNotification({ method: 'error', params }), {
      kind: 'invalid',
      code: 'invalid_params',
    })
  }
})

test('native notification normalization ignores passive telemetry but rejects unknown active methods', () => {
  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'thread/tokenUsage/updated',
    params: {},
  }), { kind: 'ignored', method: 'thread/tokenUsage/updated' })
  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'thread/rollback/completed',
    params: {},
  }), { kind: 'invalid', code: 'unknown_method' })
  assert.deepEqual(normalizeCodexNativeNotification({ method: 'turn/completed', params: {} }), {
    kind: 'invalid',
    code: 'invalid_params',
  })
})

test('native notification normalization rejects unknown or unsupported active item types', () => {
  for (const type of ['futureEffectfulMutation', 'commandExecution']) {
    assert.deepEqual(normalizeCodexNativeNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type, id: `item-${type}` },
      },
    }), { kind: 'invalid', code: 'invalid_params' })
  }

  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: 1,
      item: { type: 'reasoning', id: 'reasoning-1' },
    },
  }), {
    kind: 'accepted',
    notification: {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item: { type: 'other', id: 'reasoning-1', nativeType: 'reasoning' },
      },
    },
  })
})

test('native notification normalization closes malformed active item fields', () => {
  const malformedItems = [
    {
      type: 'dynamicToolCall',
      id: 'tool-invalid-status',
      tool: 'ready_read',
      arguments: {},
      status: 'running',
    },
    {
      type: 'dynamicToolCall',
      id: 'tool-missing-arguments',
      tool: 'ready_read',
      status: 'completed',
    },
    {
      type: 'userMessage',
      id: 'user-invalid-content',
      content: [{ type: 'shell', command: 'echo no' }],
    },
    {
      type: 'hookPrompt',
      id: 'hook-invalid-fragments',
      fragments: [{ hookRunId: 'hook-1' }],
    },
    {
      type: 'plan',
      id: 'plan-missing-text',
    },
    {
      type: 'reasoning',
      id: 'reasoning-invalid-summary',
      summary: ['valid', 7],
    },
  ]

  for (const item of malformedItems) {
    assert.deepEqual(normalizeCodexNativeNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1, item },
    }), { kind: 'invalid', code: 'invalid_params' })
  }

  const validTool = normalizeCodexNativeNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 1,
      item: {
        type: 'dynamicToolCall',
        id: 'tool-valid',
        tool: 'ready_read',
        namespace: null,
        arguments: { resourceId: 'resource-1' },
        status: 'completed',
        success: true,
        durationMs: 5,
        contentItems: [{ type: 'inputText', text: 'readback' }],
      },
    },
  })
  assert.equal(validTool.kind, 'accepted')

  for (const [method, timestampKey] of [
    ['item/started', 'startedAtMs'],
    ['item/completed', 'completedAtMs'],
  ] as const) {
    assert.deepEqual(normalizeCodexNativeNotification({
      method,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        [timestampKey]: 1e100,
        item: { type: 'contextCompaction', id: 'item-1' },
      },
    }), { kind: 'invalid', code: 'invalid_params' })
  }

  assert.deepEqual(normalizeCodexNativeNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        items: [],
        status: 'completed',
        error: null,
        completedAt: 1e100,
      },
    },
  }), { kind: 'invalid', code: 'invalid_params' })
})
