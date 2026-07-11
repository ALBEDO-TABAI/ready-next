import type { AgentExecutionProfile, TaskExecutionBinding } from '../../../../../shared/agent-execution-profile'
import type { WorkPackage } from '../../../../../shared/dynamic-delivery'
import type { WorkerResourceBundle } from './worker-resource-bundle'

export interface SpecialistWorkerInput {
  userRequestVerbatim: string
  workPackage: WorkPackage
  binding: TaskExecutionBinding
  profile: AgentExecutionProfile | null
  ephemeralRole: 'researcher' | 'producer' | 'critic' | null
  resourceBundle: WorkerResourceBundle
}

export function buildSpecialistWorkerPrompt(input: SpecialistWorkerInput): string {
  if (!input.userRequestVerbatim) throw new Error('[dynamic-delivery] worker requires verbatim user request')
  if (input.binding.kind === 'registered_agent' && !input.profile) {
    throw new Error('[dynamic-delivery] registered worker requires a frozen execution profile')
  }
  if (input.binding.kind === 'ephemeral' && !input.ephemeralRole) {
    throw new Error('[dynamic-delivery] ephemeral worker requires a closed role')
  }
  return JSON.stringify({
    contract: 'dynamic_delivery_worker_v1',
    userRequestVerbatim: input.userRequestVerbatim,
    workPackage: input.workPackage,
    execution: input.binding.kind === 'registered_agent'
      ? {
          kind: 'registered_agent',
          agentId: input.profile!.effectiveAgentId,
          executionMaterialHash: input.profile!.executionMaterialHash,
          charter: input.profile!.charter,
          personality: input.profile!.personality,
          rules: input.profile!.rules,
          knowledgeIndex: input.profile!.knowledgeIndex,
          allowedKnowledgeRefs: input.profile!.allowedKnowledgeRefs,
        }
      : { kind: 'ephemeral', role: input.ephemeralRole },
    resources: input.resourceBundle,
    outputContract: {
      version: 1,
      forbiddenFields: ['proofRefs', 'satisfied', 'not_applicable', 'usage'],
      summaryLinesMax: 5,
    },
  })
}
