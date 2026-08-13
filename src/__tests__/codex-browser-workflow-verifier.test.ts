import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserWorkflowVerifierBundle } from '../main/modules/repositories/agent-session-checkpoint-types'
import {
  codexBrowserVerifierFailureCode,
  codexBrowserVerifierFrozenIdentityDigest,
  createCodexFrozenVerifierConfig,
  verifyCodexBrowserWorkflowCandidate,
} from '../main/modules/agent-control/codex-runtime/codex-browser-workflow-verifier'
import { createCodexUpstreamProfileSnapshot } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  CodexCloseCandidateInFlightOwner,
  codexAllowsDirectProvisionalStream,
  requestCodexEngineTerminalUserStopBeforeCloseout,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'

const startedAt = '2026-08-11T05:00:00.000Z'

function frozenSnapshot() {
  return createCodexUpstreamProfileSnapshot({
    profileId: 'frozen-browser-profile',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-not-persisted',
      model: 'frozen-browser-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
      visionMode: 'off',
      thinkingMode: 'off',
      maxOutputTokensOverride: 1024,
      contextWindowOverride: 16_384,
    },
    maxRetries: 0,
  })
}

function workflowBundle(): BrowserWorkflowVerifierBundle {
  return {
    requestText: '查询并核对天气',
    requestDigest: '1'.repeat(64),
    browserTaskId: 'browser-task-verifier',
    seal: {
      parentRevision: 4,
      requestAnchorSnapshotDigest: '2'.repeat(64),
      browserTaskId: 'browser-task-verifier',
      childRevision: 7,
      childPayloadDigest: '3'.repeat(64),
      childEvidenceDigest: '4'.repeat(64),
    },
    evidence: {
      journal: {
        nextActionSeq: 1,
        nextObservationSeq: 1,
        activeAction: null,
        settledOutcomes: [],
        observationReceipts: [],
      },
      resources: [],
      researchState: 'not_requested',
      researchAssessment: null,
      unresolvedActions: [],
    },
  }
}

function verifierInput(finalText: string) {
  const created = frozenSnapshot()
  let captured: Record<string, unknown> | null = null
  return {
    captured: () => captured,
    input: {
      readyRunId: 'run-browser-verifier',
      readyTaskId: 'task-browser-verifier',
      transportModel: 'ready-e0-model',
      runStartedAtMs: Date.parse(startedAt),
      candidateText: '广州天气候选答案',
      workflowBundle: workflowBundle(),
      projection: {
        criteria: { items: [{ id: 'freshness', satisfied: true }] },
        modelCriteria: ['必须引用最新网页证据'],
        proofRefs: [],
        recentArtifacts: [],
        expectedOutputs: [],
      },
      requestEnvelope: { resources: [] },
      snapshot: created.snapshot,
      snapshotDigest: created.snapshotDigest,
      credential: 'rotated-secret',
      signal: new AbortController().signal,
      deps: {
        resolveProvider: (() => ({ model: 'fake-model', provider: {} })) as never,
        runAgent: async (params: unknown) => {
          captured = params as Record<string, unknown>
          return {
            finalText,
            usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
          }
        },
      },
    },
  }
}

test('Codex Browser verifier uses the frozen profile and a real single-turn empty-tool review', async () => {
  const fixture = verifierInput(JSON.stringify({
    version: 1,
    verdict: 'accept',
    gaps: [],
    summary: '通过',
  }))
  const result = await verifyCodexBrowserWorkflowCandidate(fixture.input)
  assert.equal(result.verdict.verdict, 'accept')
  assert.equal(result.verificationKind, 'model_verdict')
  assert.equal(fixture.captured()?.agentName, 'codex-browser-verifier')
  assert.deepEqual(fixture.captured()?.tools, [])
  assert.equal(fixture.captured()?.maxTurns, 1)
  assert.match(String(fixture.captured()?.input), /查询并核对天气/)
  assert.match(String(fixture.captured()?.input), /browser_workflow_request/)
})

