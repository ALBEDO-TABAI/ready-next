import assert from 'node:assert/strict'
import test from 'node:test'

import { MemorySession, type AgentInputItem } from '@openai/agents'

import type { TaskExecutionBinding } from '../shared/agent-execution-profile'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import {
  DynamicDeliveryCoordinator,
  type DynamicDeliveryCoordinatorAdapter,
} from '../main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-coordinator'

const now = '2026-07-11T00:00:00.000Z'
const usage = (n: number) => ({ inputTokens: n, outputTokens: n, totalTokens: n * 2 })
const user = (text: string): AgentInputItem => ({ role: 'user', content: text }) as AgentInputItem

function binding(runId = 'run'): TaskExecutionBinding {
  return {
    schemaVersion: 1, runId, ownerAgentIdAtStart: 'owner', runOrigin: 'workflow_participant',
    kind: 'registered_agent', requestedAgentId: 'owner', effectiveAgentId: 'owner',
    executionMaterialHash: 'owner-hash', ownerAssignmentSource: 'parent_task',
    executionSelectionSource: 'task_owner', resolutionKind: 'direct',
  }
}

function projection(): TaskProjectionRecord {
  return {
    taskId: 'task', scopeId: 'scope', runId: 'run', parentTaskId: null, parentStepId: null,
    taskType: 'research', module: 'agent', taskTitle: 'Task', taskSummary: 'request',
    status: 'running', interactionState: 'running', steps: [], criteria: { id: 'c1', text: 'done' },
    modelCriteria: ['complete'], ownerAgentId: 'owner', taskOrigin: 'user_root',
    executionBinding: binding(), createdAt: now, updatedAt: now,
  } as TaskProjectionRecord
}

function envelope(ids: string[]) {
  return {
    resources: ids.map((id) => ({ id, kind: 'local_document_resource', source: 'user', canRead: true, summary: id })),
    referencedResources: ids.map((value) => ({ value })),
  }
}

function plan(criticality: 'required' | 'optional' = 'required') {
  return JSON.stringify({ version: 1, packages: [{
    packageId: 'pkg', title: 'Research', objective: 'Check facts', deliverable: 'Report',
    expectedOutputs: ['report'], proposedCriteria: ['accurate'], contextRefIds: ['a', 'b'],
    executorHint: { kind: 'registered_agent', agentId: 'analyst' }, criticality,
  }] })
}

function report() {
  return JSON.stringify({
    version: 1, packageId: 'pkg', attempt: 0, summaryLines: ['checked'],
    deliverable: { inline: 'facts' }, criterionObservations: [], evidenceHandles: [],
    unverifiedClaims: [], openQuestions: [], confidence: 'high',
  })
}

function verdict(value: 'accept' | 'repair' | 'block') {
  return JSON.stringify({
    version: 1,
    verdict: value,
    gaps: value === 'accept' ? [] : [{ kind: 'text', description: 'not accepted' }],
    summary: value,
  })
}

function harness(runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>) {
  let current = projection()
  const updates: Array<{ taskId: string; patch: Partial<TaskProjectionRecord> }> = []
  const trees: unknown[] = []
  const adapter: DynamicDeliveryCoordinatorAdapter = {
    getProjection: () => current,
    updateProjection: (taskId, patch) => {
      updates.push({ taskId, patch })
      if (taskId === current.taskId) current = { ...current, ...patch }
    },
    taskStore: () => ({
      createPacketTree: (input: unknown) => {
        trees.push(input)
        current = { ...current, deliveryState: (input as { deliveryState: NonNullable<TaskProjectionRecord['deliveryState']> }).deliveryState }
        return []
      },
      reduceState: (input: { reduce: (state: NonNullable<TaskProjectionRecord['deliveryState']>) => NonNullable<TaskProjectionRecord['deliveryState']> }) => {
        if (!current.deliveryState) throw new Error('delivery state missing')
        const next = input.reduce(current.deliveryState)
        current = { ...current, deliveryState: next }
        return next
      },
    }) as never,
    listProfiles: () => [{ agentId: 'analyst', name: 'Analyst', collaborationReady: true }],
    resolveProfile: async () => ({ id: 'analyst', name: 'Analyst' }) as never,
    createRegisteredBinding: ({ runId }) => ({ ...binding(runId), requestedAgentId: 'analyst', effectiveAgentId: 'analyst' }),
  }
  return { coordinator: new DynamicDeliveryCoordinator(adapter, runAgent), updates, trees, projection: () => current }
}

