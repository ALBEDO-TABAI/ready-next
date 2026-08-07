import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  CodexProductRunPreparer,
  type PreparedCodexProductRun,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import type { CodexNativeRuntime } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import {
  CodexTurnCollector,
  createHostFailureCandidate,
  type CoreTurnCandidate,
} from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import {
  CodexTurnInputBuilder,
  textUserInput,
} from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import {
  ReadyCodexLifecycleAdapter,
  type ReadyCodexLifecycleStore,
} from '../main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter'
import type { ExecutionHostResult } from '../main/modules/agent-control/contracts/run-contracts'
import type { ConversationScope, ScopeRunEventPayload } from '../main/modules/agent-control/contracts/types'
import { CodexHostOrchestrator } from '../main/modules/agent-control/runtime-core/codex-host-orchestrator'
import {
  RunCoordinator,
  type ReadyCodexCloseoutReadback,
} from '../main/modules/agent-control/task-projection/run-coordinator'
import { parseSendScopedResponse } from '../shared/ipc-contracts/agent-runtime'

const scope: ConversationScope = {
  id: 'alias-1',
  agent: 'butler',
  activeAgentId: 'butler',
  handoffGeneration: 0,
  title: 'Codex test',
  sourceKind: 'local',
  sourceId: 'app',
  threadKey: 'alias-1',
  meta: {},
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  lastMessageAt: null,
}

const preparationInput = {
  taskId: 'task-1',
  runId: 'run-1',
  requestId: 'request-1',
  scopeId: scope.id,
  aliasId: scope.id,
  aliasGeneration: 1,
  taskOrigin: 'user_root' as const,
  runOrigin: 'initial' as const,
  originUserMessageId: 'message-1',
  reservationSetId: 'reservation-set-1',
  reservationEvidenceDigest: 'reservation-evidence-1',
  currentInput: [textUserInput('hello')],
  explicitResourceEnvelope: { input: [], resourceRefs: [] },
  resourceAdditionalContext: [],
  readyToolSurface: {
    surfaceId: 'surface-1',
    toolSurfaceDigest: 'surface-digest',
    toolNames: ['ready_read'],
  },
  readyTurnToolAuthorization: {
    authorizationId: 'authorization-1',
    authorizationDigest: 'authorization-digest',
  },
  authorizationOwnerId: 'authorization-owner-1',
  resourceOwnerId: 'resource-owner-1',
  productBudgetSeed: {
    maxIterations: 8,
    maxToolCalls: 4,
    maxParallelToolGroups: 1,
  },
}

const preparedResult = new CodexProductRunPreparer().prepare(preparationInput)
assert.equal(preparedResult.ok, true)
const preparedRun = (preparedResult as { ok: true; prepared: PreparedCodexProductRun }).prepared

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function terminalEvent(
  phase: ScopeRunEventPayload['phase'],
  terminalReason: ScopeRunEventPayload['terminalReason'],
): ScopeRunEventPayload {
  return {
    type: 'updated',
    scopeId: scope.id,
    agent: scope.agent,
    runId: preparedRun.runId,
    taskId: preparedRun.taskId,
    ownerAgentId: scope.agent,
    taskOrigin: 'user_root',
    handoffGeneration: 0,
    phase,
    terminalReason,
    taskProjectionId: preparedRun.taskId,
    timestamp: '2026-08-07T00:00:02.000Z',
  }
}

function successCloseoutReadback(): ReadyCodexCloseoutReadback {
  const canonicalMessage = {
    id: 'assistant-1',
    conversationId: scope.id,
    role: 'assistant' as const,
    content: 'done',
    timestamp: '2026-08-07T00:00:01.000Z',
    meta: {},
  }
  return {
    execution: {
      success: true,
      finalText: 'done',
      cancelled: false,
      usedTools: [],
      taskId: preparedRun.taskId,
      terminalReason: 'done',
      canonicalMessage,
      canonicalMessageDigest: digestJson(canonicalMessage),
    },
    productOutcomeDigest: 'product-outcome-digest',
    candidateBodyDigest: digestText('done'),
    committedTerminalEvent: terminalEvent('done', 'done'),
  }
}

