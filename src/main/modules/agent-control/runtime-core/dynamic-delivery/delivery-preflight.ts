import type {
  AgentProfileSummary,
  DeliveryBudgetSnapshot,
  DeliveryMode,
  DeliveryPreflightFacts,
} from '../../../../../shared/dynamic-delivery'
import type { TaskType } from '../../../../../shared/task-types'

export interface DeliveryPreflightInput {
  mode: DeliveryMode
  taskType: TaskType | null
  intentDomains: readonly string[] | null
  structuredTargetIds: readonly string[] | null
  groundedWorkerResourceCount: number | null
  contextRefIds: readonly string[] | null
  selectedSkillId: string | null
  risk: DeliveryPreflightFacts['risk'] | null
  profiles: readonly AgentProfileSummary[] | null
  hostCriteria: ReadonlyArray<Record<string, unknown>> | null
  budget: DeliveryBudgetSnapshot | null
}

function uniqueNonEmpty(values: readonly string[] | null): string[] {
  return values
    ? [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    : []
}

export function buildDeliveryPreflightFacts(input: DeliveryPreflightInput): DeliveryPreflightFacts {
  const requiredKnown = Boolean(
    input.taskType
    && input.intentDomains
    && input.structuredTargetIds
    && input.groundedWorkerResourceCount !== null
    && input.contextRefIds
    && input.risk
    && input.profiles
    && input.hostCriteria
    && input.budget,
  )
  return {
    mode: input.mode,
    taskType: input.taskType ?? 'short_task',
    intentDomains: uniqueNonEmpty(input.intentDomains),
    structuredTargetCount: uniqueNonEmpty(input.structuredTargetIds).length,
    groundedWorkerResourceCount: Math.max(0, Math.floor(input.groundedWorkerResourceCount ?? 0)),
    contextRefIds: uniqueNonEmpty(input.contextRefIds),
    selectedSkillId: input.selectedSkillId?.trim() || null,
    risk: input.risk ?? 'ordinary',
    profiles: input.profiles ? input.profiles.map((profile) => ({ ...profile })) : [],
    hostCriteria: input.hostCriteria ? input.hostCriteria.map((criterion) => ({ ...criterion })) : [],
    budget: input.budget ?? {
      totalRunTokenLimit: 0,
      ownerReservedTokens: 0,
      remainingTokens: 0,
      remainingWallClockMs: 0,
    },
    hasUnknownRequiredFact: !requiredKnown,
  }
}
