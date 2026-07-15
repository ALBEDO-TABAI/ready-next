import { MemorySession, type ModelProvider } from '@openai/agents'
import { createHash } from 'node:crypto'

import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../agent-sdk-types'
import { logAgentMetric } from '../../metrics'
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
    // silent-catch: malformed verifier output is converted into the blocking verdict below, never accepted.
    return invalidVerifierVerdict('独立复核返回内容无法识别')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidVerifierVerdict('独立复核返回格式错误')
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || !['accept', 'repair', 'block'].includes(String(record.verdict))) {
    return invalidVerifierVerdict('独立复核返回了未知结论')
  }
  if (!Array.isArray(record.gaps)) return invalidVerifierVerdict('独立复核没有给出问题清单')
  let invalidGap = false
  const gaps = record.gaps.map((gap) => {
    if (!gap || typeof gap !== 'object' || Array.isArray(gap)) {
      invalidGap = true
      return { kind: 'text' as const, description: '独立复核的问题项格式错误' }
    }
    const value = gap as Record<string, unknown>
    if (!['text', 'artifact', 'external_action'].includes(String(value.kind)) || typeof value.description !== 'string' || !value.description.trim()) {
      invalidGap = true
      return { kind: 'text' as const, description: '独立复核的问题项无效' }
    }
    return {
      kind: value.kind as 'text' | 'artifact' | 'external_action',
      description: value.description.trim(),
      ...(typeof value.targetRefId === 'string' && value.targetRefId.trim()
        ? { targetRefId: value.targetRefId.trim() }
        : {}),
    }
  })
  if (invalidGap) return invalidVerifierVerdict('独立复核的问题清单格式错误')
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (!summary) return invalidVerifierVerdict('独立复核没有给出结论说明')
  if (record.verdict === 'accept' && gaps.length > 0) return invalidVerifierVerdict('独立复核结论与问题清单互相矛盾')
  if (record.verdict !== 'accept' && gaps.length === 0) return invalidVerifierVerdict('独立复核未说明未通过原因')
  return { version: 1, verdict: record.verdict as DeliveryVerificationVerdict['verdict'], gaps, summary }
}

function invalidVerifierVerdict(description: string): DeliveryVerificationVerdict {
  return {
    version: 1,
    verdict: 'block',
    gaps: [{ kind: 'text', description }],
    summary: '独立复核未能形成有效结论，已安全阻止交付。',
  }
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
    instructions: 'Return only JSON with exactly this shape: {"version":1,"verdict":"accept"|"repair"|"block","gaps":[{"kind":"text"|"artifact"|"external_action","description":"non-empty","targetRefId":"optional"}],"summary":"non-empty"}. accept requires empty gaps; repair or block requires at least one gap. Use no tools and judge only the sealed candidate bundle.',
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
  const verdict = parseDeliveryVerification(result.finalText)
  if (verdict.summary === '独立复核未能形成有效结论，已安全阻止交付。') {
    const raw = String(result.finalText || '')
    logAgentMetric('dynamic_delivery_verifier_invalid_output', {
      runId: input.runId,
      taskId: input.taskId,
      outputLength: raw.length,
      outputHash: createHash('sha256').update(raw).digest('hex'),
      outputShape: raw.trim().startsWith('{') ? 'json_object_candidate' : 'non_object_text',
    })
  }
  return { verdict, usage: result.usage }
}
