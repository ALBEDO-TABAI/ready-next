import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { LifecycleOperationFacts } from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import type {
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThread,
  CodexThreadStartParams,
  CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { CodexTurnInputBuilder, textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import {
  CodexTurnCollector,
  type CoreTurnCandidate,
} from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import {
  ReadyCodexLifecycleAdapter,
  ReadyCodexLifecyclePortError,
  type ReadyCodexLifecycleStore,
} from '../main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter'

const stableScalarSources = ['cli', 'vscode', 'exec', 'appServer', 'unknown'] as const

function readPinnedRootSource(): (typeof stableScalarSources)[number] {
  const contracts = JSON.parse(readFileSync(
    new URL('../../assets/codex-runtime/contracts/runtime-contracts.json', import.meta.url),
    'utf8',
  )) as {
    turnClientIdentityExtractionContract?: {
      thread_start?: { pinnedAppServerSource?: unknown }
    }
  }
  const source = contracts.turnClientIdentityExtractionContract?.thread_start?.pinnedAppServerSource
  if (!stableScalarSources.some((candidate) => candidate === source)) {
    throw new Error('runtime_contract_pinned_root_source_invalid')
  }
  return source
}

const pinnedRootSource = readPinnedRootSource()
const nonPinnedStableRootSource = pinnedRootSource === 'appServer' ? 'vscode' : 'appServer'

const rootThread: CodexThread = {
  id: 'thread-1',
  sessionId: 'thread-1',
  parentThreadId: null,
  forkedFromId: null,
  cwd: '/isolated/thread-1',
  source: pinnedRootSource,
  threadSource: null,
  modelProvider: 'ready_gateway',
  cliVersion: '0.0.0-test',
  createdAt: 1,
  ephemeral: false,
  preview: '',
  status: { type: 'idle' },
  updatedAt: 1,
  turns: [],
}

const activeTurn: CodexTurn = { id: 'turn-1', items: [], status: 'inProgress', error: null }
const aliasIdentity = { aliasId: 'alias-1', aliasGeneration: 1 }

class FakeNativeRuntime implements CodexNativeRuntime {
  readonly calls: string[] = []
  readonly failAt = new Set<string>()
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []
  thread: CodexThread = rootThread
  suppressTurnTerminal = false
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()

  private failIfRequested(method: string): void {
    if (this.failAt.has(method)) throw new Error(`${method}_failed`)
  }

  subscribe(listener: (notification: CodexNativeNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(notification: CodexNativeNotification): void {
    for (const listener of this.listeners) listener(notification)
  }
  async initialize(): Promise<{ userAgent: string }> { return { userAgent: 'fake' } }
  async threadStart(params: CodexThreadStartParams): Promise<{ thread: CodexThread; instructionSources: string[] }> {
    this.calls.push('threadStart')
    this.failIfRequested('threadStart')
    return { thread: { ...this.thread, cwd: params.cwd }, instructionSources: [] }
  }
  async threadRead(): Promise<{ thread: CodexThread }> {
    this.calls.push('threadRead')
    this.failIfRequested('threadRead')
    return { thread: { ...this.thread, turns: [{ ...activeTurn, status: 'completed' }] } }
  }
  async threadResume(): Promise<{ thread: CodexThread; instructionSources: string[] }> {
    this.calls.push('threadResume')
    return { thread: this.thread, instructionSources: [] }
  }
  async threadArchive(): Promise<Record<string, never>> {
    this.calls.push('threadArchive')
    return {}
  }
  async turnStart(): Promise<{ turn: CodexTurn }> {
    this.calls.push('turnStart')
    this.failIfRequested('turnStart')
    if (this.suppressTurnTerminal) return { turn: activeTurn }
    this.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: { type: 'agentMessage', id: 'final-1', text: 'native answer', phase: 'final_answer' },
      },
    })
    this.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { ...activeTurn, status: 'completed' },
      },
    })
    return { turn: activeTurn }
  }
  async turnInterrupt(params: { threadId: string; turnId: string }): Promise<Record<string, never>> {
    this.calls.push('turnInterrupt')
    this.interrupts.push(params)
    this.failIfRequested('turnInterrupt')
    return {}
  }
  async threadCompactStart(): Promise<Record<string, never>> {
    this.calls.push('threadCompactStart')
    this.failIfRequested('threadCompactStart')
    return {}
  }
}

