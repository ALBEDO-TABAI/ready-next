import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexDefaultBootRecoveryActions,
} from '../main/modules/agent-control/codex-runtime/codex-boot-recovery-actions'
import type {
  CodexBindingRecoveryMember,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import type {
  CodexNativeRuntime,
  CodexThread,
  CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'

const threadMember: CodexBindingRecoveryMember = {
  reservationSetId: 'set-thread',
  reservationId: 'member-thread',
  scopeId: 'scope-thread',
  method: 'thread/start',
  requiredMemberCount: 2,
  state: 'recovery_held',
  bindingId: 'binding-thread',
  connectionEpoch: 'old-epoch',
  rpcId: 1,
  crashSeam: 3,
}

const turnMember: CodexBindingRecoveryMember = {
  reservationSetId: 'set-turn',
  reservationId: 'member-turn',
  scopeId: 'scope-turn',
  method: 'turn/start',
  requiredMemberCount: 1,
  state: 'recovery_held',
  bindingId: 'run-turn',
  connectionEpoch: 'old-epoch',
  rpcId: 2,
  crashSeam: 6,
}

function turn(id: string, clientId: string): CodexTurn {
  return {
    id,
    items: [{ type: 'userMessage', id: `user-${id}`, clientId, content: [] }],
    status: 'completed',
    error: null,
  }
}

function thread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: 'thread-native',
    sessionId: 'thread-native',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/tmp/isolated-thread',
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    turns: [],
    ...overrides,
  }
}

function actions(input: {
  threadList?: Pick<CodexNativeRuntime, 'threadList'>['threadList']
  threadRead?: Pick<CodexNativeRuntime, 'threadRead'>['threadRead']
  prove?: (stableReadbackEvidenceDigest: string) => Promise<
    { proven: false } | { proven: true; evidenceDigest: string }
  >
}) {
  const held: string[] = []
  const runtime = {
    threadList: input.threadList || (async () => ({ data: [], nextCursor: null })),
    threadRead: input.threadRead || (async ({ threadId }) => ({ thread: thread({ id: threadId }) })),
  }
  return {
    held,
    value: new CodexDefaultBootRecoveryActions({
      runtime,
      repository: {
        readStartInboundIdentity(method) {
          return method === 'thread/start'
            ? { method, expectedCwd: '/tmp/isolated-thread' }
            : { method, threadId: 'thread-native', clientUserMessageId: 'client-turn' }
        },
      },
      pinnedThreadSource: 'vscode',
      threadListLimit: 100,
      stableZeroReadCount: 3,
      async waitBetweenZeroReads() {},
      heldStartDispatcher: {
        async dispatch({ member }) { held.push(member.bindingId); return 'pending' },
      },
      absenceProof: {
        async prove({ stableReadbackEvidenceDigest }) {
          return input.prove?.(stableReadbackEvidenceDigest) || { proven: false }
        },
      },
      hostFailureTerminal: {
        async commit(failure) {
          return {
            productTerminalDigest: `terminal-${failure.readyRunId}`,
            closeoutAt: '2026-08-07T00:00:00.000Z',
          }
        },
        async deliver() {},
      },
      manualCompaction: { async reconcile() {} },
      productFence: { async reconcile() {} },
    }),
  }
}

test('boot recovery uniquely resolves thread and turn starts by pinned native identity', async () => {
  const root = thread({ turns: [turn('turn-native', 'client-turn')] })
  const fixture = actions({
    async threadList() { return { data: [root], nextCursor: null } },
    async threadRead() { return { thread: root } },
  })
  const threadResult = await fixture.value.resolveIntentStart({
    member: threadMember,
    registry: {} as never,
  })
  assert.equal(threadResult.resolution, 'accepted')
  if (threadResult.resolution !== 'accepted') throw new Error('thread readback not accepted')
  assert.equal(threadResult.nativeId, 'thread-native')
  assert.deepEqual(threadResult.nativeResult, { thread: root, instructionSources: [] })
  assert.match(threadResult.evidenceDigest, /^[a-f0-9]{64}$/)

  const turnResult = await fixture.value.resolveIntentStart({
    member: turnMember,
    registry: {} as never,
  })
  assert.equal(turnResult.resolution, 'accepted')
  if (turnResult.resolution !== 'accepted') throw new Error('turn readback not accepted')
  assert.equal(turnResult.nativeId, 'turn-native')
  assert.deepEqual(turnResult.nativeResult, { turn: root.turns[0] })
  assert.match(turnResult.evidenceDigest, /^[a-f0-9]{64}$/)
})

test('stable zero remains unknown without old-process proof and becomes absent only with proof', async () => {
  let zeroReads = 0
  const unknown = actions({
    async threadList() { zeroReads += 1; return { data: [], nextCursor: null } },
  })
  const unknownResult = await unknown.value.resolveIntentStart({
    member: threadMember,
    registry: {} as never,
  })
  assert.equal(unknownResult.resolution, 'unknown')
  assert.equal(zeroReads, 3)

  const proven = actions({
    async threadRead() { return { thread: thread() } },
    async prove(digest) {
      assert.match(digest, /^[a-f0-9]{64}$/)
      return { proven: true, evidenceDigest: 'old-process-zero-plus-stable-readback' }
    },
  })
  assert.deepEqual(await proven.value.resolveIntentStart({
    member: turnMember,
    registry: {} as never,
  }), {
    resolution: 'proven_absent',
    evidenceDigest: 'old-process-zero-plus-stable-readback',
  })
})

test('ambiguous readback blocks the binding and held dispatch is forwarded once', async () => {
  let absenceProofCalls = 0
  const root = thread()
  const fixture = actions({
    async threadList() { return { data: [root, { ...root, id: 'thread-second', sessionId: 'thread-second' }], nextCursor: null } },
    async prove() { absenceProofCalls += 1; return { proven: true, evidenceDigest: 'must-not-run' } },
  })
  const result = await fixture.value.resolveIntentStart({
    member: threadMember,
    registry: {} as never,
  })
  assert.equal(result.resolution, 'unknown')
  assert.equal(absenceProofCalls, 0)
  assert.equal(await fixture.value.dispatchHeldStart({
    member: { ...threadMember, state: 'held', connectionEpoch: null, rpcId: null, crashSeam: 1 },
    registry: {} as never,
  }), 'pending')
  assert.deepEqual(fixture.held, ['binding-thread'])
})

test('native read failure becomes binding-local unknown evidence', async () => {
  const fixture = actions({
    async threadList() { throw new Error('native_thread_list_unavailable') },
  })
  const result = await fixture.value.resolveIntentStart({
    member: threadMember,
    registry: {} as never,
  })
  assert.equal(result.resolution, 'unknown')
  assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/)
})
