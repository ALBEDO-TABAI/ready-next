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
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import {
  CodexThreadResumeAuthority,
  type CodexThreadResumeSession,
} from '../main/modules/agent-control/codex-runtime/codex-thread-resume-authority'
import {
  buildCodexEngineTerminalFinalizationKey,
  CodexProductCloseoutExpectationGuard,
  runCodexEngineTerminalFinalization,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import {
  CodexTurnCollector,
  type CoreTurnCandidate,
} from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import {
  RECOVERED_CLOSEOUT_TOMBSTONE_LIMIT,
  ReadyCodexLifecycleAdapter,
  ReadyCodexLifecyclePortError,
  type ReadyCodexLifecycleStore,
  type ReadyCodexThreadResumePort,
} from '../main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter'
import { CodexAppServerClientError } from '../main/modules/agent-control/codex-runtime/codex-app-server-client'

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
const stopIdentity = { ...aliasIdentity, readyRunId: 'run-1' }
const activeLifecycleIdentity = { ...aliasIdentity, readyRunId: 'run-1' }
const idleLifecycleIdentity = { ...aliasIdentity, readyRunId: null }

class FakeNativeRuntime implements CodexNativeRuntime {
  readonly calls: string[] = []
  readonly failAt = new Set<string>()
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []
  thread: CodexThread = rootThread
  suppressTurnTerminal = false
  pendingThreadStart = false
  pendingTurnStart = false
  manualCompactionStarted = false
  manualCompactionReadbackItemId = 'compact-readback-item-1'
  interruptError: Error | null = null
  interruptReadTurnId = 'turn-1'
  interruptReadTurnStatus: CodexTurn['status'] = 'completed'
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
    if (this.pendingThreadStart) return new Promise(() => undefined)
    return { thread: { ...this.thread, cwd: params.cwd }, instructionSources: [] }
  }
  async threadRead(_params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexThread }> {
    this.calls.push('threadRead')
    this.failIfRequested('threadRead')
    return {
      thread: {
        ...this.thread,
        turns: this.manualCompactionStarted
          ? [{
              id: 'compact-turn-1',
              status: 'completed',
              error: null,
              items: [{ type: 'contextCompaction', id: this.manualCompactionReadbackItemId }],
            }]
          : [{
              ...activeTurn,
              id: this.interruptReadTurnId,
              status: this.interruptReadTurnStatus,
            }],
      },
    }
  }
  async threadList(): Promise<{ data: CodexThread[]; nextCursor: string | null }> {
    throw new Error('not used')
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
    if (this.pendingTurnStart) return new Promise(() => undefined)
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
    if (this.interruptError) throw this.interruptError
    return {}
  }
  async threadCompactStart(): Promise<Record<string, never>> {
    this.calls.push('threadCompactStart')
    this.failIfRequested('threadCompactStart')
    this.manualCompactionStarted = true
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
  activeReadyRunId: string | null = 'run-1'
  activeReadyRunIdAfterFirstRead: string | null | undefined
  activeManualCompactionId: string | null = null
  requestedAction: 'stop' | 'close' | 'reset' | null = null
  threadState: 'unstarted' | 'loaded' | 'resume_required' = 'unstarted'
  activeConnectionEpoch = 'epoch-1'
  failEvidenceDigest = false
  consumedManualCompaction: Parameters<ReadyCodexLifecycleStore['consumeManualCompaction']>[0] | null = null
  retryUserStopFinalization: Awaited<ReturnType<
    ReadyCodexLifecycleStore['retryEngineTerminalUserStopFinalization']
  >> = null

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
  async markThreadResumed(input: Parameters<ReadyCodexLifecycleStore['markThreadResumed']>[0]) {
    if (input.connectionEpoch !== this.activeConnectionEpoch) {
      throw new Error('resumed_thread_connection_epoch_mismatch')
    }
    assert.ok(input.preResumeThreadReadDigest)
    assert.ok(input.resumedThreadDigest)
    this.calls.push('markThreadResumed')
    this.threadState = 'loaded'
  }
  async readLifecycleOperation(request: { aliasId: string }) {
    this.failIfRequested('readLifecycleOperation')
    this.lifecycleFactReadCount += 1
    const facts = this.lifecycleFactReadCount > 1 && this.factsAfterFirstRead
      ? this.factsAfterFirstRead
      : this.facts
    const exactActiveReadyRunId = this.lifecycleFactReadCount > 1
      && this.activeReadyRunIdAfterFirstRead !== undefined
      ? this.activeReadyRunIdAfterFirstRead
      : this.activeReadyRunId
    const activeReadyRunId = facts.activeFence === 'product_turn'
      || facts.threadStartUnreconciled
      || facts.turnStartUnreconciled
      || (facts.hostFailureEvidenceComplete && !facts.hostFailureProductTerminalCommitted)
      ? exactActiveReadyRunId
      : null
    return {
      identity: { aliasId: request.aliasId, aliasGeneration: 1 },
      activeReadyRunId,
      activeManualCompactionId: this.activeManualCompactionId,
      requestedAction: this.requestedAction,
      facts,
    }
  }
  async requestProductInterrupt(input: Parameters<ReadyCodexLifecycleStore['requestProductInterrupt']>[0]) {
    this.calls.push('requestProductInterrupt')
    this.failIfRequested('requestProductInterrupt')
    if (this.requestedAction && this.requestedAction !== input.action) {
      throw new ReadyCodexLifecyclePortError('binding_conflict')
    }
    this.requestedAction = input.action
  }
  async acknowledgeProductInterrupt() {
    this.calls.push('acknowledgeProductInterrupt')
    this.failIfRequested('acknowledgeProductInterrupt')
  }
  async markProductInterruptUnknown() {
    this.calls.push('markProductInterruptUnknown')
    this.failIfRequested('markProductInterruptUnknown')
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
  async quarantineUnknownManualCompaction() {
    this.calls.push('quarantineUnknownManualCompaction')
    this.failIfRequested('quarantineUnknownManualCompaction')
    return {
      ok: true as const,
      action: 'reset' as const,
      aliasId: 'alias-1',
      retiredGeneration: 1,
      newGeneration: 2,
      transactionDigest: 'manual-quarantine-digest',
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
    return this.productCloseoutEvidence('closeout-digest', 2)
  }
  async settleEngineTerminalUserStop(
    _identity?: Parameters<ReadyCodexLifecycleStore['settleEngineTerminalUserStop']>[0],
    action: 'stop' | 'close' | 'reset' = 'stop',
  ) {
    this.calls.push('settleEngineTerminalUserStop')
    this.failIfRequested('settleEngineTerminalUserStop')
    this.requestedAction = action
    this.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      allNativeThreadAttemptsSettled: true,
    }
    return this.productCloseoutEvidence('user-stop-closeout-digest', 3)
  }
  async settleReadbackTerminalUserStop(
    _input?: Parameters<ReadyCodexLifecycleStore['settleReadbackTerminalUserStop']>[0],
    action: 'stop' | 'close' | 'reset' = 'stop',
  ) {
    this.calls.push('settleReadbackTerminalUserStop')
    this.failIfRequested('settleReadbackTerminalUserStop')
    this.requestedAction = action
    this.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      allNativeThreadAttemptsSettled: true,
    }
    return this.productCloseoutEvidence('readback-user-stop-closeout-digest', 4)
  }
  private productCloseoutEvidence(closeoutDigest: string, fenceReleaseRevision: number) {
    const lifecycleAction = this.requestedAction
    const retirementTransactionDigest = lifecycleAction ? 'a'.repeat(64) : undefined
    return {
      aliasId: 'alias-1',
      aliasGeneration: 1,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      terminal: 'interrupted' as const,
      closeoutDigest,
      fenceReleaseRevision,
      ...(lifecycleAction
        ? {
            lifecycleAction,
            lifecycleActionEvidenceDigest: `action-${lifecycleAction}-digest`,
            retiredGeneration: 1,
            retirementTransactionDigest,
            archiveIntentDigest: 'b'.repeat(64),
            scopeClosureEvidenceDigest: lifecycleAction === 'close'
              ? retirementTransactionDigest
              : null,
            newGeneration: lifecycleAction === 'reset' ? 2 : null,
            newThreadBindingId: lifecycleAction === 'reset' ? 'thread-binding-2' : null,
          }
        : {}),
    }
  }
  async retryEngineTerminalUserStopFinalization() {
    this.calls.push('retryEngineTerminalUserStopFinalization')
    this.failIfRequested('retryEngineTerminalUserStopFinalization')
    const result = this.retryUserStopFinalization
    this.retryUserStopFinalization = null
    return result
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
      retirementTransactionDigest: 'c'.repeat(64),
      archiveDisposition: snapshot === 'idle_native_thread'
        ? 'durable_cleanup_pending' as const
        : 'not_required' as const,
      archiveIntentDigest: snapshot === 'idle_native_thread' ? 'd'.repeat(64) : null,
      scopeClosureEvidenceDigest: 'c'.repeat(64),
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
    return {
      notificationContextCompactionItemId: 'compact-notification-item-1',
      codexTurnId: 'compact-turn-1',
    }
  }
  async consumeManualCompaction(input: Parameters<ReadyCodexLifecycleStore['consumeManualCompaction']>[0]) {
    this.calls.push('consumeManualCompaction')
    this.failIfRequested('consumeManualCompaction')
    this.consumedManualCompaction = input
  }
  async markManualCompactionUnknown() {
    this.calls.push('markManualCompactionUnknown')
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
  ...createCodexToolFixture([]),
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

function createHarness(options: {
  rejectCloseout?: boolean
  rejectRecovery?: boolean
  deferReadback?: boolean
  threadResumePort?: ReadyCodexThreadResumePort
  closeCandidate?: (candidate: CoreTurnCandidate) => Promise<{
    authority: string
    text: string | null
    candidateKind: CoreTurnCandidate['kind']
  }>
} = {}) {
  const nativeRuntime = new FakeNativeRuntime()
  const lifecycleStore = new FakeLifecycleStore()
  const candidates: CoreTurnCandidate[] = []
  const closeoutRecoveries: Array<{ candidate: CoreTurnCandidate; error: unknown }> = []
  const closeoutWaiters: CoreTurnCandidate[] = []
  const adapter = new ReadyCodexLifecycleAdapter({
    nativeRuntime,
    threadResumePort: options.threadResumePort || {
      async readThenResume({ threadId, validateRead }) {
        const read = await nativeRuntime.threadRead({ threadId, includeTurns: true })
        validateRead(read.thread)
        const resumed = await nativeRuntime.threadResume({ threadId })
        return { connectionEpoch: 'epoch-1', read, resumed }
      },
    },
    collector: new CodexTurnCollector(nativeRuntime),
    inputBuilder: new CodexTurnInputBuilder(),
    lifecycleStore,
    closeout: {
      async closeCandidate(candidate) {
        candidates.push(candidate)
        if (options.closeCandidate) return options.closeCandidate(candidate)
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
        if (!options.deferReadback) {
          onReadback({
            authority: 'ready-closeout-waiter',
            text: candidate?.candidateText || null,
            candidateKind: candidate?.kind || 'host_failure',
          })
        }
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

function executeNativeTerminal(adapter: ReadyCodexLifecycleAdapter<{
  authority: string
  text: string | null
  candidateKind: CoreTurnCandidate['kind']
}>) {
  return adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-closeout-race',
        readyRunId: prepared.runId,
        toolSurfaceDigest: 'surface-digest',
        turnContractDigest: 'turn-digest',
        upstreamProfileSnapshotDigest: 'profile-digest',
      },
      collection: {
        terminalTimeoutMs: 1_000,
        actionReceiptRefs: [],
        interactionState: null,
        waitingFor: null,
        terminalReasonCandidate: 'done' as const,
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
        onProvisionalDelta: () => {},
      },
    }),
  })
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

test('existing root thread is read and durably marked before resume can start a turn', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.threadState = 'resume_required'
  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-resume',
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
        onProvisionalDelta: () => {},
      },
    }),
  })
  assert.equal(result.state, 'closed')
  assert.deepEqual(nativeRuntime.calls, ['threadRead', 'threadResume', 'turnStart'])
  assert.deepEqual(lifecycleStore.calls, ['markThreadResumed'])
})