const idleNever: LifecycleOperationFacts = {
  readyRunCreated: false,
  codexThreadId: null,
  codexTurnId: null,
  activeFence: null,
  threadStartUnreconciled: false,
  turnStartUnreconciled: false,
  productRunNonterminal: false,
  interruptStateUnknown: false,
  engineTerminalRecorded: false,
  readyCloseoutCommitted: false,
  readyTerminalWithoutNativeThread: false,
  allNativeThreadAttemptsSettled: false,
  hostFailureEvidenceComplete: false,
  hostFailureProductTerminalCommitted: false,
  manualCompactionState: 'none',
}

class FakeLifecycleStore implements ReadyCodexLifecycleStore {
  readonly calls: string[] = []
  readonly failAt = new Map<string, ReadyCodexLifecyclePortError['code']>()
  readonly boundThreads: Array<Parameters<ReadyCodexLifecycleStore['bindStartedThread']>[0]> = []
  facts: LifecycleOperationFacts = { ...idleNever }
  factsAfterFirstRead: LifecycleOperationFacts | null = null
  lifecycleFactReadCount = 0
  threadState: 'unstarted' | 'loaded' | 'resume_required' = 'unstarted'
  failEvidenceDigest = false

  private failIfRequested(method: string): void {
    const code = this.failAt.get(method)
    if (code) throw new ReadyCodexLifecyclePortError(code)
  }

