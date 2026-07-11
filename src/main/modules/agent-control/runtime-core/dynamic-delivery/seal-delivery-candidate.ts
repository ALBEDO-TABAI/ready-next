import type { VerifierResourceBundle } from './verifier-resource-bundle'
import { assertVerifierResourceBundle } from './verifier-resource-bundle'

export interface SealedDeliveryCandidate {
  version: 1
  userRequestVerbatim: string
  candidateText: string
  criteria: ReadonlyArray<Record<string, unknown>>
  openQuestions: readonly string[]
  resources: VerifierResourceBundle
  sealedAt: string
}

export async function sealDeliveryCandidate(input: {
  userRequestVerbatim: string
  candidateText: string
  hostCriteria: ReadonlyArray<Record<string, unknown>>
  modelCriteria: readonly string[]
  openQuestions: readonly string[]
  materializeAndReadBack: () => Promise<VerifierResourceBundle>
  now?: () => Date
}): Promise<Readonly<SealedDeliveryCandidate>> {
  if (!input.userRequestVerbatim || !input.candidateText.trim()) {
    throw new Error('[dynamic-delivery] candidate cannot seal without request and output')
  }
  const resources = await input.materializeAndReadBack()
  assertVerifierResourceBundle(resources)
  const criteria = [
    ...input.hostCriteria.map((criterion) => ({ ...criterion })),
    ...input.modelCriteria.map((text, index) => ({
      id: `m${index + 1}`,
      kind: 'model_declared',
      source: 'model',
      text,
    })),
  ]
  return Object.freeze({
    version: 1,
    userRequestVerbatim: input.userRequestVerbatim,
    candidateText: input.candidateText,
    criteria,
    openQuestions: [...input.openQuestions],
    resources,
    sealedAt: (input.now ?? (() => new Date()))().toISOString(),
  })
}