test('connection replacement after thread read cannot resume on a new client or start a turn', async () => {
  const firstClient = new FakeNativeRuntime()
  const replacementClient = new FakeNativeRuntime()
  const firstAbort = new AbortController()
  const replacementAbort = new AbortController()
  let activeSession: CodexThreadResumeSession
  const firstSession: CodexThreadResumeSession = {
    getActiveConnectionEpoch: () => 'epoch-first',
    getClient: () => firstClient,
    getConnectionAbortSignal: (epoch) => epoch === 'epoch-first' ? firstAbort.signal : null,
    isConnectionLive: (epoch) => epoch === 'epoch-first' && !firstAbort.signal.aborted,
  }
  const replacementSession: CodexThreadResumeSession = {
    getActiveConnectionEpoch: () => 'epoch-replacement',
    getClient: () => replacementClient,
    getConnectionAbortSignal: (epoch) => epoch === 'epoch-replacement' ? replacementAbort.signal : null,
    isConnectionLive: (epoch) => epoch === 'epoch-replacement',
  }
  activeSession = firstSession
  const originalRead = firstClient.threadRead.bind(firstClient)
  firstClient.threadRead = async (params) => {
    const read = await originalRead(params)
    firstAbort.abort(new Error('connection_replaced'))
    activeSession = replacementSession
    return read
  }
  const { adapter, nativeRuntime, lifecycleStore, candidates } = createHarness({
    threadResumePort: new CodexThreadResumeAuthority(() => activeSession),
  })
  lifecycleStore.threadState = 'resume_required'

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-replaced-connection',
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
        onProvisionalDelta: () => {},
      },
    }),
  })

  assert.equal(result.state, 'closed')
  assert.deepEqual(firstClient.calls, ['threadRead'])
  assert.deepEqual(replacementClient.calls, [])
  assert.equal(nativeRuntime.calls.includes('turnStart'), false)
  assert.equal(lifecycleStore.calls.includes('markThreadResumed'), false)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'host_failure')
})