  async createAlias() {
    this.calls.push('createAlias')
    this.failIfRequested('createAlias')
    return {
      ok: true as const,
      action: 'create' as const,
      aliasId: 'alias-new',
      aliasGeneration: 1,
      persistedAt: '2026-08-07T00:00:00.000Z',
    }
  }
  async readAliasIdentity(aliasId: string) {
    this.failIfRequested('readAliasIdentity')
    return { aliasId, aliasGeneration: 1 }
  }
  async resolveThreadBinding() {
    if (this.threadState === 'loaded') return { state: 'loaded' as const, threadId: 'thread-1' }
    if (this.threadState === 'resume_required') {
      return { state: 'resume_required' as const, threadId: 'thread-1' }
    }
    return {
      state: 'unstarted' as const,
      params: {
        model: 'ready-model',
        modelProvider: 'ready_gateway' as const,
        allowProviderModelFallback: false as const,
        cwd: '/isolated/thread-1',
        approvalPolicy: 'never' as const,
        sandbox: 'read-only' as const,
        runtimeWorkspaceRoots: [] as [],
        environments: [] as [],
        dynamicTools: [],
        developerInstructions: 'Ready tools are host-provided. Do not fabricate effects.',
      },
    }
  }
  async bindStartedThread(input: Parameters<ReadyCodexLifecycleStore['bindStartedThread']>[0]) {
    this.calls.push('bindStartedThread')
    this.boundThreads.push(input)
    this.threadState = 'loaded'
  }
  async markThreadResumed() { this.calls.push('markThreadResumed'); this.threadState = 'loaded' }
  async readLifecycleOperation(request: { aliasId: string }) {
    this.failIfRequested('readLifecycleOperation')
    this.lifecycleFactReadCount += 1
    const facts = this.lifecycleFactReadCount > 1 && this.factsAfterFirstRead
      ? this.factsAfterFirstRead
      : this.facts
    return {
      identity: { aliasId: request.aliasId, aliasGeneration: 1 },
      facts,
    }
  }
  failureEvidenceDigest(input: { action: string; snapshot: string }) {
    if (this.failEvidenceDigest) throw new Error('digest_store_failed')
    return `evidence:${input.action}:${input.snapshot}`
  }
  async resetIdleAlias() {
    this.calls.push('resetIdleAlias')
    this.failIfRequested('resetIdleAlias')
    return {
      ok: true as const,
      action: 'reset' as const,
      aliasId: 'alias-1',
      retiredGeneration: 1,
      newGeneration: 2,
      transactionDigest: 'reset-digest',
    }
  }
  async awaitProductCloseout() {
    this.calls.push('awaitProductCloseout')
    this.failIfRequested('awaitProductCloseout')
    this.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      allNativeThreadAttemptsSettled: true,
    }
    return {
      aliasId: 'alias-1',
      aliasGeneration: 1,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      terminal: 'interrupted' as const,
      closeoutDigest: 'closeout-digest',
      fenceReleaseRevision: 2,
    }
  }
  async settleHostFailureCloseout() {
    this.calls.push('settleHostFailureCloseout')
    this.failIfRequested('settleHostFailureCloseout')
    this.facts = {
      ...idleNever,
      readyRunCreated: true,
      readyTerminalWithoutNativeThread: true,
      hostFailureEvidenceComplete: true,
      hostFailureProductTerminalCommitted: true,
    }
  }
  async retireAliasForClose({ snapshot }: { snapshot: string }) {
    this.calls.push(`retireAliasForClose:${snapshot}`)
    this.failIfRequested('retireAliasForClose')
    return {
      aliasId: 'alias-1',
      retiredGeneration: 1,
      retirementTransactionDigest: 'retirement-digest',
      archiveDisposition: snapshot === 'idle_native_thread' ? 'queued_cleanup' as const : 'not_required' as const,
      lastCommittedReadyTerminalTransactionDigest: snapshot === 'idle_ready_terminal_no_native'
        ? 'ready-terminal-digest'
        : null,
      idleThreadReadDigest: snapshot === 'idle_native_thread' ? 'idle-read-digest' : null,
      lastCommittedProductTerminalDigest: snapshot === 'idle_native_thread' ? 'product-terminal-digest' : null,
    }
  }
  async beginManualCompaction() {
    this.calls.push('beginManualCompaction')
    this.failIfRequested('beginManualCompaction')
    return { manualCompactionId: 'manual-1', threadId: 'thread-1' }
  }
  async awaitManualCompaction() {
    this.calls.push('awaitManualCompaction')
    this.failIfRequested('awaitManualCompaction')
    return { contextCompactionItemId: 'compact-item-1', codexTurnId: 'compact-turn-1' }
  }
  async consumeManualCompaction() {
    this.calls.push('consumeManualCompaction')
    this.failIfRequested('consumeManualCompaction')
  }
  digestThreadRead() { return 'thread-read-digest' }
}

const prepared: PreparedCodexProductRun = {
  preparationContract: 'codex_product_run_e1',
  taskId: 'task-1',
  runId: 'run-1',
  conversationAlias: { aliasId: 'alias-1', aliasGeneration: 1 },
  ingressBinding: {
    requestId: 'request-1',
    reservationSetId: 'reservation-set-1',
    reservationEvidenceDigest: 'reservation-evidence-1',
  },
  ingress: {
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: { messageId: 'message-1', input: [textUserInput('hello')] },
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
  },
  resourceAnchorDigest: 'resource-digest',
  recoveredContextDigest: null,
  readyToolSurface: { surfaceId: 'surface-1', toolSurfaceDigest: 'surface-digest', toolNames: [] },
  readyTurnToolAuthorization: { authorizationId: 'auth-1', authorizationDigest: 'auth-digest' },
  readyToolHostIdentity: {
    scopeId: 'scope-1',
    aliasId: 'alias-1',
    authorizationOwnerId: 'owner-1',
    resourceOwnerId: 'resource-owner-1',
  },
  productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
  neutralProjectionSeed: {
    phase: 'planning',
    taskTitle: '正在理解需求',
    taskSummary: '正在整理任务边界、资源与可用能力',
  },
}

