import { createHash } from 'node:crypto'

import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import { evaluateSpecialistBlueprintAdmission } from './specialist-blueprint-admission'
import { renderSpecialistFoundationMarkdown } from './specialist-blueprint-quality'

export interface SpecialistBlueprintReviewRegistry {
  get(id: string): AgentRegistryRecord | null
  list?(): AgentRegistryRecord[]
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function materializeSpecialistBlueprintForReview(
  registry: SpecialistBlueprintReviewRegistry,
  blueprint: SpecialistAgentBlueprint,
): SpecialistAgentBlueprint {
  const admission = evaluateSpecialistBlueprintAdmission(registry, blueprint)
  const canonical: SpecialistAgentBlueprint = {
    ...blueprint,
    admissionVerdict: admission.verdict,
    qualityChecks: admission.qualityChecks,
  }
  return {
    ...canonical,
    foundationDocs: {
      ...canonical.foundationDocs,
      foundationText: renderSpecialistFoundationMarkdown(canonical),
    },
  }
}

export function hashSpecialistBlueprintReviewContent(blueprint: SpecialistAgentBlueprint): string {
  const {
    status: _status,
    confirmation: _confirmation,
    adoption: _adoption,
    semanticReview: _semanticReview,
    ...reviewContent
  } = blueprint
  return createHash('sha256').update(stableStringify(reviewContent)).digest('hex')
}
