import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentExecutionProfile, TaskExecutionBinding } from '../shared/agent-execution-profile'
import type { WorkPackage } from '../shared/dynamic-delivery'
import type { ReadyAgentSdkRunParams } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { SpecialistModelSubAgent } from '../main/modules/agent-control/runtime-core/dynamic-delivery/specialist-model-subagent'
import { runSubAgent } from '../main/modules/agent-control/sub-agent/sub-agent-runner'
import type { SubAgentCloseEvent, SubAgentEvent } from '../main/modules/agent-control/sub-agent/sub-agent-types'

const verbatim = '原话\n保持 标点 与  空格。'
const parentSecret = 'PARENT_HISTORY_MUST_NOT_LEAK'
const siblingSecret = 'SIBLING_HISTORY_MUST_NOT_LEAK'
const forbiddenKnowledge = 'FORBIDDEN_KNOWLEDGE_MUST_NOT_LEAK'

const pkg: WorkPackage = {
  packageId: 'pkg-isolated', title: '独立检查', objective: '检查允许资料', deliverable: '检查意见',
  expectedOutputs: ['意见'], proposedCriteria: [], contextRefIds: ['resource:allowed'],
  executorHint: { kind: 'registered_agent', agentId: 'analyst' }, criticality: 'required',
}

function makeBinding(kind: 'registered_agent' | 'ephemeral'): TaskExecutionBinding {
  return {
    schemaVersion: 1, runId: `run-${kind}`, ownerAgentIdAtStart: 'butler', runOrigin: 'workflow_participant', kind,
    requestedAgentId: kind === 'registered_agent' ? 'analyst' : null,
    effectiveAgentId: kind === 'registered_agent' ? 'analyst' : null,
    ephemeralRole: kind === 'ephemeral' ? 'critic' : null,
    executionMaterialHash: 'frozen-hash', ownerAssignmentSource: 'parent_task',
    executionSelectionSource: kind === 'registered_agent' ? 'workflow_participant' : 'ephemeral_role', resolutionKind: 'direct',
  }
}

const profile = Object.freeze({
  requestedAgentId: 'analyst', effectiveAgentId: 'analyst', personaRef: 'agent:analyst', name: 'Analyst',
  charter: '只检查证据', personality: '谨慎', rules: '只使用允许资料',
  knowledgeIndex: 'resource:allowed — 可用摘要', allowedKnowledgeRefs: Object.freeze(['resource:allowed']) as unknown as string[],
  knowledgeWriteOwnerAgentId: 'analyst', knowledgeWriteNamespace: 'agents/analyst/knowledge',
  executionMaterialHash: 'frozen-hash', readinessRevision: 'ready-v1', redirectChain: [],
  readiness: { conversationReady: true, handoffReady: true, autoRoutable: true, collaborationReady: true, reasons: [] },
}) satisfies AgentExecutionProfile

const report = JSON.stringify({
  version: 1, packageId: 'pkg-isolated', attempt: 0, summaryLines: ['完成检查'], deliverable: { inline: '检查意见' },
  criterionObservations: [], evidenceHandles: [], unverifiedClaims: [], openQuestions: [], confidence: 'medium',
})

async function capturePrompt(input: ConstructorParameters<typeof SpecialistModelSubAgent>[2], metadata?: Record<string, unknown>) {
  let captured: ReadyAgentSdkRunParams | null = null
  const subagent = new SpecialistModelSubAgent('life-isolated', 'Isolated worker', input, {
    runAgent: async (params) => { captured = params; return { finalText: report, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } },
    provider: {} as never, model: 'fixture-model', contextWindowTokens: 32000, maxOutputTokens: 2000,
  })
  const generator = runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: { register() {}, async drain() {} },
    userRequestVerbatim: verbatim,
    metadata,
  })
  while (!(await generator.next()).done) { /* consume lifecycle */ }
  assert.ok(captured)
  return String((captured as ReadyAgentSdkRunParams).input)
}

test('registered worker receives frozen profile and only the host-allowlisted knowledge summary', async () => {
  assert.equal(Object.isFrozen(profile), true)
  const prompt = await capturePrompt({
    userRequestVerbatim: verbatim,
    workPackage: pkg,
    binding: makeBinding('registered_agent'),
    profile,
    ephemeralRole: null,
    resourceBundle: {
      version: 1,
      resources: [{ refId: 'resource:allowed', digest: 'digest', provenance: 'host:allowlist', excerpt: '允许摘录' }],
      ownerArtifactSummaries: [],
      skillMethodSummary: null,
    },
  }, { parentHistory: parentSecret, siblingHistory: siblingSecret, forbiddenKnowledge })

  const parsed = JSON.parse(prompt)
  assert.equal(parsed.userRequestVerbatim, verbatim)
  assert.equal(parsed.execution.executionMaterialHash, 'frozen-hash')
  assert.deepEqual(parsed.execution.allowedKnowledgeRefs, ['resource:allowed'])
  assert.match(prompt, /可用摘要/)
  assert.doesNotMatch(prompt, new RegExp(parentSecret))
  assert.doesNotMatch(prompt, new RegExp(siblingSecret))
  assert.doesNotMatch(prompt, new RegExp(forbiddenKnowledge))
})

test('ephemeral worker has a closed role and receives no registered long-term profile', async () => {
  const prompt = await capturePrompt({
    userRequestVerbatim: verbatim,
    workPackage: { ...pkg, executorHint: { kind: 'ephemeral', role: 'critic' } },
    binding: makeBinding('ephemeral'),
    profile: null,
    ephemeralRole: 'critic',
    resourceBundle: { version: 1, resources: [], ownerArtifactSummaries: [], skillMethodSummary: null },
  }, { forbiddenKnowledge })

  const parsed = JSON.parse(prompt)
  assert.deepEqual(parsed.execution, { kind: 'ephemeral', role: 'critic' })
  assert.equal(parsed.execution.knowledgeIndex, undefined)
  assert.doesNotMatch(prompt, new RegExp(forbiddenKnowledge))
})

test('model-authored usage cannot enter WorkerReport; host result remains the only usage source', async () => {
  const poisonedReport = JSON.stringify({ ...JSON.parse(report), usage: { totalTokens: 999999 } })
  const subagent = new SpecialistModelSubAgent('life-poisoned', 'Poisoned worker', {
    userRequestVerbatim: verbatim, workPackage: pkg, binding: makeBinding('ephemeral'), profile: null, ephemeralRole: 'critic',
    resourceBundle: { version: 1, resources: [], ownerArtifactSummaries: [], skillMethodSummary: null },
  }, {
    runAgent: async () => ({ finalText: poisonedReport, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }),
    provider: {} as never, model: 'fixture-model', contextWindowTokens: 32000, maxOutputTokens: 2000,
  })
  const generator = runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: { register() {}, async drain() {} },
    userRequestVerbatim: verbatim,
  })
  let close: SubAgentCloseEvent | null = null
  const events: SubAgentEvent[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) { close = next.value; break }
    events.push(next.value)
  }
  assert.equal(events.at(-1)?.type, 'terminal')
  assert.equal(close?.state, 'failed')
  assert.match(close?.error?.message ?? '', /forbidden field.*usage/)
  assert.equal(close?.metadata?.workerExecution, undefined)
})
