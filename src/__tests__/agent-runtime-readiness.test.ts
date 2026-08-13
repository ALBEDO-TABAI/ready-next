import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseAgentRuntimeReadinessSnapshot,
  type AgentRuntimeReadinessSnapshot,
} from '../shared/ipc-contracts/agent-runtime-readiness'
import {
  beginAgentRuntimeRegistration,
  publishAgentRuntimeReady,
  registerAgentRuntimeReadinessIPC,
} from '../main/modules/claude-bridge/agent-runtime-readiness'
import { installAgentRuntimeReadyHydration } from '../renderer/modules/agent/agent-runtime-ready'

test('main readiness pull is registered before runtime and push advances one boot generation', () => {
  let read: (() => AgentRuntimeReadinessSnapshot) | null = null
  const sent: Array<{ channel: string; payload: AgentRuntimeReadinessSnapshot }> = []
  registerAgentRuntimeReadinessIPC({
    removeHandler() {},
    handle(_channel: string, handler: () => AgentRuntimeReadinessSnapshot) { read = handler },
  } as never)

  assert.deepEqual(read?.(), { ready: false, bootGeneration: 0 })
  beginAgentRuntimeRegistration()
  const first = publishAgentRuntimeReady({
    isDestroyed: () => false,
    send: (channel: string, payload: AgentRuntimeReadinessSnapshot) => sent.push({ channel, payload }),
  } as never)
  assert.deepEqual(first, { ready: true, bootGeneration: 1 })
  assert.deepEqual(read?.(), first)
  assert.deepEqual(sent, [{ channel: 'agent:runtimeReady', payload: first }])
})

test('renderer consumes a lost push through pull and de-duplicates the same generation', async () => {
  let listener: ((snapshot: AgentRuntimeReadinessSnapshot) => void) | null = null
  const hydrated: number[] = []
  const off = installAgentRuntimeReadyHydration({
    read: async () => ({ ready: true, bootGeneration: 3 }),
    subscribe: (next) => { listener = next; return () => { listener = null } },
    hydrate: async (snapshot) => { hydrated.push(snapshot.bootGeneration) },
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(hydrated, [3])
  listener?.({ ready: true, bootGeneration: 3 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(hydrated, [3])
  off()
  assert.equal(listener, null)
})

test('renderer serializes newer runtime generations after an in-flight hydrate', async () => {
  let listener: ((snapshot: AgentRuntimeReadinessSnapshot) => void) | null = null
  let releaseFirst!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const hydrated: number[] = []
  installAgentRuntimeReadyHydration({
    read: async () => ({ ready: false, bootGeneration: 0 }),
    subscribe: (next) => { listener = next; return () => {} },
    hydrate: async (snapshot) => {
      hydrated.push(snapshot.bootGeneration)
      if (snapshot.bootGeneration === 1) await first
    },
  })

  listener?.({ ready: true, bootGeneration: 1 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  listener?.({ ready: true, bootGeneration: 2 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(hydrated, [1])
  releaseFirst()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(hydrated, [1, 2])
})

test('readiness parser rejects ready generation zero and malformed values', () => {
  assert.throws(() => parseAgentRuntimeReadinessSnapshot({ ready: true, bootGeneration: 0 }))
  assert.throws(() => parseAgentRuntimeReadinessSnapshot({ ready: false, bootGeneration: -1 }))
  assert.deepEqual(
    parseAgentRuntimeReadinessSnapshot({ ready: false, bootGeneration: 0 }),
    { ready: false, bootGeneration: 0 },
  )
})
