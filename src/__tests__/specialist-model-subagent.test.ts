import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentExecutionProfile, TaskExecutionBinding } from '../shared/agent-execution-profile'
import type { WorkPackage } from '../shared/dynamic-delivery'
import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { SpecialistModelSubAgent } from '../main/modules/agent-control/runtime-core/dynamic-delivery/specialist-model-subagent'
import { runSubAgent } from '../main/modules/agent-control/sub-agent/sub-agent-runner'
import type { SubAgentCloseEvent, SubAgentEvent } from '../main/modules/agent-control/sub-agent/sub-agent-types'

const userRequest = '请逐字保留：比较 A 与 B，别改写。'

function workPackage(): WorkPackage {
  return {
    packageId: 'pkg-research',
    title: '比较证据',
    objective: '比较两份资料',
    deliverable: '一份证据差异清单',
    expectedOutputs: ['差异清单'],
    proposedCriteria: ['覆盖两份资料'],
    contextRefIds: ['resource:a'],
    executorHint: { kind: 'registered_agent', agentId: 'analyst' },
    criticality: 'required',
  }
}

function binding(kind: 'registered_agent' | 'ephemeral' = 'registered_agent'): TaskExecutionBinding {
  return {
    schemaVersion: 1,
    runId: 'run-child',
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'workflow_participant',
    kind,
    requestedAgentId: kind === 'registered_agent' ? 'analyst' : null,
    effectiveAgentId: kind === 'registered_agent' ? 'analyst' : null,
    ephemeralRole: kind === 'ephemeral' ? 'critic' : null,
    executionMaterialHash: 'material-hash',
    ownerAssignmentSource: 'parent_task',
    executionSelectionSource: kind === 'registered_agent' ? 'workflow_participant' : 'ephemeral_role',
    resolutionKind: 'direct',
  }
}

function frozenProfile(): AgentExecutionProfile {
  return Object.freeze({
    requestedAgentId: 'analyst',
    effectiveAgentId: 'analyst',
    personaRef: 'agent:analyst',
    name: 'Analyst',
    charter: '只负责证据比较',
    personality: '谨慎',
    rules: '区分事实与判断',
    knowledgeIndex: 'resource:allowed — 已允许的知识摘要',
    allowedKnowledgeRefs: Object.freeze(['resource:allowed']) as unknown as string[],
    knowledgeWriteOwnerAgentId: 'analyst',
    knowledgeWriteNamespace: 'agents/analyst/knowledge',
    executionMaterialHash: 'material-hash',
    readinessRevision: 'ready-v1',
    redirectChain: [],
    readiness: { conversationReady: true, handoffReady: true, autoRoutable: true, collaborationReady: true, reasons: [] },
  })
}

function validReport(): string {
  return JSON.stringify({
    version: 1,
    packageId: 'pkg-research',
    attempt: 0,
    summaryLines: ['已比较两份资料。'],
    deliverable: { inline: '差异清单' },
    criterionObservations: [{ criterionId: 'c1', observation: '两份资料均已覆盖。' }],
    evidenceHandles: [],
    unverifiedClaims: [],
    openQuestions: [],
    confidence: 'high',
  })
}

async function collect(generator: AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void>) {
  const events: SubAgentEvent[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { events, close: next.value }
    events.push(next.value)
  }
}

function context() {
  return {
    abortSignal: new AbortController().signal,
    cleanup: { register() {}, async drain() {} },
    userRequestVerbatim: userRequest,
  }
}

test('SpecialistModelSubAgent runs through runSubAgent with a fresh one-turn no-tools session', async () => {
  let captured: ReadyAgentSdkRunParams | null = null
  const result: ReadyAgentSdkRunResult = {
    finalText: validReport(),
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  }
  const subagent = new SpecialistModelSubAgent('life-a', 'Analyst worker', {
    userRequestVerbatim: userRequest,
    workPackage: workPackage(),
    binding: binding(),
    profile: frozenProfile(),
    ephemeralRole: null,
    resourceBundle: {
      version: 1,
      resources: [{ refId: 'resource:a', digest: 'digest-a', provenance: 'host:fixture', excerpt: '允许的资料摘录' }],
      ownerArtifactSummaries: [],
      skillMethodSummary: null,
    },
  }, {
    runAgent: async (params) => { captured = params; return result },
    provider: {} as never,
    model: 'fixture-model',
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  })

  const { events, close } = await collect(runSubAgent(subagent, context()))
  assert.equal(events[0]?.type, 'started')
  assert.equal(events.at(-1)?.type, 'terminal')
  assert.equal(close.state, 'completed')
  assert.ok(captured)
  const call = captured as ReadyAgentSdkRunParams
  assert.deepEqual(call.tools, [])
  assert.equal(call.maxTurns, 1)
  assert.deepEqual(await call.session.getItems(), [])
  assert.equal(call.sessionId, 'life-a')
  assert.match(String(call.input), new RegExp(userRequest))

  const execution = close.metadata?.workerExecution as { usage?: unknown; durationMs?: unknown; report?: { packageId?: string } }
  assert.deepEqual(execution.usage, result.usage)
  assert.equal(execution.report?.packageId, 'pkg-research')
  assert.equal(typeof execution.durationMs, 'number')
  assert.ok(Number(execution.durationMs) >= 0)
})

test('invalid WorkerReport JSON fails the subagent lifecycle instead of fabricating completion', async () => {
  const subagent = new SpecialistModelSubAgent('life-b', 'Broken worker', {
    userRequestVerbatim: userRequest,
    workPackage: workPackage(),
    binding: binding(),
    profile: frozenProfile(),
    ephemeralRole: null,
    resourceBundle: { version: 1, resources: [], ownerArtifactSummaries: [], skillMethodSummary: null },
  }, {
    runAgent: async () => ({ finalText: '{not json', usage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } }),
    provider: {} as never,
    model: 'fixture-model',
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  })

  const { close } = await collect(runSubAgent(subagent, context()))
  assert.equal(close.state, 'failed')
  assert.equal(close.terminalReason, 'failed_subagent')
  assert.match(close.error?.message ?? '', /invalid JSON/)
  assert.equal(close.metadata?.workerExecution, undefined)
})