test('connection replacement after resume but before evidence marking cannot load or start the thread', async () => {
  let lifecycleStore: FakeLifecycleStore
  const { adapter, nativeRuntime, lifecycleStore: store, candidates } = createHarness({
    threadResumePort: {
      async readThenResume({ threadId, validateRead }) {
        const read = { thread: rootThread }
        validateRead(read.thread)
        lifecycleStore.activeConnectionEpoch = 'epoch-replacement'
        return {
          connectionEpoch: 'epoch-first',
          read,
          resumed: { thread: rootThread, instructionSources: [] },
        }
      },
    },
  })
  lifecycleStore = store
  lifecycleStore.threadState = 'resume_required'

  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => ({
      turnBuildContext: {
        turnRequestId: 'turn-request-post-resume-replacement',
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
        onProvisionalDelta: () => {},
      },
    }),
  })

  assert.equal(result.state, 'closed')
  assert.equal(nativeRuntime.calls.includes('turnStart'), false)
  assert.deepEqual(lifecycleStore.calls, [])
  assert.equal(lifecycleStore.threadState, 'resume_required')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'host_failure')
})

test('non-pinned native root source metadata is rejected before binding or turn start', async () => {
  const cases: Array<{
    threadState: 'unstarted' | 'resume_required'
    thread: CodexThread
    expectedNativeCall: 'threadStart' | 'threadRead'
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
      expectedNativeCall: 'threadRead',
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
      expectedNativeCall: 'threadRead',
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

test('boot closeout broker settles the original pending observer exactly once', async () => {
  const { adapter, closeoutWaiters } = createHarness({
    rejectCloseout: true,
    rejectRecovery: true,
    deferReadback: true,
  })
  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => { throw new Error('prepared_context_resolution_failed') },
  })
  assert.equal(result.state, 'ready_closeout_pending')
  if (result.state !== 'ready_closeout_pending') throw new Error('pending_closeout_expected')
  const recovered: unknown[] = []
  adapter.observeRunCloseout({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    pending: result,
  }, (readback) => { recovered.push(readback) })
  assert.equal(closeoutWaiters.length, 1)
  const readback = {
    authority: 'boot-recovery',
    text: null,
    candidateKind: 'host_failure',
  }
  assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, readback), 'delivered')
  assert.deepEqual(recovered, [readback])
  assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, readback), 'duplicate')
})