function createHarness(options: { rejectCloseout?: boolean; rejectRecovery?: boolean } = {}) {
  const nativeRuntime = new FakeNativeRuntime()
  const lifecycleStore = new FakeLifecycleStore()
  const candidates: CoreTurnCandidate[] = []
  const closeoutRecoveries: Array<{ candidate: CoreTurnCandidate; error: unknown }> = []
  const closeoutWaiters: CoreTurnCandidate[] = []
  const adapter = new ReadyCodexLifecycleAdapter({
    nativeRuntime,
    collector: new CodexTurnCollector(nativeRuntime),
    inputBuilder: new CodexTurnInputBuilder(),
    lifecycleStore,
    closeout: {
      async closeCandidate(candidate) {
        candidates.push(candidate)
        if (options.rejectCloseout) throw new Error('ready_closeout_persistence_failed')
        return { authority: 'ready-closeout', text: candidate.candidateText, candidateKind: candidate.kind }
      },
      recoverRejectedCandidate({ candidate, error }) {
        closeoutRecoveries.push({ candidate, error })
        if (options.rejectRecovery) throw new Error('recovery_rejected')
        return {
          authority: 'ready-closeout-recovery',
          text: error instanceof Error ? error.message : String(error),
          candidateKind: candidate.kind,
        }
      },
      observeCandidateReadback({ candidate }, onReadback) {
        assert.notEqual(candidate, null)
        closeoutWaiters.push(candidate as CoreTurnCandidate)
        onReadback({
          authority: 'ready-closeout-waiter',
          text: candidate?.candidateText || null,
          candidateKind: candidate?.kind || 'host_failure',
        })
        return () => undefined
      },
    },
  })
  return {
    adapter,
    nativeRuntime,
    lifecycleStore,
    candidates,
    closeoutRecoveries,
    closeoutWaiters,
  }
}

test('canonical runtime contract root source is accepted, bound, and reaches Ready closeout', async () => {
  const { adapter, nativeRuntime, lifecycleStore, candidates } = createHarness()
  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-1',
        readyRunId: 'run-1',
        toolSurfaceDigest: 'surface-digest',
        turnContractDigest: 'turn-digest',
        upstreamProfileSnapshotDigest: 'profile-digest',
      },
      collection: {
        terminalTimeoutMs: 1_000,
        actionReceiptRefs: [],
        interactionState: null,
        waitingFor: null,
        terminalReasonCandidate: 'done',
        abortInitiator: null,
        budgetState: {},
        contextState: {},
        providerDiagnostics: {},
        recoveryCheckpointRef: null,
        browserContinuationRef: null,
        browserProofRefs: [],
        otherProofRefs: [],
        projectionPatchRefs: [],
        allowNullPhaseFallback: true,
        allowDirectProvisionalStream: true,
        onAutomaticCompactionObserved: () => {},
        onProvisionalDelta: () => {},
      },
    }),
  })

  assert.deepEqual(result, {
    state: 'closed',
    result: { authority: 'ready-closeout', text: 'native answer', candidateKind: 'native_terminal' },
  })
  assert.deepEqual(nativeRuntime.calls, ['threadStart', 'turnStart'])
  assert.deepEqual(lifecycleStore.calls, ['bindStartedThread'])
  assert.deepEqual(lifecycleStore.boundThreads, [{
    identity: { aliasId: 'alias-1', aliasGeneration: 1 },
    threadId: 'thread-1',
    sessionId: 'thread-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/isolated/thread-1',
    source: pinnedRootSource,
    threadSource: null,
  }])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'native_terminal')
  assert.equal(candidates[0]?.candidateText, 'native answer')
})