async function prepare(
  coordinator: DynamicDeliveryCoordinator,
  committedSession: MemorySession,
  overrides: Partial<Parameters<DynamicDeliveryCoordinator['prepareOwnerInput']>[0]> = {},
) {
  return coordinator.prepareOwnerInput({
    mode: 'adaptive', runId: 'run', taskId: 'task', scopeId: 'scope', userRequestVerbatim: 'request',
    requestEnvelope: envelope(['a']), intentClassification: { primaryDomain: 'research', confidence: 1 },
    inferredTaskType: 'research', liveBudget: null, ownerBinding: binding(), ownerProfile: null,
    committedSession, model: 'test', provider: {} as never, contextWindowTokens: 10_000,
    maxOutputTokens: 1_000, signal: new AbortController().signal, ...overrides,
  })
}

test('standard and unknown inputs fail to single path with zero extra model calls', async () => {
  let calls = 0
  const h = harness(async () => { calls += 1; throw new Error('unexpected') })
  const session = new MemorySession({ initialItems: [user('base')] })
  assert.equal((await prepare(h.coordinator, session, { mode: 'standard' })).decision, 'single_path')
  assert.equal((await prepare(h.coordinator, session, { intentClassification: { confidence: 0.1 } })).decision, 'single_path')
  assert.equal(calls, 0)
})

test('verify-only forks session and buffers output without polluting committed history', async () => {
  const h = harness(async () => ({ finalText: verdict('accept'), usage: usage(1) }))
  const committed = new MemorySession({ initialItems: [user('base')] })
  const prepared = await prepare(h.coordinator, committed)
  assert.equal(prepared.decision, 'verify_only')
  assert.notEqual(prepared.ownerSession, committed)
  assert.ok(prepared.emitOutput)
  prepared.emitOutput!.append('candidate')
  await prepared.ownerSession.addItems([user('candidate-only')])
  assert.equal((await committed.getItems()).length, 1)
  assert.equal(prepared.emitOutput!.snapshot(), 'candidate')
})

test('support planner and worker are no-tools, write the packet tree, and usage is accumulated once per call', async () => {
  const calls: ReadyAgentSdkRunParams[] = []
  const h = harness(async (params) => {
    calls.push(params)
    return params.agentName === 'dynamic-delivery-planner'
      ? { finalText: plan(), usage: usage(2) }
      : { finalText: report(), usage: usage(3) }
  })
  const prepared = await prepare(h.coordinator, new MemorySession(), { requestEnvelope: envelope(['a', 'b']) })
  assert.equal(prepared.decision, 'support_and_verify')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.tools.length === 0 && call.maxTurns === 1))
  assert.equal(h.trees.length, 1)
  assert.equal(h.projection().deliveryState?.packages[0]?.status, 'completed')
  assert.equal(h.projection().deliveryState?.packages[0]?.evidenceHandleIds.length, 1, 'host issues the child evidence handle')
  const childUpdate = h.updates.find((entry) => entry.taskId === h.projection().deliveryState?.packages[0]?.childTaskId)
  assert.equal(childUpdate?.patch.status, 'completed')
  assert.equal(childUpdate?.patch.interactionState, 'suspended')
  assert.deepEqual(prepared.usage, {
    inputTokens: 5, outputTokens: 5, totalTokens: 10,
    usageSource: 'provider', providerCallCount: 2, missingCallCount: 0,
  })
})

