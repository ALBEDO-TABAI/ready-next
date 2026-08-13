import type { ModelProvider } from '@openai/agents'

import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../agent-sdk-types'
import {
  verifyDeliveryCandidate,
  type DeliveryVerificationVerdict,
} from './delivery-verifier'
import {
  sealDeliveryCandidate,
  type SealedDeliveryCandidate,
} from './seal-delivery-candidate'
import type { VerifierResourceBundle } from './verifier-resource-bundle'

export type StandaloneDeliveryVerificationInput = {
  runId: string
  taskId: string
  userRequestVerbatim: string
  candidateText: string
  hostCriteria: ReadonlyArray<Record<string, unknown>>
  modelCriteria: readonly string[]
  model: string
  provider: ModelProvider
  contextWindowTokens: number
  maxOutputTokens: number
  signal: AbortSignal
  verifierAgentName?: string
  materializeAndReadBack: () => Promise<VerifierResourceBundle>
  runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
}

export async function verifyStandaloneDeliveryCandidate(
  input: StandaloneDeliveryVerificationInput,
): Promise<{
  verdict: DeliveryVerificationVerdict
  sealed: Readonly<SealedDeliveryCandidate>
  verificationUsage: ReadyAgentSdkRunResult['usage']
  verificationKind: 'model_verdict' | 'invalid_output' | 'mechanical_block'
}> {
  const sealed = await sealDeliveryCandidate({
    userRequestVerbatim: input.userRequestVerbatim,
    candidateText: input.candidateText,
    hostCriteria: input.hostCriteria,
    modelCriteria: input.modelCriteria,
    openQuestions: [],
    materializeAndReadBack: input.materializeAndReadBack,
  })
  const mechanicalIssues = sealed.resources.mechanicalIssues ?? []
  if (mechanicalIssues.length > 0) {
    return {
      verdict: {
        version: 1,
        verdict: 'block',
        gaps: mechanicalIssues.map((issue) => ({
          kind: 'artifact' as const,
          description: `[${issue.code}] ${issue.description}`,
          ...(issue.targetRefId ? { targetRefId: issue.targetRefId } : {}),
        })),
        summary: '产物机械验收未通过，未进入语义复核。',
      },
      sealed,
      verificationUsage: undefined,
      verificationKind: 'mechanical_block',
    }
  }
  const verification = await verifyDeliveryCandidate({
    candidate: sealed,
    runId: input.runId,
    taskId: input.taskId,
    model: input.model,
    provider: input.provider,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    signal: input.signal,
    verifierAgentName: input.verifierAgentName,
    runAgent: input.runAgent,
  })
  return {
    verdict: verification.verdict,
    sealed,
    verificationUsage: verification.usage,
    verificationKind: verification.invalidOutput ? 'invalid_output' : 'model_verdict',
  }
}
