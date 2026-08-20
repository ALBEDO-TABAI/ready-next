import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import {
  _readyMemoryGroupChannelsForTest,
  readyMemoryGroup,
  type ReadyMemoryGroupDeps,
} from '../main/modules/claude-bridge/ipc/ready-memory-group'
import {
  parseReadyMemoryReadRequest,
  type ReadyMemoryView,
} from '../shared/ready-memory'

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => unknown

function fixture(): ReadyMemoryView {
  return {
    useMemories: true,
    generateMemories: false,
    automaticGenerationAvailable: false,
    conversationId: null,
    contributeToMemories: null,
    entries: [],
    pendingGenerationJobs: 0,
    unresolvedGenerationJobs: 0,
  }
}

function harness() {
  const handlers = new Map<string, Handler>()
  const ipc = {
    handle(channel: string, handler: Handler) { handlers.set(channel, handler) },
    removeHandler(channel: string) { handlers.delete(channel) },
  } as unknown as IpcMain
  const deps: ReadyMemoryGroupDeps = {
    read: () => fixture(),
    setGlobalPolicy: () => fixture(),
    setConversationPolicy: () => fixture(),
    add: () => fixture(),
    update: () => fixture(),
    pin: () => fixture(),
    delete: () => fixture(),
    reset: () => fixture(),
  }
  readyMemoryGroup.register(ipc, deps)
  return { handlers, deps }
}

test('Ready memory group owns one exact user-management IPC surface', () => {
  const { handlers } = harness()
  assert.deepEqual([...handlers.keys()].sort(), [..._readyMemoryGroupChannelsForTest].sort())
  assert.equal(handlers.has('agent:createMemory'), false)
  assert.equal(handlers.has('agent:searchMemory'), false)
})

test('Ready memory boundary parsing works when the preload context forbids generated code', () => {
  const unsafeSchema = z.object({ value: z.string() })
  const originalFunction = globalThis.Function
  const originalAllowsEval = Object.getOwnPropertyDescriptor(z.core.util.allowsEval, 'value')!
  Object.defineProperty(z.core.util.allowsEval, 'value', {
    configurable: true,
    writable: true,
    value: true,
  })
  Object.defineProperty(globalThis, 'Function', {
    configurable: true,
    writable: true,
    value: function blockedFunction(): never {
      throw new EvalError('generated code blocked by preload context')
    },
  })
  try {
    assert.throws(
      () => unsafeSchema.parse({ value: 'unsafe' }),
      /generated code blocked by preload context/,
    )
    assert.deepEqual(parseReadyMemoryReadRequest({}), {})
  } finally {
    Object.defineProperty(globalThis, 'Function', {
      configurable: true,
      writable: true,
      value: originalFunction,
    })
    Object.defineProperty(z.core.util.allowsEval, 'value', originalAllowsEval)
  }
})

test('automatic memory generation cannot be enabled without explicit cost consent', async () => {
  const { handlers, deps } = harness()
  let calls = 0
  deps.setGlobalPolicy = () => {
    calls += 1
    return fixture()
  }
  const handler = handlers.get('agent:setReadyMemoryGlobalPolicy')!
  const rejected = await handler({} as IpcMainInvokeEvent, { generateMemories: true }) as {
    success: boolean
  }
  assert.equal(rejected.success, false)
  assert.equal(calls, 0)
  const accepted = await handler({} as IpcMainInvokeEvent, {
    generateMemories: true,
    acknowledgeModelCost: true,
  }) as { success: boolean }
  assert.equal(accepted.success, true)
  assert.equal(calls, 1)
})

test('manual memory mutation rejects legacy and extended payloads before repository effects', async () => {
  const { handlers, deps } = harness()
  let calls = 0
  deps.add = () => {
    calls += 1
    return fixture()
  }
  const handler = handlers.get('agent:addReadyMemory')!
  for (const payload of [
    { text: 'remember this' },
    { category: 'fact', content: '' },
    { category: 'fact', content: 'remember this', agentId: 'butler' },
  ]) {
    const result = await handler({} as IpcMainInvokeEvent, payload) as { success: boolean }
    assert.equal(result.success, false)
  }
  assert.equal(calls, 0)
  const result = await handler({} as IpcMainInvokeEvent, {
    category: 'fact', content: 'remember this', pinned: true,
  }) as { success: boolean }
  assert.equal(result.success, true)
  assert.equal(calls, 1)
})