test('bad planner JSON degrades to verify-only', async () => {
  const h = harness(async () => ({ finalText: '{bad', usage: usage(2) }))
  const prepared = await prepare(h.coordinator, new MemorySession(), { requestEnvelope: envelope(['a', 'b']) })
  assert.equal(prepared.decision, 'verify_only')
  assert.equal(h.trees.length, 0)
  assert.equal(prepared.usage?.providerCallCount, 1)
})

test('required worker failure blocks its package without failing open', async () => {
  const h = harness(async (params) => params.agentName === 'dynamic-delivery-planner'
    ? { finalText: plan('required'), usage: usage(1) }
    : Promise.reject(new Error('worker failed')))
  const prepared = await prepare(h.coordinator, new MemorySession(), { requestEnvelope: envelope(['a', 'b']) })
  assert.equal(prepared.decision, 'support_and_verify')
  assert.equal(h.projection().deliveryState?.packages[0]?.status, 'blocked')
  const childUpdate = h.updates.find((entry) => entry.taskId === h.projection().deliveryState?.packages[0]?.childTaskId)
  assert.equal(childUpdate?.patch.status, 'failed')
  assert.equal(childUpdate?.patch.interactionState, 'suspended')
  assert.equal(prepared.usage?.providerCallCount, 1)
})

test('verifier acceptance cannot publish while a required package is blocked', async () => {
  const committed = new MemorySession({ initialItems: [user('base')] })
  const h = harness(async (params) => {
    if (params.agentName === 'dynamic-delivery-planner') return { finalText: plan('required'), usage: usage(1) }
    if (params.agentName === 'dynamic-delivery-verifier') return { finalText: verdict('accept'), usage: usage(1) }
    throw new Error('worker failed')
  })
  const prepared = await prepare(h.coordinator, committed, { requestEnvelope: envelope(['a', 'b']) })
  prepared.emitOutput!.append('must stay hidden')
  const result = await h.coordinator.verifyOwnerCandidate({
    runId: 'run', candidateText: 'must stay hidden', projectionAfterOwner: h.projection(), model: 'test',
    provider: {} as never, contextWindowTokens: 10_000, maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    materializeAndReadBack: async () => ({ version: 1, items: [] }),
  })
  assert.equal(result.verdict.verdict, 'block')
  assert.equal(result.acceptedText, null)
  assert.equal((await committed.getItems()).length, 1)
  assert.equal(prepared.emitOutput!.snapshot(), '')
  assert.equal(h.projection().deliveryState?.verifier.status, 'blocked')
})

for (const verifierVerdict of ['repair', 'block'] as const) {
  test(`${verifierVerdict} aborts candidate and leaks neither session delta nor buffered output`, async () => {
    const committed = new MemorySession({ initialItems: [user('base')] })
    const h = harness(async () => ({ finalText: verdict(verifierVerdict), usage: usage(4) }))
    const prepared = await prepare(h.coordinator, committed)
    await prepared.ownerSession.addItems([user('candidate-only')])
    prepared.emitOutput!.append('secret draft')
    const result = await h.coordinator.verifyOwnerCandidate({
      runId: 'run', candidateText: 'draft', projectionAfterOwner: h.projection(), model: 'test',
      provider: {} as never, contextWindowTokens: 10_000, maxOutputTokens: 1_000,
      signal: new AbortController().signal,
      materializeAndReadBack: async () => ({ version: 1, items: [] }),
    })
    assert.equal(result.acceptedText, null)
    assert.equal((await committed.getItems()).length, 1)
    assert.equal(prepared.emitOutput!.snapshot(), '')
    assert.equal(h.projection().deliveryState?.verifier.status, 'blocked')
  })
}

