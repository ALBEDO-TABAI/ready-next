import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexLiveStartRejectionResolver } from '../main/modules/agent-control/codex-runtime/codex-live-start-rejection-resolver'

const rootThread = {
  id: 'thread-1',
  sessionId: 'thread-1',
  parentThreadId: null,
  forkedFromId: null,
  cwd: '/tmp/thread-1',
  source: 'vscode' as const,
  threadSource: null,
  modelProvider: 'ready_gateway',
  turns: [],
}

function createResolver(input: {
  live?: boolean
  listed?: typeof rootThread[]
  turnItems?: Array<{ type: 'userMessage'; clientId: string }>
}) {
  let reads = 0
  const resolver = new CodexLiveStartRejectionResolver({
    runtime: {
      async threadList() {
        reads += 1
        return { data: input.listed || [], nextCursor: null }
      },
      async threadRead({ threadId }) {
        reads += 1
        return {
          thread: {
            ...rootThread,
            id: threadId,
            sessionId: threadId,
            turns: [{ id: 'turn-1', status: 'completed' as const, items: input.turnItems || [] }],
          },
        }
      },
    },
    repository: {
      readStartInboundIdentity(method) {
        return method === 'thread/start'
          ? { method, expectedCwd: '/tmp/thread-1' }
          : { method, threadId: 'thread-1', clientUserMessageId: 'message-1' }
      },
    },
    pinnedThreadSource: 'vscode',
    threadListLimit: 100,
    stableZeroReadCount: 2,
    waitBetweenZeroReads: async () => undefined,
    isConnectionLive: () => input.live !== false,
  })
  return { resolver, reads: () => reads }
}

test('typed rejection plus two same-connection zero reads proves start absent', async () => {
  const { resolver, reads } = createResolver({})
  const result = await resolver.resolveTypedRejection({
    connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start', bindingId: 'binding-1',
    rpcError: { code: -32602, message: 'invalid params' }, responseDigest: 'response-digest',
  })
  assert.equal(result.resolution, 'proven_absent')
  assert.equal(reads(), 2)
  if (result.resolution === 'proven_absent') assert.equal(result.evidenceDigest.length, 64)
})

test('untyped rejection, dead connection, or matching native identity remains unknown', async () => {
  const untyped = createResolver({})
  assert.deepEqual(await untyped.resolver.resolveTypedRejection({
    connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start', bindingId: 'binding-1',
    rpcError: 'invalid params', responseDigest: 'response-digest',
  }), { resolution: 'unknown' })
  assert.equal(untyped.reads(), 0)

  const dead = createResolver({ live: false })
  assert.deepEqual(await dead.resolver.resolveTypedRejection({
    connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start', bindingId: 'binding-1',
    rpcError: { code: -32602, message: 'invalid params' }, responseDigest: 'response-digest',
  }), { resolution: 'unknown' })
  assert.equal(dead.reads(), 0)

  const existing = createResolver({ listed: [rootThread] })
  assert.deepEqual(await existing.resolver.resolveTypedRejection({
    connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start', bindingId: 'binding-1',
    rpcError: { code: -32602, message: 'invalid params' }, responseDigest: 'response-digest',
  }), { resolution: 'unknown' })
  assert.equal(existing.reads(), 1)
})

test('turn rejection stays unknown when the client identity is present', async () => {
  const { resolver, reads } = createResolver({
    turnItems: [{ type: 'userMessage', clientId: 'message-1' }],
  })
  assert.deepEqual(await resolver.resolveTypedRejection({
    connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingId: 'run-1',
    rpcError: { code: -32602, message: 'invalid params' }, responseDigest: 'response-digest',
  }), { resolution: 'unknown' })
  assert.equal(reads(), 1)
})