test('non-pinned native root source metadata is rejected before binding or turn start', async () => {
  const cases: Array<{
    threadState: 'unstarted' | 'resume_required'
    thread: CodexThread
    expectedNativeCall: 'threadStart' | 'threadResume'
  }> = [
    {
      threadState: 'unstarted',
      thread: { ...rootThread, source: { custom: 'ready-e1' } },
      expectedNativeCall: 'threadStart',
    },
    {
      threadState: 'unstarted',
      thread: { ...rootThread, source: { subAgent: 'review' } },
      expectedNativeCall: 'threadStart',
    },
    {
      threadState: 'resume_required',
      thread: { ...rootThread, source: { custom: 'ready-e1' } },
      expectedNativeCall: 'threadResume',
    },
    {
      threadState: 'resume_required',
      thread: {
        ...rootThread,
        source: {
          subAgent: {
            thread_spawn: { depth: 1, parent_thread_id: 'thread-parent' },
          },
        },
      },
      expectedNativeCall: 'threadResume',
    },
    {
      threadState: 'unstarted',
      thread: { ...rootThread, source: nonPinnedStableRootSource },
      expectedNativeCall: 'threadStart',
    },
    {
      threadState: 'unstarted',
      thread: { ...rootThread, threadSource: 'subAgentThreadSpawn' },
      expectedNativeCall: 'threadStart',
    },
  ]

  for (const testCase of cases) {
    const { adapter, nativeRuntime, lifecycleStore, candidates } = createHarness()
    nativeRuntime.thread = testCase.thread
    lifecycleStore.threadState = testCase.threadState

    const result = await adapter.executePreparedRun({
      prepared,
      expectedScopeId: prepared.readyToolHostIdentity.scopeId,
      emitStartedProjection: () => {},
      resolveContext: async () => ({
        turnBuildContext: {
          turnRequestId: 'turn-request-invalid-root',
          readyRunId: 'run-1',
          toolSurfaceDigest: 'surface-digest',
          turnContractDigest: 'turn-digest',
          upstreamProfileSnapshotDigest: 'profile-digest',
        },
        collection: {
          terminalTimeoutMs: 1_000,
          actionReceiptRefs: [],
          interactionState: null,
          waitingFor: null,
          terminalReasonCandidate: 'done',
          abortInitiator: null,
          budgetState: {},
          contextState: {},
          providerDiagnostics: {},
          recoveryCheckpointRef: null,
          browserContinuationRef: null,
          browserProofRefs: [],
          otherProofRefs: [],
          projectionPatchRefs: [],
          allowNullPhaseFallback: true,
          allowDirectProvisionalStream: true,
          onAutomaticCompactionObserved: () => {},
          onProvisionalDelta: () => {},
        },
      }),
    })

    assert.equal(result.state, 'closed')
    assert.deepEqual(nativeRuntime.calls, [testCase.expectedNativeCall])
    assert.deepEqual(lifecycleStore.calls, [])
    assert.deepEqual(lifecycleStore.boundThreads, [])
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.kind, 'host_failure')
    if (candidates[0]?.kind === 'host_failure') {
      assert.equal(candidates[0].hostFailure.stage, 'thread_resolution')
      assert.equal(candidates[0].hostFailure.code, 'native_thread_identity_mismatch')
    }
  }
})

test('prepared context resolution failure still reaches Ready closeout exactly once', async () => {
  const { adapter, nativeRuntime, lifecycleStore, candidates } = createHarness()

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => {
      throw new Error('prepared_context_resolution_failed')
    },
  })

  assert.deepEqual(result, {
    state: 'closed',
    result: { authority: 'ready-closeout', text: null, candidateKind: 'host_failure' },
  })
  assert.deepEqual(nativeRuntime.calls, [])
  assert.deepEqual(lifecycleStore.calls, [])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'host_failure')
  if (candidates[0]?.kind === 'host_failure') {
    assert.equal(candidates[0].hostFailure.stage, 'prepared_run_context')
    assert.equal(candidates[0].hostFailure.code, 'prepared_run_context_resolution_failed')
    assert.equal(candidates[0].terminalReasonCandidate, 'persistence_failed')
    assert.deepEqual(candidates[0].budgetState, prepared.productBudgetSeed)
  }
})