function failureCloseoutReadback(productOutcomeDigest = 'product-outcome-digest'): ReadyCodexCloseoutReadback {
  return {
    execution: {
      success: false,
      finalText: '',
      cancelled: false,
      usedTools: [],
      error: 'prepared context unavailable',
      taskId: preparedRun.taskId,
      terminalReason: 'persistence_failed',
    },
    productOutcomeDigest,
    candidateBodyDigest: null,
    committedTerminalEvent: terminalEvent('error', 'persistence_failed'),
  }
}

function createUnusedNativeRuntime(): CodexNativeRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('native runtime must not be called before context resolution')
  }
  return {
    initialize: unused,
    threadStart: unused,
    threadRead: unused,
    threadResume: unused,
    threadArchive: unused,
    turnStart: unused,
    turnInterrupt: unused,
    threadCompactStart: unused,
    subscribe: () => () => undefined,
  }
}

function createHostFailureAdapter(candidates: CoreTurnCandidate[]) {
  const nativeRuntime = createUnusedNativeRuntime()
  return new ReadyCodexLifecycleAdapter<{
    execution: ExecutionHostResult
    productOutcomeDigest: string
    candidateBodyDigest: string | null
    committedTerminalEvent: ScopeRunEventPayload
  }>({
    nativeRuntime,
    collector: new CodexTurnCollector(nativeRuntime),
    inputBuilder: new CodexTurnInputBuilder(),
    lifecycleStore: {} as ReadyCodexLifecycleStore,
    closeout: {
      async closeCandidate(candidate) {
        candidates.push(candidate)
        assert.equal(candidate.kind, 'host_failure')
        return {
          execution: {
            success: false,
            finalText: '',
            cancelled: false,
            usedTools: [],
            error: candidate.hostFailure.message,
            taskId: candidate.readyTaskId,
            terminalReason: 'persistence_failed',
          },
          productOutcomeDigest: candidate.hostFailure.evidenceDigest,
          candidateBodyDigest: null,
          committedTerminalEvent: terminalEvent('error', 'persistence_failed'),
        }
      },
      recoverRejectedCandidate({ candidate, error }) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          execution: {
            success: false,
            finalText: '',
            cancelled: false,
            usedTools: [],
            error: message,
            taskId: candidate.readyTaskId,
            terminalReason: 'persistence_failed',
          },
          productOutcomeDigest: `recovery:${candidate.readyRunId}`,
          candidateBodyDigest: null,
          committedTerminalEvent: terminalEvent('error', 'persistence_failed'),
        }
      },
      observeCandidateReadback() {
        throw new Error('no pending closeout expected')
      },
    },
  })
}

