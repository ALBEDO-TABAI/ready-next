import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import type { CodexNativeRuntime, CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import {
  createLifecycleStore,
  retireCodexAliasForClose,
} from '../main/modules/agent-control/codex-runtime/codex-product-lifecycle-store'

const child = {
  id: 'native-child', sessionId: 'native-child', parentThreadId: null,
  forkedFromId: 'native-source', cwd: '/isolated/child', source: 'vscode',
  threadSource: null, modelProvider: 'ready_gateway',
  status: { type: 'idle' }, turns: [],
} as CodexThread
const binding = {
  threadBindingId: 'binding-child', aliasId: 'alias', aliasGeneration: 2,
  readyScopeId: 'scope', codexThreadId: child.id, codexSessionId: child.id,
  isolatedThreadCwd: child.cwd, materializationKind: 'native_fork',
}

test('resume resolution consumes the confirmed fork source from durable materialization', async () => {
  let materializationState = 'confirmed'
  const reads: string[] = []
  const store = createLifecycleStore({
    repository: {
      readActiveAliasBinding: () => binding,
      readNativeForkMaterialization: (id: string) => {
        reads.push(id)
        return { sourceCodexThreadId: 'native-source', materializationState }
      },
    },
    loadedThreads: new Set(),
  } as unknown as Parameters<typeof createLifecycleStore>[0])
  const prepared = { readyToolHostIdentity: { scopeId: 'scope' } } as Parameters<
    typeof store.resolveThreadBinding
  >[1]
  assert.deepEqual(await store.resolveThreadBinding({ aliasId: 'alias', aliasGeneration: 2 }, prepared), {
    state: 'resume_required', threadId: child.id,
    expectedCwd: child.cwd, expectedForkedFromId: 'native-source',
  })
  assert.deepEqual(reads, ['binding-child'])
  materializationState = 'unknown'
  await assert.rejects(() => store.resolveThreadBinding({ aliasId: 'alias', aliasGeneration: 2 }, prepared),
    /native_protocol_error/)
})

test('idle fork close accepts only its confirmed durable source and then retires the exact alias', async () => {
  for (const forkedFromId of ['native-source', 'wrong-source', null]) {
    let retirements = 0
    let schedules = 0
    const loadedThreads = new Set([child.id])
    const repository = {
      readActiveAliasBinding: () => binding,
      readNativeForkMaterialization: () => ({
        sourceCodexThreadId: 'native-source', materializationState: 'confirmed',
      }),
      retireIdleAliasForClose: (input: { aliasId: string; expectedGeneration: number }) => {
        assert.equal(input.aliasId, 'alias')
        assert.equal(input.expectedGeneration, 2)
        retirements += 1
        return {
          aliasId: 'alias', retiredGeneration: 2, codexThreadId: child.id,
          transactionDigest: 'retirement', archiveIntentDigest: 'archive',
          scopeClosureEvidenceDigest: 'closure',
          lastCommittedReadyTerminalTransactionDigest: null, lastCommittedProductTerminalDigest: null,
        }
      },
    } as unknown as CodexBindingRepository
    const close = () => retireCodexAliasForClose({
      repository,
      nativeRuntime: { threadRead: async () => ({ thread: { ...child, forkedFromId } }) } as CodexNativeRuntime,
      loadedThreads,
      identity: { aliasId: 'alias', aliasGeneration: 2 },
      snapshot: 'idle_native_thread', retiredAt: '2026-09-03T00:00:00Z',
      scheduleThreadArchiveCleanup: () => { schedules += 1 },
      sealClosedConversationInOpenTransaction: () => undefined,
    })
    if (forkedFromId === 'native-source') {
      assert.equal((await close()).archiveDisposition, 'durable_cleanup_pending')
      assert.equal(retirements, 1)
      assert.equal(schedules, 1)
      assert.equal(loadedThreads.has(child.id), false)
    } else {
      await assert.rejects(close, /native_protocol_error/)
      assert.equal(retirements, 0)
      assert.equal(schedules, 0)
      assert.equal(loadedThreads.has(child.id), true)
    }
  }
})