test('Ready closeout rejection returns a typed recovery result instead of escaping the wire', async () => {
  const { adapter, candidates, closeoutRecoveries } = createHarness({ rejectCloseout: true })

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => {
      throw new Error('prepared_context_resolution_failed')
    },
  })

  assert.deepEqual(result, {
    state: 'closed',
    result: {
      authority: 'ready-closeout-recovery',
      text: 'ready_closeout_persistence_failed',
      candidateKind: 'host_failure',
    },
  })
  assert.equal(candidates.length, 1)
  assert.equal(closeoutRecoveries.length, 1)
  assert.equal(closeoutRecoveries[0]?.candidate, candidates[0])
})

test('double closeout failure becomes an explicit pending lifecycle state', async () => {
  const { adapter, candidates, closeoutRecoveries, closeoutWaiters } = createHarness({
    rejectCloseout: true,
    rejectRecovery: true,
  })

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => {
      throw new Error('prepared_context_resolution_failed')
    },
  })

  assert.equal(result.state, 'ready_closeout_pending')
  if (result.state === 'ready_closeout_pending') {
    assert.equal(result.pendingKind, 'host_failure_closeout_pending')
    assert.equal(result.error, 'recovery_rejected')
    assert.equal(result.recoveryEvidenceDigest.length, 64)
    assert.equal(result.candidate, candidates[0])
  }
  assert.equal(closeoutRecoveries.length, 1)
  let recovered: unknown = null
  const unsubscribe = result.state === 'ready_closeout_pending'
    ? adapter.observeRunCloseout({
        prepared,
        expectedScopeId: prepared.readyToolHostIdentity.scopeId,
        pending: result,
      }, (readback) => { recovered = readback })
    : () => undefined
  assert.deepEqual(recovered, {
    authority: 'ready-closeout-waiter',
    text: null,
    candidateKind: 'host_failure',
  })
  unsubscribe()
  assert.equal(closeoutWaiters.length, 1)
})

test('turn start transport failure still reaches Ready closeout exactly once', async () => {
  const { adapter, nativeRuntime, candidates } = createHarness()
  nativeRuntime.failAt.add('turnStart')

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-start-failure',
        readyRunId: 'run-1',
        toolSurfaceDigest: 'surface-digest',
        turnContractDigest: 'turn-digest',
        upstreamProfileSnapshotDigest: 'profile-digest',
      },
      collection: {
        terminalTimeoutMs: 20,
        actionReceiptRefs: [],
        interactionState: null,
        waitingFor: null,
        terminalReasonCandidate: 'done',
        abortInitiator: null,
        budgetState: {},
        contextState: {},
        providerDiagnostics: {},
        recoveryCheckpointRef: null,
        browserContinuationRef: null,
        browserProofRefs: [],
        otherProofRefs: [],
        projectionPatchRefs: [],
        allowNullPhaseFallback: true,
        allowDirectProvisionalStream: false,
        onAutomaticCompactionObserved: () => {},
        onProvisionalDelta: () => {},
      },
    }),
  })

  assert.deepEqual(result, {
    state: 'closed',
    result: { authority: 'ready-closeout', text: null, candidateKind: 'host_failure' },
  })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'host_failure')
  if (candidates[0]?.kind === 'host_failure') {
    assert.equal(candidates[0].hostFailure.stage, 'turn_start')
    assert.match(candidates[0].hostFailure.message, /turnStart_failed/)
    assert.equal(candidates[0].terminalReasonCandidate, 'persistence_failed')
  }
})