test('boot closeout broker replays recovery that finishes before observer registration', async () => {
  const { adapter, closeoutWaiters } = createHarness({
    rejectCloseout: true,
    rejectRecovery: true,
    deferReadback: true,
  })
  const result = await adapter.executePreparedRun({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    emitStartedProjection: () => {},
    resolveContext: async () => { throw new Error('prepared_context_resolution_failed') },
  })
  assert.equal(result.state, 'ready_closeout_pending')
  if (result.state !== 'ready_closeout_pending') throw new Error('pending_closeout_expected')
  const readback = {
    authority: 'boot-recovery-before-observer',
    text: null,
    candidateKind: 'host_failure',
  }
  assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, readback), 'buffered')
  const recovered: unknown[] = []
  adapter.observeRunCloseout({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    pending: result,
  }, (value) => { recovered.push(value) })
  assert.deepEqual(recovered, [readback])
  assert.equal(closeoutWaiters.length, 0)
  assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, readback), 'duplicate')
})

test('production closeout guard buffers a user-stop winner before initial pending return', async () => {
  const guard = new CodexProductCloseoutExpectationGuard()
  let enteredCloseout!: () => void
  let continueCloseout!: () => void
  const closeoutEntered = new Promise<void>((resolve) => { enteredCloseout = resolve })
  const closeoutMayContinue = new Promise<void>((resolve) => { continueCloseout = resolve })
  let durableStopCommitted = false
  const { adapter, closeoutWaiters } = createHarness({
    rejectRecovery: true,
    deferReadback: true,
    closeCandidate: async () => {
      enteredCloseout()
      await closeoutMayContinue
      const token = guard.acquire(prepared.runId, 'product')
      try {
        if (durableStopCommitted) throw new Error('codex_product_closeout_already_committed')
        return { authority: 'normal-closeout', text: 'native answer', candidateKind: 'native_terminal' }
      } finally {
        guard.release(prepared.runId, token)
      }
    },
  })
  const execution = executeNativeTerminal(adapter)
  await closeoutEntered

  const stopReadback = {
    authority: 'user-stop-closeout',
    text: null,
    candidateKind: 'native_terminal' as const,
  }
  await assert.rejects(async () => {
    const stopToken = guard.acquire(prepared.runId, 'publication_diverged')
    try {
      assert.equal(guard.readMode(prepared.runId), 'publication_diverged')
      durableStopCommitted = true
      assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, stopReadback), 'buffered')
    } finally {
      guard.release(prepared.runId, stopToken)
    }
    throw new Error('post_commit_memory_cleanup_failed')
  }, /post_commit_memory_cleanup_failed/)
  continueCloseout()

  const outcome = await execution
  assert.equal(outcome.state, 'ready_closeout_pending')
  if (outcome.state !== 'ready_closeout_pending') throw new Error('pending_closeout_expected')
  const delivered: unknown[] = []
  adapter.observeRunCloseout({
    prepared,
    expectedScopeId: prepared.readyToolHostIdentity.scopeId,
    pending: outcome,
  }, (readback) => { delivered.push(readback) })
  assert.deepEqual(delivered, [stopReadback])
  assert.equal(closeoutWaiters.length, 0)
  assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, stopReadback), 'duplicate')
})

test('production closeout guard preserves a normal winner and rejects a concurrent stop mode', async () => {
  const guard = new CodexProductCloseoutExpectationGuard()
  let normalAcquired!: () => void
  let finishNormal!: () => void
  const acquired = new Promise<void>((resolve) => { normalAcquired = resolve })
  const finish = new Promise<void>((resolve) => { finishNormal = resolve })
  const { adapter } = createHarness({
    deferReadback: true,
    closeCandidate: async () => {
      const token = guard.acquire(prepared.runId, 'product')
      normalAcquired()
      try {
        await finish
        return { authority: 'normal-closeout', text: 'native answer', candidateKind: 'native_terminal' }
      } finally {
        guard.release(prepared.runId, token)
      }
    },
  })
  const execution = executeNativeTerminal(adapter)
  await acquired
  assert.equal(guard.readMode(prepared.runId), 'product')
  assert.throws(
    () => guard.acquire(prepared.runId, 'publication_diverged'),
    /codex_product_closeout_in_flight/,
  )
  guard.release(prepared.runId, Symbol('foreign-closeout'))
  assert.equal(guard.readMode(prepared.runId), 'product')
  finishNormal()

  const outcome = await execution
  assert.equal(outcome.state, 'closed')
  assert.equal(guard.readMode(prepared.runId), null)
  assert.equal(adapter.deliverRecoveredCloseout(prepared.runId, {
    authority: 'late-user-stop',
    text: null,
    candidateKind: 'native_terminal',
  }), 'duplicate')
})