test('real runScoped Codex branch prepares neutrally and never touches prompt assembly', async () => {
  const events: ScopeRunEventPayload[] = []
  const host = new CodexHostOrchestrator({})
  let executions = 0
  const codexDeps = {
    executeCodexPrepared: async ({
      prepared,
      emitStartedProjection,
    }: {
      prepared: PreparedCodexProductRun
      emitStartedProjection: () => void
    }) => {
      emitStartedProjection()
      executions += 1
      for (const forbidden of ['systemPrompt', 'persona', 'memoryRefs', 'deliveryMode', 'workflow']) {
        assert.equal(forbidden in prepared, false, forbidden)
      }
      assert.deepEqual(host.inspectActiveRunIfMatches(scope.agent, scope.id, 'request-1'), {
        state: 'active',
        runId: 'request-1',
      })
      assert.deepEqual(host.inspectActiveRunIfMatches(scope.agent, scope.id, 'stale-request'), {
        state: 'stale',
        runId: null,
        activeRunId: 'request-1',
      })
      assert.equal(host.isScopeLive(scope.agent, scope.id), true)
      assert.equal(host.getActiveRunCount(), 1)
      assert.equal(host.listAllSessions()[0]?.sessionId, scope.id)
      assert.equal(host.refreshActiveRunProgress(scope.agent, scope.id, 'request-1'), true)
      return {
        state: 'closed' as const,
        result: {
          execution: {
            success: true,
            finalText: 'done',
            cancelled: false,
            usedTools: [],
            taskId: prepared.taskId,
            terminalReason: 'done',
            canonicalMessage: {
              id: 'assistant-1',
              conversationId: scope.id,
              role: 'assistant',
              content: 'done',
              timestamp: '2026-08-07T00:00:01.000Z',
              meta: {},
            },
            canonicalMessageDigest: digestJson({
              id: 'assistant-1',
              conversationId: scope.id,
              role: 'assistant',
              content: 'done',
              timestamp: '2026-08-07T00:00:01.000Z',
              meta: {},
            }),
          },
          productOutcomeDigest: 'product-outcome-digest',
          candidateBodyDigest: digestText('done'),
          committedTerminalEvent: terminalEvent('done', 'done'),
        },
      }
    },
    observeCodexCloseoutReadback: () => { throw new Error('no pending closeout expected') },
    emitStartedScopeRunEvent: (event: ScopeRunEventPayload) => { events.push(event) },
    publishCommittedTerminalEvent: (event: ScopeRunEventPayload) => { events.push(event) },
    onRunStarted: ({ requestId, prepared, scope: activeScope }) => host.beginActiveProductRun({
      agent: activeScope.agent,
      scopeId: activeScope.id,
      requestId,
      runId: prepared.runId,
    }),
    onRunSettled: ({ requestId, scope: activeScope }) => host.finishActiveProductRun({
      agent: activeScope.agent,
      scopeId: activeScope.id,
      requestId,
    }),
  }
  const coordinator = new RunCoordinator(codexDeps)

  const result = await coordinator.runScoped({
    requestId: 'request-1',
    scope,
    preparedCodexRun: preparedRun,
  })

  assert.equal(result.success, true)
  assert.equal(result.responseText, 'done')
  assert.equal(executions, 1)
  assert.deepEqual(events.map((event) => event.phase), ['planning', 'done'])
  assert.equal(host.isScopeLive(scope.agent, scope.id), false)
  assert.equal(host.getActiveRunCount(), 0)
})

test('real runScoped routes prepared-context rejection through one Ready closeout', async () => {
  const events: ScopeRunEventPayload[] = []
  const candidates: CoreTurnCandidate[] = []
  const host = new CodexHostOrchestrator({})
  let started = 0
  let settled = 0
  let failureHooks = 0
  const adapter = createHostFailureAdapter(candidates)
  const coordinator = new RunCoordinator({
    executeCodexPrepared: ({ prepared, scope: activeScope, emitStartedProjection }) => adapter.executePreparedRun({
      prepared,
      expectedScopeId: activeScope.id,
      emitStartedProjection,
      resolveContext: async () => {
        throw new Error('prepared_context_resolution_failed')
      },
    }),
    observeCodexCloseoutReadback: (input, onReadback) => (
      adapter.observeRunCloseout({
        prepared: input.prepared,
        expectedScopeId: input.scope.id,
        pending: input.pending,
      }, onReadback)
    ),
    emitStartedScopeRunEvent: (event) => { events.push(event) },
    publishCommittedTerminalEvent: (event) => { events.push(event) },
    onRunStarted: ({ requestId, prepared, scope: activeScope }) => {
      started += 1
      host.beginActiveProductRun({
        agent: activeScope.agent,
        scopeId: activeScope.id,
        requestId,
        runId: prepared.runId,
      })
    },
    onRunSettled: ({ requestId, scope: activeScope }) => {
      settled += 1
      host.finishActiveProductRun({
        agent: activeScope.agent,
        scopeId: activeScope.id,
        requestId,
      })
    },
  })

  const result = await coordinator.runScoped({
    requestId: 'request-context-failure',
    scope,
    preparedCodexRun: preparedRun,
  }, {
    onFailure: async () => { failureHooks += 1 },
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'prepared_context_resolution_failed')
  assert.equal(result.errorKind, 'persistence_failed')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'host_failure')
  if (candidates[0]?.kind === 'host_failure') {
    assert.equal(candidates[0].hostFailure.stage, 'prepared_run_context')
  }
  assert.deepEqual(events.map((event) => event.phase), ['planning', 'error'])
  assert.equal(started, 1)
  assert.equal(settled, 1)
  assert.equal(failureHooks, 1)
  assert.equal(host.getActiveRunCount(), 0)
})