test('accept alone commits candidate history, releases buffered output, and close removes context', async () => {
  const committed = new MemorySession({ initialItems: [user('base')] })
  const h = harness(async () => ({ finalText: verdict('accept'), usage: usage(4) }))
  const prepared = await prepare(h.coordinator, committed)
  await prepared.ownerSession.addItems([user('accepted')])
  prepared.emitOutput!.append('visible')
  h.coordinator.recordOwnerUsage('run', usage(2))
  const result = await h.coordinator.verifyOwnerCandidate({
    runId: 'run', candidateText: 'visible', projectionAfterOwner: h.projection(), model: 'test',
    provider: {} as never, contextWindowTokens: 10_000, maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    materializeAndReadBack: async () => ({ version: 1, items: [] }),
  })
  assert.equal(result.acceptedText, 'visible')
  const acceptedHistory = await committed.getItems()
  assert.equal(acceptedHistory.length, 3)
  assert.equal(JSON.stringify(acceptedHistory).includes('accepted'), true)
  assert.equal(result.usage?.providerCallCount, 2)
  assert.equal(h.projection().deliveryState?.verifier.status, 'accepted')
  h.coordinator.close('run')
  assert.equal(h.coordinator.contexts.get('run'), null)
})

test('one text repair replaces the hidden draft and commits only the accepted answer', async () => {
  const committed = new MemorySession({ initialItems: [user('base')] })
  let verifierCalls = 0
  const h = harness(async (params) => {
    if (params.agentName === 'dynamic-delivery-owner-repair') {
      return { finalText: 'repaired answer', usage: usage(2) }
    }
    verifierCalls += 1
    return { finalText: verdict(verifierCalls === 1 ? 'repair' : 'accept'), usage: usage(1) }
  })
  const prepared = await prepare(h.coordinator, committed)
  prepared.emitOutput!.append('rejected draft')
  const result = await h.coordinator.verifyOwnerCandidate({
    runId: 'run', candidateText: 'rejected draft', projectionAfterOwner: h.projection(), model: 'test',
    provider: {} as never, contextWindowTokens: 10_000, maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    materializeAndReadBack: async () => ({ version: 1, items: [] }),
  })
  const committedItems = JSON.stringify(await committed.getItems())
  assert.equal(result.acceptedText, 'repaired answer')
  assert.equal(prepared.emitOutput!.snapshot(), 'repaired answer')
  assert.equal(committedItems.includes('repaired answer'), true)
  assert.equal(committedItems.includes('rejected draft'), false)
  assert.equal(h.projection().deliveryState?.verifier.repaired, true)
  assert.equal(result.usage?.providerCallCount, 3)
})

test('artifact repair reuses only the supplied Owner repair-safe tools on the verified target', async () => {
  const committed = new MemorySession({ initialItems: [user('base')] })
  let verifierCalls = 0
  const h = harness(async (params) => {
    if (params.agentName === 'dynamic-delivery-owner-artifact-repair') {
      assert.equal(params.tools.length, 1)
      assert.match(String(params.input), /doc-1/)
      return { finalText: 'artifact repaired', usage: usage(2) }
    }
    verifierCalls += 1
    return verifierCalls === 1
      ? { finalText: JSON.stringify({ version: 1, verdict: 'repair', gaps: [{ kind: 'artifact', description: 'fix document', targetRefId: 'doc-1' }], summary: 'repair' }), usage: usage(1) }
      : { finalText: verdict('accept'), usage: usage(1) }
  })
  h.projection().contextRefs = ['doc-1']
  const prepared = await prepare(h.coordinator, committed)
  prepared.emitOutput!.append('draft')
  const result = await h.coordinator.verifyOwnerCandidate({
    runId: 'run', candidateText: 'draft', projectionAfterOwner: h.projection(), model: 'test',
    provider: {} as never, contextWindowTokens: 10_000, maxOutputTokens: 1_000,
    signal: new AbortController().signal,
    artifactRepairTools: [{} as never],
    materializeAndReadBack: async () => ({ version: 1, items: [{ refId: 'doc-1', digest: 'after', provenance: 'readback', excerpt: 'fixed', kind: 'artifact' }] }),
  })
  assert.equal(result.acceptedText, 'artifact repaired')
  assert.equal(h.projection().deliveryState?.verifier.repaired, true)
})