test('boot closeout without an active same-Main run retries publication until acknowledged', () => {
  const { adapter } = createHarness({ deferReadback: true })
  const readback = {
    authority: 'new-main-boot-recovery',
    text: null,
    candidateKind: 'host_failure',
  }
  assert.equal(adapter.deliverRecoveredCloseout('new-main-run', readback), 'publish_only')
  assert.equal(adapter.deliverRecoveredCloseout('new-main-run', readback), 'publish_only')
  adapter.acknowledgePublishedRecoveredCloseout('new-main-run')
  assert.equal(adapter.deliverRecoveredCloseout('new-main-run', readback), 'duplicate')
})

test('recovered closeout tombstones evict the oldest entry at the fixed bound', () => {
  const { adapter } = createHarness({ deferReadback: true })
  const readback = {
    authority: 'bounded-recovery-tombstone',
    text: null,
    candidateKind: 'host_failure' as const,
  }
  for (let index = 0; index <= RECOVERED_CLOSEOUT_TOMBSTONE_LIMIT; index += 1) {
    const readyRunId = `bounded-recovery-${index}`
    assert.equal(adapter.deliverRecoveredCloseout(readyRunId, readback), 'publish_only')
    adapter.acknowledgePublishedRecoveredCloseout(readyRunId)
  }

  assert.equal(
    adapter.deliverRecoveredCloseout('bounded-recovery-0', readback),
    'publish_only',
  )
  assert.equal(
    adapter.deliverRecoveredCloseout(
      `bounded-recovery-${RECOVERED_CLOSEOUT_TOMBSTONE_LIMIT}`,
      readback,
    ),
    'duplicate',
  )
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

test('unresolved native start remains pending without creating a Ready failure or closeout', async () => {
  for (const stage of ['thread', 'turn'] as const) {
    const { adapter, nativeRuntime, lifecycleStore, candidates } = createHarness()
    if (stage === 'thread') nativeRuntime.pendingThreadStart = true
    else {
      lifecycleStore.threadState = 'loaded'
      nativeRuntime.pendingTurnStart = true
    }

    const execution = adapter.executePreparedRun({
      prepared,
      expectedScopeId: prepared.readyToolHostIdentity.scopeId,
      emitStartedProjection: () => {},
      resolveContext: async () => ({
        turnBuildContext: {
          turnRequestId: `turn-request-${stage}-pending`,
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
          onProvisionalDelta: () => {},
        },
      }),
    })
    const state = await Promise.race([
      execution.then(() => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ])
    assert.equal(state, 'pending')
    assert.equal(candidates.length, 0)
    assert.equal(lifecycleStore.calls.includes('bindStartedThread'), false)
    assert.deepEqual(nativeRuntime.calls, stage === 'thread' ? ['threadStart'] : ['turnStart'])
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
  const result = await adapter.stopSession(stopIdentity)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'stop')
  assert.deepEqual(nativeRuntime.calls, ['turnInterrupt'])
  assert.deepEqual(nativeRuntime.interrupts, [{ threadId: 'thread-1', turnId: 'turn-1' }])
  assert.deepEqual(lifecycleStore.calls, [
    'requestProductInterrupt',
    'acknowledgeProductInterrupt',
    'awaitProductCloseout',
  ])
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
})

test('stop durably settles an engine-terminal product turn instead of waiting for normal publication', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    engineTerminalRecorded: true,
  }

  const result = await adapter.stopSession(stopIdentity)

  assert.deepEqual(result, {
    ok: true,
    action: 'stop',
    aliasId: 'alias-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    terminal: 'interrupted',
    closeoutDigest: 'user-stop-closeout-digest',
    fenceReleaseRevision: 3,
  })
  assert.deepEqual(nativeRuntime.calls, [])
  assert.deepEqual(lifecycleStore.calls, ['settleEngineTerminalUserStop'])
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
})

test('engine-terminal user stop returns a visible persistence failure without clearing the active UI', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    engineTerminalRecorded: true,
  }
  lifecycleStore.failAt.set('settleEngineTerminalUserStop', 'persistence_failed')

  const result = await adapter.stopSession(stopIdentity)

  assert.deepEqual(result, {
    ok: false,
    action: 'stop',
    code: 'persistence_failed',
    preserveUi: true,
    aliasId: 'alias-1',
    aliasGeneration: 1,
    evidenceDigest: 'evidence:stop:product_turn_engine_terminal_closeout_pending',
  })
  assert.deepEqual(nativeRuntime.calls, [])
  assert.deepEqual(lifecycleStore.calls, ['settleEngineTerminalUserStop'])
})

test('boot recovery treats durable closeout as complete when only its UI notification fails', () => {
  const failures: string[] = []
  let cleaned = 0
  runCodexEngineTerminalFinalization({
    deliver() { throw new Error('terminal_publish_failed') },
    cleanup() { cleaned += 1 },
    onDeliveryFailure(error) {
      failures.push(error instanceof Error ? error.message : String(error))
    },
  })
  assert.equal(cleaned, 1)
  assert.deepEqual(failures, ['terminal_publish_failed'])
})