test('native terminal timeout still reaches Ready closeout exactly once', async () => {
  const { adapter, nativeRuntime, candidates } = createHarness()
  nativeRuntime.suppressTurnTerminal = true

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-terminal-timeout',
        readyRunId: 'run-1',
        toolSurfaceDigest: 'surface-digest',
        turnContractDigest: 'turn-digest',
        upstreamProfileSnapshotDigest: 'profile-digest',
      },
      collection: {
        terminalTimeoutMs: 10,
        actionReceiptRefs: [],
        interactionState: null,
        waitingFor: null,
        terminalReasonCandidate: 'done',
        abortInitiator: null,
        budgetState: {},
        contextState: {},
        providerDiagnostics: {},
        recoveryCheckpointRef: null,
        browserContinuationRef: null,
        browserProofRefs: [],
        otherProofRefs: [],
        projectionPatchRefs: [],
        allowNullPhaseFallback: true,
        allowDirectProvisionalStream: false,
        onAutomaticCompactionObserved: () => {},
        onProvisionalDelta: () => {},
      },
    }),
  })

  assert.deepEqual(result, {
    state: 'closed',
    result: { authority: 'ready-closeout', text: null, candidateKind: 'host_failure' },
  })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'host_failure')
  if (candidates[0]?.kind === 'host_failure') {
    assert.equal(candidates[0].hostFailure.stage, 'terminal_timeout')
    assert.equal(candidates[0].codexTurnId, 'turn-1')
    assert.equal(candidates[0].terminalReasonCandidate, 'persistence_failed')
  }
})

test('stop awaits interrupt acknowledgement and the same Ready closeout before success', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
  }
  const result = await adapter.stopSession(aliasIdentity)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'stop')
  assert.deepEqual(nativeRuntime.calls, ['turnInterrupt'])
  assert.deepEqual(nativeRuntime.interrupts, [{ threadId: 'thread-1', turnId: 'turn-1' }])
  assert.deepEqual(lifecycleStore.calls, ['awaitProductCloseout'])
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
})

test('interrupt uses the identifiers from the single classified lifecycle read', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
  }
  lifecycleStore.factsAfterFirstRead = {
    ...lifecycleStore.facts,
    codexThreadId: 'thread-changed',
    codexTurnId: 'turn-changed',
  }

  const result = await adapter.stopSession(aliasIdentity)

  assert.equal(result.ok, true)
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
  assert.deepEqual(nativeRuntime.interrupts, [{ threadId: 'thread-1', turnId: 'turn-1' }])
})

test('interrupt unknown and pending start preserve UI without another native call', async () => {
  for (const facts of [
    {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      activeFence: 'product_turn' as const,
      productRunNonterminal: true,
      interruptStateUnknown: true,
    },
    { ...idleNever, readyRunCreated: true, threadStartUnreconciled: true },
  ]) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.facts = facts
    const result = await adapter.resetSession(aliasIdentity)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.preserveUi, true)
    assert.deepEqual(nativeRuntime.calls, [])
  }
})

test('close has four evidence-distinct success variants and never archives directly', async () => {
  const variants: Array<[LifecycleOperationFacts, string]> = [
    [idleNever, 'never_started'],
    [{ ...idleNever, readyRunCreated: true, readyTerminalWithoutNativeThread: true }, 'ready_terminal_no_native_thread'],
    [{
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      allNativeThreadAttemptsSettled: true,
    }, 'native_thread_idle'],
  ]
  for (const [facts, disposition] of variants) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.facts = facts
    const result = await adapter.closeSession(aliasIdentity)
    assert.equal(result.ok, true)
    if (!result.ok || result.action !== 'close') continue
    assert.equal(result.closeoutDisposition, disposition)
    assert.equal(nativeRuntime.calls.includes('threadArchive'), false)
  }

  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
  }
  const active = await adapter.closeSession(aliasIdentity)
  assert.equal(active.ok, true)
  if (active.ok && active.action === 'close') {
    assert.equal(active.closeoutDisposition, 'completed_active_product_turn')
  }
  assert.deepEqual(nativeRuntime.calls, ['turnInterrupt'])
})

test('manual compact requires idle native thread, item terminal evidence, and readback before success', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    allNativeThreadAttemptsSettled: true,
  }
  const result = await adapter.compactSession(aliasIdentity)
  assert.equal(result.ok, true)
  assert.deepEqual(nativeRuntime.calls, ['threadCompactStart', 'threadRead'])
  assert.deepEqual(lifecycleStore.calls, [
    'beginManualCompaction',
    'awaitManualCompaction',
    'consumeManualCompaction',
  ])
})