test('Codex Browser verifier keeps the native transport model separate from the frozen upstream model', async () => {
  const fixture = verifierInput(JSON.stringify({
    version: 1,
    verdict: 'accept',
    gaps: [],
    summary: '通过',
  }))
  assert.notEqual(fixture.input.transportModel, fixture.input.snapshot.model)
  assert.equal((await verifyCodexBrowserWorkflowCandidate(fixture.input)).verdict.verdict, 'accept')

  await assert.rejects(
    () => verifyCodexBrowserWorkflowCandidate({
      ...fixture.input,
      transportModel: fixture.input.snapshot.model,
    }),
    /codex_browser_verifier_transport_model_identity_drift/,
  )
  assert.equal(
    codexBrowserVerifierFailureCode(new Error('codex_browser_verifier_abort_signal_missing')),
    'codex_browser_verifier_abort_signal_missing',
  )
  assert.equal(
    codexBrowserVerifierFailureCode(new Error('provider leaked secret material')),
    'codex_browser_verifier_provider_unavailable',
  )
})

test('Codex Browser verifier keeps repair, block, invalid, and provider throw fail-closed', async () => {
  for (const verdict of ['repair', 'block'] as const) {
    const fixture = verifierInput(JSON.stringify({
      version: 1,
      verdict,
      gaps: [{ kind: 'text', description: `${verdict}-gap` }],
      summary: verdict,
    }))
    const result = await verifyCodexBrowserWorkflowCandidate(fixture.input)
    assert.equal(result.verdict.verdict, verdict)
    assert.equal(result.verificationKind, 'model_verdict')
  }
  const invalid = verifierInput('{not-json')
  const invalidResult = await verifyCodexBrowserWorkflowCandidate(invalid.input)
  assert.equal(invalidResult.verdict.verdict, 'block')
  assert.equal(invalidResult.verificationKind, 'invalid_output')

  const unavailable = verifierInput('unused')
  unavailable.input.deps.runAgent = async () => { throw new Error('provider unavailable') }
  await assert.rejects(
    () => verifyCodexBrowserWorkflowCandidate(unavailable.input),
    /provider unavailable/,
  )
})

test('frozen verifier config and identity reject route or projection drift', () => {
  const created = frozenSnapshot()
  const config = createCodexFrozenVerifierConfig({
    snapshot: created.snapshot,
    snapshotDigest: created.snapshotDigest,
    credential: 'rotated-secret',
  })
  assert.equal(config.model, created.snapshot.model)
  assert.equal(config.apiKey, 'rotated-secret')
  assert.throws(() => createCodexFrozenVerifierConfig({
    snapshot: created.snapshot,
    snapshotDigest: 'f'.repeat(64),
    credential: 'rotated-secret',
  }), /upstream_snapshot_drift/)

  const identity = {
    product: {
      readyRunId: 'run-browser-verifier',
      readyTaskId: 'task-browser-verifier',
      readyScopeId: 'scope-browser-verifier',
      readyAliasId: 'scope-browser-verifier',
      aliasGeneration: 1,
      threadBindingId: 'binding-browser-verifier',
      codexThreadId: 'thread-browser-verifier',
      codexTurnId: 'turn-browser-verifier',
      turnRequestId: 'request-browser-verifier',
      toolSurfaceDigest: '5'.repeat(64),
      turnContractDigest: '6'.repeat(64),
      upstreamProfileSnapshotRef: 'snapshot-ref-browser-verifier',
      upstreamProfileSnapshotDigest: created.snapshotDigest,
      codexModel: created.snapshot.model,
    },
    workflowBundle: workflowBundle(),
    projection: {
      taskId: 'task-browser-verifier',
      runId: 'run-browser-verifier',
      revision: 4,
      requestAnchor: null,
      criteria: null,
      modelCriteria: [],
      proofRefs: [],
      recentArtifacts: [],
      expectedOutputs: [],
    },
  }
  const digest = codexBrowserVerifierFrozenIdentityDigest(identity)
  assert.notEqual(
    digest,
    codexBrowserVerifierFrozenIdentityDigest({
      ...identity,
      projection: { ...identity.projection, revision: 5 },
    }),
  )
})

test('Browser turns suppress provisional deltas while non-Browser turns retain streaming', () => {
  assert.equal(codexAllowsDirectProvisionalStream({
    readyTurnToolAuthorization: { allowedToolNames: ['browser_snapshot'] },
  } as never), false)
  assert.equal(codexAllowsDirectProvisionalStream({
    readyTurnToolAuthorization: { allowedToolNames: ['ready_read_probe'] },
  } as never), true)
})