test('pending engine-terminal finalizations cannot overwrite another run in the same generation', () => {
  const pending = new Map<string, string>()
  pending.set(buildCodexEngineTerminalFinalizationKey({
    ...aliasIdentity,
    readyRunId: 'run-A',
  }), 'A')
  pending.set(buildCodexEngineTerminalFinalizationKey({
    ...aliasIdentity,
    readyRunId: 'run-B',
  }), 'B')

  assert.equal(pending.size, 2)
  assert.equal(pending.get(buildCodexEngineTerminalFinalizationKey({
    ...aliasIdentity,
    readyRunId: 'run-A',
  })), 'A')
  assert.equal(pending.get(buildCodexEngineTerminalFinalizationKey({
    ...aliasIdentity,
    readyRunId: 'run-B',
  })), 'B')
})

test('failed publish still cleans up and the next idle stop publishes the pending terminal once', async () => {
  const { adapter, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    allNativeThreadAttemptsSettled: true,
  }
  let pending = true
  let publishAttempts = 0
  let published = 0
  let cleanupRuns = 0
  lifecycleStore.retryEngineTerminalUserStopFinalization = async () => {
    lifecycleStore.calls.push('retryEngineTerminalUserStopFinalization')
    if (!pending) return null
    runCodexEngineTerminalFinalization({
      deliver() {
        publishAttempts += 1
        if (publishAttempts === 1) throw new Error('terminal_publish_failed')
        published += 1
      },
      cleanup() { cleanupRuns += 1 },
    })
    pending = false
    return {
      aliasId: 'alias-1',
      aliasGeneration: 1,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      terminal: 'interrupted',
      closeoutDigest: 'user-stop-closeout-digest',
      fenceReleaseRevision: 3,
    }
  }

  const first = await adapter.stopSession(stopIdentity)
  assert.equal(first.ok, false)
  if (!first.ok) assert.equal(first.code, 'persistence_failed')
  assert.equal(cleanupRuns, 1)
  assert.equal(published, 0)

  const second = await adapter.stopSession(stopIdentity)
  assert.equal(second.ok, true)
  assert.equal(cleanupRuns, 2)
  assert.equal(publishAttempts, 2)
  assert.equal(published, 1)

  const third = await adapter.stopSession(stopIdentity)
  assert.equal(third.ok, false)
  if (!third.ok) assert.equal(third.code, 'no_active_operation')
  assert.equal(published, 1)
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

  const result = await adapter.stopSession(stopIdentity)

  assert.equal(result.ok, true)
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
  assert.deepEqual(nativeRuntime.interrupts, [{ threadId: 'thread-1', turnId: 'turn-1' }])
})

test('a late stop for run A cannot interrupt run B in the same alias generation', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.activeReadyRunId = 'run-B'
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-B',
    activeFence: 'product_turn',
    productRunNonterminal: true,
  }

  const result = await adapter.stopSession(stopIdentity)

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'no_active_operation')
  assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
  assert.deepEqual(lifecycleStore.calls, [])
  assert.deepEqual(nativeRuntime.calls, [])
})

test('late close and reset requests cannot act on a different run in the same generation', async () => {
  for (const action of ['close', 'reset'] as const) {
    for (const request of [
      { ...aliasIdentity, readyRunId: 'run-A' },
      idleLifecycleIdentity,
    ]) {
      const { adapter, nativeRuntime, lifecycleStore } = createHarness()
      lifecycleStore.activeReadyRunId = 'run-B'
      lifecycleStore.facts = {
        ...idleNever,
        readyRunCreated: true,
        codexThreadId: 'thread-1',
        codexTurnId: 'turn-B',
        activeFence: 'product_turn',
        productRunNonterminal: true,
      }

      const result = action === 'close'
        ? await adapter.closeSession(request)
        : await adapter.resetSession(request)

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'no_active_operation')
      assert.equal(lifecycleStore.lifecycleFactReadCount, 1)
      assert.deepEqual(lifecycleStore.calls, [])
      assert.deepEqual(nativeRuntime.calls, [])
    }
  }
})

test('close and reset retry only their own durable unknown action', async () => {
  for (const action of ['close', 'reset'] as const) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.requestedAction = action
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      activeFence: 'product_turn',
      productRunNonterminal: true,
      interruptStateUnknown: true,
    }
    nativeRuntime.interruptReadTurnStatus = 'completed'

    const result = action === 'close'
      ? await adapter.closeSession(activeLifecycleIdentity)
      : await adapter.resetSession(activeLifecycleIdentity)

    assert.equal(result.ok, true)
    assert.deepEqual(nativeRuntime.calls, ['threadRead'])
    assert.equal(lifecycleStore.calls.includes('settleReadbackTerminalUserStop'), true)

    const conflicting = createHarness()
    conflicting.lifecycleStore.requestedAction = action === 'close' ? 'reset' : 'close'
    conflicting.lifecycleStore.facts = { ...lifecycleStore.facts }
    const conflict = action === 'close'
      ? await conflicting.adapter.closeSession(activeLifecycleIdentity)
      : await conflicting.adapter.resetSession(activeLifecycleIdentity)
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.code, 'binding_conflict')
    assert.deepEqual(conflicting.nativeRuntime.calls, [])
    assert.deepEqual(conflicting.lifecycleStore.calls, [])
  }
})

