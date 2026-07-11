import { MemorySession, type ModelProvider } from '@openai/agents'

import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../agent-sdk-types'
import type { SealedDeliveryCandidate } from './seal-delivery-candidate'

export interface DeliveryVerificationVerdict {
  version: 1
  verdict: 'accept' | 'repair' | 'block'
  gaps: Array<{
    kind: 'text' | 'artifact' | 'external_action'
    description: string
    targetRefId?: string
  }>
  summary: string
}

export function parseDeliveryVerification(raw: string): DeliveryVerificationVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  } catch {
    throw new Error('[dynamic-delivery] verifier returned invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('[dynamic-delivery] verifier verdict must be an object')
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || !['accept', 'repair', 'block'].includes(String(record.verdict))) {
    throw new Error('[dynamic-delivery] verifier verdict is outside the closed union')
  }
  if (!Array.isArray(record.gaps)) throw new Error('[dynamic-delivery] verifier gaps must be an array')
  const gaps = record.gaps.map((gap) => {
    if (!gap || typeof gap !== 'object' || Array.isArray(gap)) throw new Error('[dynamic-delivery] verifier gap must be an object')
    const value = gap as Record<string, unknown>
    if (!['text', 'artifact', 'external_action'].includes(String(value.kind)) || typeof value.description !== 'string' || !value.description.trim()) {
      throw new Error('[dynamic-delivery] verifier gap is invalid')
    }
    return {
      kind: value.kind as 'text' | 'artifact' | 'external_action',
      description: value.description.trim(),
      ...(typeof value.targetRefId === 'string' && value.targetRefId.trim()
        ? { targetRefId: value.targetRefId.trim() }
        : {}),
    }
  })
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (!summary) throw new Error('[dynamic-delivery] verifier summary is required')
  if (record.verdict === 'accept' && gaps.length > 0) throw new Error('[dynamic-delivery] accepted verdict cannot carry gaps')
  if (record.verdict !== 'accept' && gaps.length === 0) throw new Error('[dynamic-delivery] non-accept verdict requires gaps')
  return { version: 1, verdict: record.verdict as DeliveryVerificationVerdict['verdict'], gaps, summary }
}

export async function verifyDeliveryCandidate(input: {
  candidate: SealedDeliveryCandidate
  runId: string
  taskId: string
  model: string
  provider: ModelProvider
  contextWindowTokens: number
  maxOutputTokens: number
  signal: AbortSignal
  runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
}): Promise<{ verdict: DeliveryVerificationVerdict; usage: ReadyAgentSdkRunResult['usage'] }> {
  const result = await input.runAgent({
    agentName: 'dynamic-delivery-verifier',
    runId: `${input.runId}:verifier`,
    taskId: input.taskId,
    sessionId: `${input.runId}:verifier`,
    input: JSON.stringify(input.candidate),
    instructions: 'Return only strict DeliveryVerificationVerdict JSON. Use no tools and judge only the sealed candidate bundle.',
    model: input.model,
    provider: input.provider,
    session: new MemorySession({ sessionId: `${input.runId}:verifier` }),
    tools: [],
    signal: input.signal,
    maxTurns: 1,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    onTextDelta: () => undefined,
  })
  return { verdict: parseDeliveryVerification(result.finalText), usage: result.usage }
}
