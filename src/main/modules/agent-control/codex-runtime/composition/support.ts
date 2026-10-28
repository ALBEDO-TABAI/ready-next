import type { AIModelConfig } from '../../../../../shared/ai-providers'
import type { ReadyMemoryStateChange } from '../../../../../shared/ready-memory'
import type { DatabaseManager } from '../../../database'
import type { BrowserWorkflowVerifierBundle } from '../../../repositories/agent-session-checkpoint-types'
import type { AppSettingsRepository } from '../../../repositories/app-settings-repository'
import type { TaskProjectionRecord } from '../../contracts/run-contracts'
import type { CodexBrowserVerifierVerdict, CodexProductTurnRuntimeRead, CodexBrowserVerifierAttemptOutcome } from '../codex-binding-repository'
import { codexBrowserVerifierFrozenIdentityDigest, verifyCodexBrowserWorkflowCandidate } from '../codex-browser-workflow-verifier'
import type { CodexRendererToolActionRequester } from '../codex-product-surface-ingress'
import { resolveCodexProductTaskFacts } from '../codex-product-task-facts'
import { createCodexProfileRouteSnapshot } from '../codex-profile-admission'
import type { CodexProviderReadinessPort } from '../codex-provider-readiness'
import type { CodexRuntimeHostPort } from '../codex-runtime-composition'
import type { SameThreadContinuationCandidate, SameThreadContinuation } from '../codex-same-thread-continuation'

export function isoNow(): string {
  return new Date().toISOString()
}

export function codexFailureDiagnostics(input: {
  error: string
  module: string
  verifierReceiptDigest?: string
}): Record<string, unknown> {
  return {
    provider: 'ready_gateway',
    agentProtocol: 'openai',
    wireApi: 'responses',
    codexFailure: {
      contract: 'codex_failure_evidence_v1',
      error: input.error,
      module: input.module,
      ...(input.verifierReceiptDigest
        ? { verifierReceiptDigest: input.verifierReceiptDigest }
        : {}),
    },
  }
}

export type FactoryInput = {
  appPath: string
  resourcesPath: string
  userDataPath: string
  isPackaged: boolean
  database: DatabaseManager
  settings: AppSettingsRepository
  requestRendererToolAction: CodexRendererToolActionRequester
  providerReadiness: CodexProviderReadinessPort
  onReadyMemoryStateChanged?: (event: ReadyMemoryStateChange) => void
  onCodexActionSurfaceInvalidated?: (
    event: import('../../../../../shared/ipc-contracts/agent-runtime').CodexActionSurfaceInvalidation,
  ) => void
}

export type PreparedDetail = {
  projectDirectory: string | null
  preparedAtMs: number
  executionBinding: Awaited<ReturnType<CodexRuntimeHostPort['createInitialExecutionBinding']>>
  threadBindingId: string
  isolatedThreadCwd: string
  turnRequestId: string
  upstream: ReturnType<typeof createCodexProfileRouteSnapshot>
  developerInstructions: string
  instructionContractDigest: string
  continuationCandidate: SameThreadContinuationCandidate | null
  resolveCurrentContinuation: () => {
    candidate: SameThreadContinuationCandidate
    decision: SameThreadContinuation
  } | null
  turnContractDigest: string
  productTaskFacts: ReturnType<typeof resolveCodexProductTaskFacts>
}

export function stableErrorCode(error: unknown, fallback: string): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[a-z0-9_:-]{1,96}$/i.test(candidate) ? candidate : fallback
}

export function recoverableBrowserWorkflowCode(error: unknown): string | null {
  const code = error instanceof Error ? error.message : String(error)
  return code === 'codex_browser_workflow_observation_required'
    || code === 'codex_browser_workflow_action_in_flight'
    || code === 'codex_browser_workflow_research_incomplete'
    ? code
    : null
}

export function codexBrowserVerifierBlockingVerdict(
  description: string,
  summary: string,
): CodexBrowserVerifierVerdict {
  return {
    version: 1,
    verdict: 'block',
    gaps: [{ kind: 'text', description }],
    summary,
  }
}

export function codexBrowserVerifierIdentityDigest(input: {
  product: CodexProductTurnRuntimeRead
  workflowBundle: BrowserWorkflowVerifierBundle
  projection: TaskProjectionRecord
}): string {
  const { product, projection } = input
  return codexBrowserVerifierFrozenIdentityDigest({
    product: {
      readyRunId: product.readyRunId,
      readyTaskId: product.readyTaskId,
      readyScopeId: product.readyScopeId,
      readyAliasId: product.readyAliasId,
      aliasGeneration: product.aliasGeneration,
      threadBindingId: product.threadBindingId,
      codexThreadId: product.codexThreadId,
      codexTurnId: product.codexTurnId,
      turnRequestId: product.turnRequestId,
      toolSurfaceDigest: product.toolSurfaceDigest,
      turnContractDigest: product.turnContractDigest,
      upstreamProfileSnapshotRef: product.upstreamProfileSnapshotRef,
      upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
      codexModel: product.codexModel,
    },
    workflowBundle: input.workflowBundle,
    projection: {
      taskId: projection.taskId,
      runId: projection.runId,
      revision: projection.revision,
      requestAnchor: projection.requestAnchor,
      criteria: projection.criteria,
      modelCriteria: projection.modelCriteria,
      proofRefs: projection.proofRefs,
      recentArtifacts: projection.recentArtifacts,
      expectedOutputs: projection.expectedOutputs,
    },
  })
}

export function codexBrowserVerifierOutcome(input: Awaited<
  ReturnType<typeof verifyCodexBrowserWorkflowCandidate>
>): CodexBrowserVerifierAttemptOutcome {
  if (input.verificationKind === 'invalid_output') return 'invalid'
  return input.verdict.verdict
}

export function isAbortFailure(error: unknown, signal: AbortSignal | null): boolean {
  return Boolean(signal?.aborted)
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError')
    || (error instanceof Error && error.message === 'browser_verifier_settlement_interrupted')
}

export function readE5ProofSentinels(): string[] {
  const raw = String(process.env.READY_CODEX_E5_PROOF_SENTINELS_JSON || '').trim()
  const values = raw
    ? JSON.parse(raw) as unknown
    : [String(process.env.READY_CODEX_E5_PROOF_SENTINEL || '')]
  if (!Array.isArray(values) || values.length < 1 || values.length > 4
    || values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 256)
    || new Set(values).size !== values.length) {
    throw new Error('codex_e5_proof_sentinels_invalid')
  }
  return values
}

export function activeProfile(settings: AppSettingsRepository): { profileId: string; config: AIModelConfig } {
  const workspace = settings.getAIWorkspace()
  const profileId = settings.getActiveAIProfileId()
  const profile = profileId ? workspace.profiles.find((entry) => entry.id === profileId) : null
  if (!profile) throw new Error('codex_active_profile_missing')
  return { profileId: profileId as string, config: profile.config }
}