test('host-failure settlement cannot retarget an old close or reset request to a new run', async () => {
  for (const action of ['close', 'reset'] as const) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.activeReadyRunId = 'run-A'
    lifecycleStore.activeReadyRunIdAfterFirstRead = 'run-B'
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      hostFailureEvidenceComplete: true,
    }
    lifecycleStore.factsAfterFirstRead = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-B',
      activeFence: 'product_turn',
      productRunNonterminal: true,
    }

    const request = { ...aliasIdentity, readyRunId: 'run-A' }
    const result = action === 'close'
      ? await adapter.closeSession(request)
      : await adapter.resetSession(request)

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'binding_conflict')
    assert.equal(lifecycleStore.lifecycleFactReadCount, 2)
    assert.deepEqual(lifecycleStore.calls, ['settleHostFailureCloseout'])
    assert.deepEqual(nativeRuntime.calls, [])
  }
})

test('reset remains blocked while interrupt state is unknown or a native start is pending', async () => {
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
    const result = await adapter.resetSession(activeLifecycleIdentity)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.preserveUi, true)
    assert.deepEqual(nativeRuntime.calls, [])
  }
})

test('reset quarantines an exact unknown manual compaction and advances the alias generation', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.activeReadyRunId = null
  lifecycleStore.activeManualCompactionId = 'manual-unknown-1'
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    activeFence: 'manual_compaction',
    allNativeThreadAttemptsSettled: true,
    manualCompactionState: 'unknown',
  }

  const result = await adapter.resetSession(idleLifecycleIdentity)

  assert.deepEqual(result, {
    ok: true,
    action: 'reset',
    aliasId: 'alias-1',
    retiredGeneration: 1,
    newGeneration: 2,
    transactionDigest: 'manual-quarantine-digest',
  })
  assert.deepEqual(lifecycleStore.calls, ['quarantineUnknownManualCompaction'])
  assert.deepEqual(nativeRuntime.calls, [])
})

test('stop retries an exact interrupt-unknown run after reading the bound native turn', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    interruptStateUnknown: true,
  }
  nativeRuntime.interruptReadTurnStatus = 'inProgress'

  const result = await adapter.stopSession(stopIdentity)

  assert.equal(result.ok, true)
  assert.deepEqual(nativeRuntime.calls, ['threadRead', 'turnInterrupt'])
  assert.deepEqual(nativeRuntime.interrupts, [{ threadId: 'thread-1', turnId: 'turn-1' }])
  assert.deepEqual(lifecycleStore.calls, [
    'requestProductInterrupt',
    'acknowledgeProductInterrupt',
    'awaitProductCloseout',
  ])
})

test('stop closes an exact terminal readback without dispatching another interrupt', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    interruptStateUnknown: true,
  }
  nativeRuntime.interruptReadTurnStatus = 'interrupted'

  const result = await adapter.stopSession(stopIdentity)

  assert.deepEqual(result, {
    ok: true,
    action: 'stop',
    aliasId: 'alias-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    terminal: 'interrupted',
    closeoutDigest: 'readback-user-stop-closeout-digest',
    fenceReleaseRevision: 4,
  })
  assert.deepEqual(nativeRuntime.calls, ['threadRead'])
  assert.deepEqual(lifecycleStore.calls, ['settleReadbackTerminalUserStop'])
})

test('stop keeps interrupt state unknown when native readback cannot prove the exact turn', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.facts = {
    ...idleNever,
    readyRunCreated: true,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    activeFence: 'product_turn',
    productRunNonterminal: true,
    interruptStateUnknown: true,
  }
  nativeRuntime.interruptReadTurnId = 'turn-other'

  const result = await adapter.stopSession(stopIdentity)

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'interrupt_state_unknown')
  assert.deepEqual(nativeRuntime.calls, ['threadRead'])
  assert.deepEqual(nativeRuntime.interrupts, [])
  assert.deepEqual(lifecycleStore.calls, [])
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
    const result = await adapter.closeSession(idleLifecycleIdentity)
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
  const active = await adapter.closeSession(activeLifecycleIdentity)
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
  if (result.ok && result.action === 'manual_compact') {
    assert.equal(result.contextCompactionItemId, 'compact-readback-item-1')
  }
  assert.equal(
    lifecycleStore.consumedManualCompaction?.notificationContextCompactionItemId,
    'compact-notification-item-1',
  )
  assert.equal(
    lifecycleStore.consumedManualCompaction?.contextCompactionItemId,
    'compact-readback-item-1',
  )
  assert.deepEqual(nativeRuntime.calls, ['threadCompactStart', 'threadRead'])
  assert.deepEqual(lifecycleStore.calls, [
    'beginManualCompaction',
    'awaitManualCompaction',
    'consumeManualCompaction',
  ])
})

test('pinned native capture keeps manual compaction notification and readback item identities separate', () => {
  const capture = JSON.parse(readFileSync(
    new URL('../../assets/codex-runtime/fixtures/native-protocol-capture.json', import.meta.url),
    'utf8',
  )) as {
    manualCompaction: {
      item: { params: { item: { id: string }; turnId: string } }
      readback: { thread: { turns: CodexTurn[] } }
    }
  }
  const notification = capture.manualCompaction.item.params
  const readbackTurn = capture.manualCompaction.readback.thread.turns.find(
    (turn) => turn.id === notification.turnId,
  )
  const readbackItems = readbackTurn?.items.filter((item) => item.type === 'contextCompaction') || []
  assert.equal(readbackItems.length, 1)
  assert.notEqual(notification.item.id, readbackItems[0].id)
})