test('real runScoped routes started-projection failure through one Ready closeout', async () => {
  const candidates: CoreTurnCandidate[] = []
  const adapter = createHostFailureAdapter(candidates)
  const host = new CodexHostOrchestrator({})
  let projectionAttempts = 0
  let terminalPublications = 0
  let contextResolutions = 0
  let started = 0
  let settled = 0
  const coordinator = new RunCoordinator({
    executeCodexPrepared: ({ prepared, scope: activeScope, emitStartedProjection }) => adapter.executePreparedRun({
      prepared,
      expectedScopeId: activeScope.id,
      emitStartedProjection,
      resolveContext: async () => {
        contextResolutions += 1
        throw new Error('context must not resolve after started projection fails')
      },
    }),
    observeCodexCloseoutReadback: (input, onReadback) => (
      adapter.observeRunCloseout({
        prepared: input.prepared,
        expectedScopeId: input.scope.id,
        pending: input.pending,
      }, onReadback)
    ),
    emitStartedScopeRunEvent: () => {
      projectionAttempts += 1
      throw new Error('started_projection_persistence_failed')
    },
    publishCommittedTerminalEvent: () => { terminalPublications += 1 },
    onRunStarted: ({ requestId, prepared, scope: activeScope }) => {
      started += 1
      host.beginActiveProductRun({
        agent: activeScope.agent,
        scopeId: activeScope.id,
        requestId,
        runId: prepared.runId,
      })
    },
    onRunSettled: ({ requestId, scope: activeScope }) => {
      settled += 1
      host.finishActiveProductRun({
        agent: activeScope.agent,
        scopeId: activeScope.id,
        requestId,
      })
    },
  })

  const result = await coordinator.runScoped({
    requestId: 'request-started-projection-failure',
    scope,
    preparedCodexRun: preparedRun,
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'started_projection_persistence_failed')
  assert.equal(result.errorKind, 'persistence_failed')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'host_failure')
  if (candidates[0]?.kind === 'host_failure') {
    assert.equal(candidates[0].hostFailure.stage, 'started_projection')
    assert.equal(candidates[0].hostFailure.code, 'started_projection_failed')
  }
  assert.equal(contextResolutions, 0)
  assert.equal(projectionAttempts, 1, 'only the nonterminal started projection writes product state')
  assert.equal(terminalPublications, 1, 'the committed terminal readback is notification-only')
  assert.equal(started, 1)
  assert.equal(settled, 1)
  assert.equal(host.getActiveRunCount(), 0)
})

test('post-admission scope mismatch reaches Ready closeout instead of returning a raw rejection', async () => {
  const candidates: CoreTurnCandidate[] = []
  const adapter = createHostFailureAdapter(candidates)
  const coordinator = new RunCoordinator({
    executeCodexPrepared: ({ prepared, scope: activeScope, emitStartedProjection }) => (
      adapter.executePreparedRun({
        prepared,
        expectedScopeId: `${activeScope.id}-mismatch`,
        emitStartedProjection,
        resolveContext: async () => { throw new Error('must not resolve') },
      })
    ),
    observeCodexCloseoutReadback: (input, onReadback) => (
      adapter.observeRunCloseout({
        prepared: input.prepared,
        expectedScopeId: input.scope.id,
        pending: input.pending,
      }, onReadback)
    ),
    emitStartedScopeRunEvent: () => {},
    publishCommittedTerminalEvent: () => {},
    onRunStarted: () => {},
    onRunSettled: () => {},
  })

  const result = await coordinator.runScoped({
    requestId: 'request-invalid-scope',
    scope,
    preparedCodexRun: preparedRun,
  })

  assert.equal(result.success, false)
  assert.equal(result.errorKind, 'persistence_failed')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'host_failure')
  if (candidates[0]?.kind === 'host_failure') {
    assert.equal(candidates[0].hostFailure.stage, 'prepared_run_validation')
    assert.equal(candidates[0].hostFailure.code, 'invalid_product_ingress')
  }
})