test('reset persistence failure preserves the current generation and performs no native operation', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.failAt.set('resetIdleAlias', 'persistence_failed')

  const result = await adapter.resetSession(aliasIdentity)

  assert.deepEqual(result, {
    ok: false,
    action: 'reset',
    code: 'persistence_failed',
    preserveUi: true,
    aliasId: 'alias-1',
    aliasGeneration: 1,
    evidenceDigest: 'evidence:reset:idle_never_started',
  })
  assert.deepEqual(nativeRuntime.calls, [])
})

test('create and identity read failures return exact typed lifecycle failures', async () => {
  {
    const { adapter, lifecycleStore } = createHarness()
    lifecycleStore.failAt.set('createAlias', 'persistence_failed')
    const result = await adapter.createSession()
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.action, 'create')
    assert.equal(result.code, 'persistence_failed')
    assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/)
  }

  {
    const { adapter, lifecycleStore } = createHarness()
    lifecycleStore.failAt.set('readLifecycleOperation', 'persistence_failed')
    assert.deepEqual(await adapter.resetSession(aliasIdentity), {
      ok: false,
      action: 'reset',
      code: 'persistence_failed',
      preserveUi: true,
      aliasId: 'alias-1',
      aliasGeneration: 1,
      evidenceDigest: 'evidence:reset:invariant_violation',
    })
  }

  {
    const { adapter, lifecycleStore } = createHarness()
    lifecycleStore.failAt.set('readLifecycleOperation', 'persistence_failed')
    lifecycleStore.failEvidenceDigest = true
    const result = await adapter.resetSession(aliasIdentity)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'persistence_failed')
    assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/)
  }
})

test('stale alias generation fails closed after one consistent lifecycle read and no native operation', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  const result = await adapter.closeSession({ aliasId: 'alias-1', aliasGeneration: 2 })

  assert.deepEqual(result, {
    ok: false,
    action: 'close',
    code: 'binding_conflict',
    preserveUi: true,
    aliasId: 'alias-1',
    aliasGeneration: 2,
    evidenceDigest: 'evidence:close:invariant_violation',
  })
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
  assert.deepEqual(nativeRuntime.calls, [])
})

test('interrupt rejection and closeout timeout remain interrupt_state_unknown', async () => {
  for (const failAt of ['turnInterrupt', 'awaitProductCloseout'] as const) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      activeFence: 'product_turn',
      productRunNonterminal: true,
    }
    if (failAt === 'turnInterrupt') nativeRuntime.failAt.add(failAt)
    else lifecycleStore.failAt.set(failAt, 'interrupt_state_unknown')

    const result = await adapter.stopSession(aliasIdentity)

    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'interrupt_state_unknown')
    assert.equal(result.preserveUi, true)
  }
})

test('manual compaction uncertainty and consume persistence failure never report success', async () => {
  for (const failAt of ['threadCompactStart', 'consumeManualCompaction'] as const) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      allNativeThreadAttemptsSettled: true,
    }
    if (failAt === 'threadCompactStart') nativeRuntime.failAt.add(failAt)
    else lifecycleStore.failAt.set(failAt, 'persistence_failed')

    const result = await adapter.compactSession(aliasIdentity)

    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(
      result.code,
      failAt === 'threadCompactStart' ? 'compaction_state_unknown' : 'persistence_failed',
    )
    assert.equal(result.preserveUi, true)
  }

  {
    const { adapter, lifecycleStore } = createHarness()
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      allNativeThreadAttemptsSettled: true,
    }
    lifecycleStore.digestThreadRead = () => { throw new Error('digest_failed') }
    const result = await adapter.compactSession(aliasIdentity)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'compaction_state_unknown')
      assert.equal(result.preserveUi, true)
    }
  }
})