test('reset persistence failure preserves the current generation and performs no native operation', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  lifecycleStore.failAt.set('resetIdleAlias', 'persistence_failed')

  const result = await adapter.resetSession(idleLifecycleIdentity)

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
    const result = await adapter.createSession({ agentId: 'butler' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.action, 'create')
    assert.equal(result.code, 'persistence_failed')
    assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/)
  }

  {
    const { adapter, lifecycleStore } = createHarness()
    lifecycleStore.failAt.set('readLifecycleOperation', 'persistence_failed')
    assert.deepEqual(await adapter.resetSession(idleLifecycleIdentity), {
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
    const result = await adapter.resetSession(idleLifecycleIdentity)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'persistence_failed')
    assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/)
  }
})

test('stop after a retired generation is an idempotent no-active operation', async () => {
  const { adapter, lifecycleStore } = createHarness()
  lifecycleStore.readLifecycleOperation = async () => {
    throw new Error('active_alias_generation_mismatch')
  }
  const result = await adapter.stopSession({
    aliasId: 'alias-1',
    aliasGeneration: 3,
    readyRunId: 'req-closed-run',
  })
  assert.deepEqual(result, {
    ok: false,
    action: 'stop',
    code: 'no_active_operation',
    preserveUi: true,
    aliasId: 'alias-1',
    aliasGeneration: 3,
    evidenceDigest: 'evidence:stop:invariant_violation',
  })
})

test('stale alias generation fails closed after one consistent lifecycle read and no native operation', async () => {
  const { adapter, nativeRuntime, lifecycleStore } = createHarness()
  const result = await adapter.closeSession({
    aliasId: 'alias-1', aliasGeneration: 2, readyRunId: null,
  })

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

test('interrupt rejection, Ready acknowledgement failure, and closeout timeout remain interrupt_state_unknown', async () => {
  for (const failAt of [
    'turnInterrupt',
    'acknowledgeProductInterrupt',
    'awaitProductCloseout',
  ] as const) {
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

    const result = await adapter.stopSession(stopIdentity)

    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'interrupt_state_unknown')
    assert.equal(result.preserveUi, true)
    assert.equal(lifecycleStore.calls.includes('requestProductInterrupt'), true)
    assert.equal(lifecycleStore.calls.includes('markProductInterruptUnknown'), true)
  }
})

test('benign no-active interrupt rejection reconciles only the exact terminal turn', async () => {
  for (const readback of [
    { turnId: 'turn-1', status: 'completed' as const, expectedOk: true },
    { turnId: 'turn-1', status: 'inProgress' as const, expectedOk: false },
    { turnId: 'turn-other', status: 'completed' as const, expectedOk: false },
  ]) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      activeFence: 'product_turn',
      productRunNonterminal: true,
    }
    nativeRuntime.interruptError = new CodexAppServerClientError('rpc_rejected', {
      code: -32600,
      message: 'no active turn to interrupt',
    })
    nativeRuntime.interruptReadTurnId = readback.turnId
    nativeRuntime.interruptReadTurnStatus = readback.status

    const result = await adapter.stopSession(stopIdentity)

    assert.equal(result.ok, readback.expectedOk)
    assert.deepEqual(nativeRuntime.calls.slice(0, 2), ['turnInterrupt', 'threadRead'])
    if (readback.expectedOk) {
      assert.equal(lifecycleStore.calls.includes('acknowledgeProductInterrupt'), false)
      assert.equal(lifecycleStore.calls.includes('markProductInterruptUnknown'), false)
      assert.equal(lifecycleStore.calls.includes('awaitProductCloseout'), true)
    } else {
      assert.equal(lifecycleStore.calls.includes('markProductInterruptUnknown'), true)
      assert.equal(lifecycleStore.calls.includes('awaitProductCloseout'), false)
    }
  }
})

test('close and reset share the same exact-terminal interrupt reconciliation', async () => {
  for (const action of ['close', 'reset'] as const) {
    const { adapter, nativeRuntime, lifecycleStore } = createHarness()
    lifecycleStore.facts = {
      ...idleNever,
      readyRunCreated: true,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      activeFence: 'product_turn',
      productRunNonterminal: true,
    }
    nativeRuntime.interruptError = new CodexAppServerClientError('rpc_rejected', {
      code: -32600,
      message: 'no active turn to interrupt',
    })

    const result = action === 'close'
      ? await adapter.closeSession(activeLifecycleIdentity)
      : await adapter.resetSession(activeLifecycleIdentity)

    assert.equal(result.ok, true)
    assert.deepEqual(nativeRuntime.calls.slice(0, 2), ['turnInterrupt', 'threadRead'])
    assert.equal(lifecycleStore.calls.includes('acknowledgeProductInterrupt'), false)
    assert.equal(lifecycleStore.calls.includes('markProductInterruptUnknown'), false)
    assert.equal(lifecycleStore.calls.includes('awaitProductCloseout'), true)
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
    assert.equal(lifecycleStore.calls.includes('markManualCompactionUnknown'), true)
  }
})
