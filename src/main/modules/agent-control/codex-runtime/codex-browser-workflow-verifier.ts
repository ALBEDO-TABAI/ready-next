import type { ModelProvider } from '@openai/agents'

import {
  resolveMaxOutputTokens,
  type AIModelConfig,
  type AIProviderType,
} from '../../../../shared/ai-providers'
import { resolveModelContextWindow } from '../../../../shared/context-budget-types'
import {
  CHATGPT_OAUTH_BASE_URL,
  CHATGPT_OAUTH_PROFILE_ID,
} from '../../../../shared/chatgpt-oauth'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type { BrowserWorkflowVerifierBundle } from '../../repositories/agent-session-checkpoint-types'
import type { CodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'
import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
} from './codex-model-gateway-contract'
export { codexBrowserVerifierFrozenIdentityDigest } from './codex-browser-verifier-identity'
import { resolveAgentSdkProvider } from '../runtime-core/agent-sdk-provider'
import { runWithOpenAIAgentsSdk } from '../runtime-core/agent-sdk-provider-runner'
import { defaultFetchWithTimeout } from '../runtime-core/agent-sdk-execution-utils'
import type {
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
} from '../runtime-core/agent-sdk-types'
import { materializeBrowserWorkflowDeliveryVerifierResources } from '../runtime-core/dynamic-delivery/browser-workflow-delivery-verifier'
import {
  verifyStandaloneDeliveryCandidate,
  type StandaloneDeliveryVerificationInput,
} from '../runtime-core/dynamic-delivery/standalone-delivery-verifier'

export type CodexBrowserVerificationProjection = Pick<
  TaskProjectionRecord,
  'criteria' | 'modelCriteria' | 'proofRefs' | 'recentArtifacts' | 'expectedOutputs'
>

export function codexBrowserVerifierFailureCode(error: unknown): string {
  const value = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
  return /^codex_[a-z0-9_:-]{1,90}$/i.test(value)
    ? value
    : 'codex_browser_verifier_provider_unavailable'
}

function isChatGptOAuthSnapshot(snapshot: CodexUpstreamProfileSnapshot): boolean {
  return snapshot.profileId === CHATGPT_OAUTH_PROFILE_ID
    && snapshot.baseUrl === CHATGPT_OAUTH_BASE_URL
    && snapshot.wireApi === 'responses'
}

export function createCodexFrozenVerifierConfig(input: {
  snapshot: CodexUpstreamProfileSnapshot
  snapshotDigest: string
  credential: string
}): AIModelConfig {
  const config: AIModelConfig = {
    provider: input.snapshot.providerId as AIProviderType,
    baseUrl: input.snapshot.baseUrl,
    apiKey: input.credential,
    model: input.snapshot.model,
    authMode: isChatGptOAuthSnapshot(input.snapshot) ? 'chatgpt-oauth' : 'api-key',
    agentProtocol: input.snapshot.agentProtocol,
    wireApi: input.snapshot.wireApi === 'messages' ? undefined : input.snapshot.wireApi,
    ...(input.snapshot.reasoningEffort
      ? { reasoningEffort: input.snapshot.reasoningEffort }
      : {}),
    toolUseMode: input.snapshot.supportsToolCalls ? 'on' : 'off',
    visionMode: input.snapshot.supportsVision ? 'on' : 'off',
    thinkingMode: input.snapshot.supportsThinking ? 'on' : 'off',
    nativeVideoMode: 'off',
    ...(input.snapshot.contextWindowTokens === undefined
      ? {}
      : { contextWindowOverride: input.snapshot.contextWindowTokens }),
    ...(input.snapshot.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokensOverride: input.snapshot.maxOutputTokens }),
  }
  const rebuilt = createCodexUpstreamProfileSnapshot({
    profileId: input.snapshot.profileId,
    config,
    maxRetries: input.snapshot.retryPolicy.maxRetries,
  })
  if (
    rebuilt.snapshotDigest !== input.snapshotDigest
    || digestCanonicalJson(input.snapshot) !== input.snapshotDigest
  ) throw new Error('codex_browser_verifier_upstream_snapshot_drift')
  return config
}

export async function verifyCodexBrowserWorkflowCandidate(input: {
  readyRunId: string
  readyTaskId: string
  transportModel: string
  runStartedAtMs: number
  candidateText: string
  workflowBundle: BrowserWorkflowVerifierBundle
  projection: CodexBrowserVerificationProjection
  requestEnvelope: unknown
  snapshot: CodexUpstreamProfileSnapshot
  snapshotDigest: string
  credential: string
  signal: AbortSignal
  deps?: {
    resolveProvider?: typeof resolveAgentSdkProvider
    runAgent?: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  }
}): Promise<Awaited<ReturnType<typeof verifyStandaloneDeliveryCandidate>>> {
  if (input.transportModel !== 'ready-e0-model') {
    throw new Error('codex_browser_verifier_transport_model_identity_drift')
  }
  const config = createCodexFrozenVerifierConfig({
    snapshot: input.snapshot,
    snapshotDigest: input.snapshotDigest,
    credential: input.credential,
  })
  const providerResolution = (input.deps?.resolveProvider || resolveAgentSdkProvider)(config, {
    fetchWithTimeout: defaultFetchWithTimeout,
  })
  const verificationInput: StandaloneDeliveryVerificationInput = {
    runId: input.readyRunId,
    taskId: input.readyTaskId,
    userRequestVerbatim: input.workflowBundle.requestText,
    candidateText: input.candidateText,
    hostCriteria: input.projection.criteria ? [input.projection.criteria] : [],
    modelCriteria: input.projection.modelCriteria ?? [],
    model: providerResolution.model,
    provider: providerResolution.provider as ModelProvider,
    contextWindowTokens: resolveModelContextWindow(config),
    maxOutputTokens: resolveMaxOutputTokens(config),
    signal: input.signal,
    verifierAgentName: 'codex-browser-verifier',
    materializeAndReadBack: async () => (
      materializeBrowserWorkflowDeliveryVerifierResources({
        bundle: input.workflowBundle,
        projection: input.projection,
        requestEnvelope: input.requestEnvelope,
        currentRunId: input.readyRunId,
        runStartedAtMs: input.runStartedAtMs,
      })
    ),
    runAgent: input.deps?.runAgent || runWithOpenAIAgentsSdk,
  }
  return verifyStandaloneDeliveryCandidate(verificationInput)
}