test('concurrent closeout observers share one exact verifier job', async () => {
  const owner = new CodexCloseCandidateInFlightOwner<string>()
  let providerCalls = 0
  let release: ((value: string) => void) | null = null
  const first = owner.run({
    readyRunId: 'run-single-flight',
    candidateIdentityDigest: 'candidate-1',
    close: () => {
      providerCalls += 1
      return new Promise<string>((resolve) => { release = resolve })
    },
  })
  const duplicate = owner.run({
    readyRunId: 'run-single-flight',
    candidateIdentityDigest: 'candidate-1',
    close: async () => {
      providerCalls += 1
      return 'duplicate'
    },
  })
  assert.equal(first, duplicate)
  assert.equal(providerCalls, 1)
  await assert.rejects(() => owner.run({
    readyRunId: 'run-single-flight',
    candidateIdentityDigest: 'candidate-forged',
    close: async () => 'forged',
  }), /candidate_conflict/)
  assert.ok(release)
  release!('accepted')
  assert.deepEqual(await Promise.all([first, duplicate]), ['accepted', 'accepted'])
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  const next = await owner.run({
    readyRunId: 'run-single-flight',
    candidateIdentityDigest: 'candidate-2',
    close: async () => {
      providerCalls += 1
      return 'new-run-observation'
    },
  })
  assert.equal(next, 'new-run-observation')
  assert.equal(providerCalls, 2)
})

test('engine-terminal user stop persists the exact intent and aborts only its verifier signal', () => {
  const stopped = new AbortController()
  const successor = new AbortController()
  let durableIntent: Record<string, unknown> | null = null
  requestCodexEngineTerminalUserStopBeforeCloseout({
    repository: {
      requestProductInterrupt(input) {
        durableIntent = input
        return {
          readyRunId: input.readyRunId,
          readyTaskId: 'task-stop',
          readyScopeId: 'scope-stop',
          readyAliasId: 'alias-stop',
        }
      },
    },
    host: {
      abortActiveProductRun(identity) {
        assert.deepEqual(identity, {
          readyRunId: 'run-stop',
          readyScopeId: 'scope-stop',
          readyAliasId: 'alias-stop',
        })
        stopped.abort('user_stop')
        return true
      },
    },
    product: {
      readyRunId: 'run-stop',
      readyScopeId: 'scope-stop',
      readyAliasId: 'alias-stop',
      aliasGeneration: 3,
      codexThreadId: 'thread-stop',
      codexTurnId: 'turn-stop',
    },
    requestedAt: startedAt,
  })
  assert.deepEqual(durableIntent, {
    action: 'stop',
    aliasId: 'alias-stop',
    aliasGeneration: 3,
    readyRunId: 'run-stop',
    codexThreadId: 'thread-stop',
    codexTurnId: 'turn-stop',
    requestedAt: startedAt,
  })
  assert.equal(stopped.signal.aborted, true)
  assert.equal(successor.signal.aborted, false)
})

test('engine-terminal user stop fails closed when the exact active verifier owner is absent', () => {
  let durableIntent: Record<string, unknown> | null = null
  assert.throws(() => requestCodexEngineTerminalUserStopBeforeCloseout({
    repository: {
      requestProductInterrupt(input) {
        durableIntent = input
        return {
          readyRunId: input.readyRunId,
          readyTaskId: 'task-stop-missing-owner',
          readyScopeId: 'scope-stop-missing-owner',
          readyAliasId: 'alias-stop-missing-owner',
        }
      },
    },
    host: {
      abortActiveProductRun(identity) {
        assert.deepEqual(identity, {
          readyRunId: 'run-stop-missing-owner',
          readyScopeId: 'scope-stop-missing-owner',
          readyAliasId: 'alias-stop-missing-owner',
        })
        return false
      },
    },
    product: {
      readyRunId: 'run-stop-missing-owner',
      readyScopeId: 'scope-stop-missing-owner',
      readyAliasId: 'alias-stop-missing-owner',
      aliasGeneration: 4,
      codexThreadId: 'thread-stop-missing-owner',
      codexTurnId: 'turn-stop-missing-owner',
    },
    requestedAt: startedAt,
  }), (error: unknown) => (
    error instanceof Error && error.message === 'persistence_failed'
  ))
  assert.deepEqual(durableIntent, {
    action: 'stop',
    aliasId: 'alias-stop-missing-owner',
    aliasGeneration: 4,
    readyRunId: 'run-stop-missing-owner',
    codexThreadId: 'thread-stop-missing-owner',
    codexTurnId: 'turn-stop-missing-owner',
    requestedAt: startedAt,
  })
})
