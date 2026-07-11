import type { TaskType } from '../../../../../shared/task-types'

export interface CanonicalDeliveryTaskFacts {
  taskType: TaskType
  intentDomains: string[]
  structuredTargetIds: string[]
  contextRefIds: string[]
  hasUnknownRequiredFact: boolean
}

export function buildCanonicalDeliveryTaskFacts(input: {
  taskType: TaskType | null
  intentDomains: readonly string[] | null
  structuredTargetIds: readonly string[] | null
  contextRefIds: readonly string[] | null
  signalConflict?: boolean
}): CanonicalDeliveryTaskFacts {
  const normalize = (values: readonly string[] | null): string[] => values
    ? [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    : []
  return {
    taskType: input.taskType ?? 'short_task',
    intentDomains: normalize(input.intentDomains),
    structuredTargetIds: normalize(input.structuredTargetIds),
    contextRefIds: normalize(input.contextRefIds),
    hasUnknownRequiredFact: Boolean(
      input.signalConflict
      || !input.taskType
      || !input.intentDomains
      || !input.structuredTargetIds
      || !input.contextRefIds,
    ),
  }
}