test('pending closeout keeps one active operation until durable readback is observed', async () => {
  const candidate = createHostFailureCandidate({
    readyTaskId: preparedRun.taskId,
    readyRunId: preparedRun.runId,
    scopeId: scope.id,
    codexThreadId: null,
    actionReceiptRefs: [],
    interactionState: null,
    waitingFor: null,
    abortInitiator: null,
    budgetState: {},
    contextState: {},
    providerDiagnostics: {},
    recoveryCheckpointRef: null,
    browserContinuationRef: null,
    browserProofRefs: [],
    otherProofRefs: [],
    projectionPatchRefs: [],
  }, {
    stage: 'prepared_run_context',
    code: 'prepared_run_context_resolution_failed',
    error: new Error('prepared context unavailable'),
    codexTurnId: null,
  })
  let readbackObserver: ((readback: {
    execution: ExecutionHostResult
    productOutcomeDigest: string
    candidateBodyDigest: string | null
    committedTerminalEvent: ScopeRunEventPayload
  }) => void) | null = null
  let observerRegistrations = 0
  let terminalPublications = 0
  let starts = 0
  let settlements = 0
  let unsubscribes = 0
  const coordinator = new RunCoordinator({
    executeCodexPrepared: async ({ emitStartedProjection }) => {
      emitStartedProjection()
      return {
        state: 'ready_closeout_pending' as const,
        pendingKind: 'host_failure_closeout_pending' as const,
        candidate,
        recoveryEvidenceDigest: 'pending-evidence-digest',
        error: 'ready_closeout_pending',
      }
    },
    observeCodexCloseoutReadback: (_input, onReadback) => {
      observerRegistrations += 1
      readbackObserver = onReadback
      return () => { unsubscribes += 1 }
    },
    emitStartedScopeRunEvent: () => {},
    publishCommittedTerminalEvent: () => { terminalPublications += 1 },
    onRunStarted: () => { starts += 1 },
    onRunSettled: () => { settlements += 1 },
  })

  let wireResolved = false
  const wirePromise = coordinator.runScoped({
    requestId: 'request-pending-closeout',
    scope,
    preparedCodexRun: preparedRun,
  }).then((result) => {
    wireResolved = true
    return result
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(wireResolved, false)
  assert.equal(observerRegistrations, 1)
  assert.equal(starts, 1)
  assert.equal(settlements, 0)
  assert.equal(terminalPublications, 0)

  const observer = readbackObserver as null | ((readback: {
    execution: ExecutionHostResult
    productOutcomeDigest: string
    candidateBodyDigest: string | null
    committedTerminalEvent: ScopeRunEventPayload
  }) => void)
  assert.notEqual(observer, null)
  observer?.({
    execution: {
      success: false,
      finalText: '',
      cancelled: false,
      usedTools: [],
      error: 'prepared context unavailable',
      taskId: preparedRun.taskId,
      terminalReason: 'persistence_failed',
    },
    productOutcomeDigest: 'product-outcome-digest',
    candidateBodyDigest: null,
    committedTerminalEvent: terminalEvent('error', 'persistence_failed'),
  })
  const result = await wirePromise

  assert.equal(result.success, false)
  assert.equal(observerRegistrations, 1)
  assert.equal(unsubscribes, 1)
  assert.equal(terminalPublications, 1)
  assert.equal(settlements, 1)
})

test('malformed execution outcomes stay active until a valid durable readback', async () => {
  const cases: Array<[string, () => unknown]> = [
    ['null', () => null],
    ['empty object', () => ({})],
    ['closed without result', () => ({ state: 'closed' })],
    ['closed with null result', () => ({ state: 'closed', result: null })],
    ['future state', () => ({ state: 'future', result: successCloseoutReadback() })],
    ['malformed pending state', () => ({
      state: 'ready_closeout_pending',
      pendingKind: 'host_failure_closeout_pending',
      candidate: { readyTaskId: 'foreign-task', readyRunId: preparedRun.runId, scopeId: scope.id },
      recoveryEvidenceDigest: '',
      error: '',
    })],
    ['execution rejection', () => { throw new Error('malformed_execution_rejection') }],
  ]

  for (const [name, createOutcome] of cases) {
    let observedReadback: ((readback: unknown) => void) | null = null
    let publications = 0
    let settlements = 0
    let observerPending: unknown = 'not-observed'
    const coordinator = new RunCoordinator({
      executeCodexPrepared: async ({ emitStartedProjection }) => {
        emitStartedProjection()
        return createOutcome()
      },
      observeCodexCloseoutReadback: (input, onReadback) => {
        observerPending = input.pending
        observedReadback = onReadback
        return () => undefined
      },
      emitStartedScopeRunEvent: () => {},
      publishCommittedTerminalEvent: () => { publications += 1 },
      onRunStarted: () => {},
      onRunSettled: () => { settlements += 1 },
    })

    let wireResolved = false
    const wirePromise = coordinator.runScoped({
      requestId: `request-malformed-outcome-${name}`,
      scope,
      preparedCodexRun: preparedRun,
    }).then((result) => {
      wireResolved = true
      return result
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(wireResolved, false, name)
    assert.equal(observerPending, null, name)
    assert.equal(publications, 0, name)
    assert.equal(settlements, 0, name)

    const observer = observedReadback as null | ((readback: unknown) => void)
    assert.notEqual(observer, null, name)
    observer?.(successCloseoutReadback())
    const result = await wirePromise
    assert.equal(result.success, true, name)
    assert.equal(publications, 1, name)
    assert.equal(settlements, 1, name)
  }
})

test('an empty product digest cannot escape as a terminal failure wire', async () => {
  let observedReadback: ((readback: unknown) => void) | null = null
  let publications = 0
  let settlements = 0
  const coordinator = new RunCoordinator({
    executeCodexPrepared: async ({ emitStartedProjection }) => {
      emitStartedProjection()
      return { state: 'closed', result: failureCloseoutReadback('') }
    },
    observeCodexCloseoutReadback: (_input, onReadback) => {
      observedReadback = onReadback
      return () => undefined
    },
    emitStartedScopeRunEvent: () => {},
    publishCommittedTerminalEvent: () => { publications += 1 },
    onRunStarted: () => {},
    onRunSettled: () => { settlements += 1 },
  })

  let wireResolved = false
  const wirePromise = coordinator.runScoped({
    requestId: 'request-empty-product-digest',
    scope,
    preparedCodexRun: preparedRun,
  }).then((result) => {
    wireResolved = true
    return result
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(wireResolved, false)
  assert.equal(publications, 0)
  assert.equal(settlements, 0)

  const observer = observedReadback as null | ((readback: unknown) => void)
  observer?.(failureCloseoutReadback('durable-product-outcome-digest'))
  const result = await wirePromise
  assert.equal(result.success, false)
  if (result.success) assert.fail('expected terminal failure')

  const parsedWire = parseSendScopedResponse({
    success: false,
    disposition: 'terminal_failure_after_persistence',
    ownerRunId: 'request-empty-product-digest',
    shouldClearInput: true,
    preserveInput: false,
    retryableByUser: false,
    persistence: {
      scope: 'pre-existing',
      message: 'persisted',
      attachments: 'none',
      inputAttachments: 'none',
    },
    error: result.error,
    errorKind: result.errorKind,
    productOutcomeDigest: result.productOutcomeDigest,
  })
  assert.equal(parsedWire.productOutcomeDigest, 'durable-product-outcome-digest')
  assert.equal(publications, 1)
  assert.equal(settlements, 1)
})

test('contradictory closeout readbacks never publish or settle terminal truth', async () => {
  const cases: Array<[string, (readback: ReadyCodexCloseoutReadback) => ReadyCodexCloseoutReadback]> = [
    ['null readback root', () => null as unknown as ReadyCodexCloseoutReadback],
    ['null execution root', (readback) => ({
      ...readback,
      execution: null as unknown as ExecutionHostResult,
    })],
    ['null terminal event root', (readback) => ({
      ...readback,
      committedTerminalEvent: null as unknown as ScopeRunEventPayload,
    })],
    ['extra readback root field', (readback) => ({ ...readback, extra: 'forbidden' })],
    ['run identity', (readback) => ({
      ...readback,
      committedTerminalEvent: { ...readback.committedTerminalEvent, runId: 'run-other' },
    })],
    ['nonterminal phase', (readback) => ({
      ...readback,
      committedTerminalEvent: { ...readback.committedTerminalEvent, phase: 'tool_running' },
    })],
    ['terminal owner', (readback) => ({
      ...readback,
      committedTerminalEvent: { ...readback.committedTerminalEvent, ownerAgentId: 'agent-other' },
    })],
    ['handoff generation', (readback) => ({
      ...readback,
      committedTerminalEvent: { ...readback.committedTerminalEvent, handoffGeneration: 1 },
    })],
    ['terminal timestamp', (readback) => ({
      ...readback,
      committedTerminalEvent: { ...readback.committedTerminalEvent, timestamp: 'not-a-time' },
    })],
    ['done with failure reason', (readback) => ({
      ...readback,
      execution: { ...readback.execution, terminalReason: 'persistence_failed' },
      committedTerminalEvent: {
        ...readback.committedTerminalEvent,
        terminalReason: 'persistence_failed',
      },
    })],
    ['task projection identity', (readback) => ({
      ...readback,
      execution: { ...readback.execution, taskProjectionId: 'projection-other' },
      committedTerminalEvent: {
        ...readback.committedTerminalEvent,
        taskProjectionId: 'projection-other',
      },
    })],
    ['product outcome digest', (readback) => ({ ...readback, productOutcomeDigest: '' })],
    ['candidate body digest', (readback) => ({ ...readback, candidateBodyDigest: digestText('other') })],
    ['canonical digest', (readback) => ({
      ...readback,
      execution: { ...readback.execution, canonicalMessageDigest: digestText('forged') },
    })],
    ['canonical body', (readback) => {
      const canonicalMessage = {
        ...readback.execution.canonicalMessage!,
        content: 'rewritten by finalizer',
      }
      return {
        ...readback,
        execution: {
          ...readback.execution,
          canonicalMessage,
          canonicalMessageDigest: digestJson(canonicalMessage),
        },
      }
    }],
    ['canonical extra field', (readback) => {
      const canonicalMessage = {
        ...readback.execution.canonicalMessage!,
        extra: 'forbidden',
      }
      return {
        ...readback,
        execution: {
          ...readback.execution,
          canonicalMessage,
          canonicalMessageDigest: digestJson(canonicalMessage),
        },
      }
    }],
    ['malformed failure fields', (readback) => ({
      ...readback,
      execution: {
        success: false,
        finalText: '',
        cancelled: false,
        usedTools: [7] as never,
        error: { bad: true } as never,
        taskId: preparedRun.taskId,
        terminalReason: 'future_unknown' as never,
      },
      candidateBodyDigest: null,
      committedTerminalEvent: terminalEvent('error', 'future_unknown' as never),
    })],
  ]

  for (const [name, mutate] of cases) {
    let publications = 0
    let settlements = 0
    let observedReadback: ((readback: unknown) => void) | null = null
    const invalidReadback = mutate(successCloseoutReadback())
    const coordinator = new RunCoordinator({
      executeCodexPrepared: async ({ emitStartedProjection }) => {
        emitStartedProjection()
        return { state: 'closed' as const, result: invalidReadback }
      },
      observeCodexCloseoutReadback: (_input, onReadback) => {
        observedReadback = onReadback
        return () => undefined
      },
      emitStartedScopeRunEvent: () => {},
      publishCommittedTerminalEvent: () => { publications += 1 },
      onRunStarted: () => {},
      onRunSettled: () => { settlements += 1 },
    })

    let wireResolved = false
    const wirePromise = coordinator.runScoped({
      requestId: `request-contradictory-${name}`,
      scope,
      preparedCodexRun: preparedRun,
    }).then((result) => {
      wireResolved = true
      return result
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(wireResolved, false, name)
    assert.equal(publications, 0, name)
    assert.equal(settlements, 0, name)

    const observer = observedReadback as null | ((readback: unknown) => void)
    assert.notEqual(observer, null, name)
    observer?.(successCloseoutReadback())
    const result = await wirePromise
    assert.equal(result.success, true, name)
    assert.equal(publications, 1, name)
    assert.equal(settlements, 1, name)
  }
})
