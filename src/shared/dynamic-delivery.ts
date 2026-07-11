import type { TaskExecutionBinding } from './agent-execution-profile'
import type { TaskType } from './task-types'

export const DELIVERY_MODES = ['standard', 'adaptive', 'thorough'] as const
export type DeliveryMode = typeof DELIVERY_MODES[number]
export const DELIVERY_MODE_SETTING_KEY = 'agent.dynamicDeliveryMode'
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'adaptive'

export const COLLABORATION_DECISIONS = ['single_path', 'verify_only', 'support_and_verify'] as const
export type CollaborationDecision = typeof COLLABORATION_DECISIONS[number]

export type DeliveryPackageStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'redispatching'
  | 'degraded'
  | 'blocked'

export interface DeliveryRunUsageSnapshot {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  usageSource: 'provider' | 'estimated' | 'missing'
  providerCallCount: number
  missingCallCount: number
}

export interface DeliveryPackageState {
  packageId: string
  attempt: 0 | 1
  childTaskId: string
  lifecycleId: string
  binding: TaskExecutionBinding
  criticality: 'required' | 'optional'
  status: DeliveryPackageStatus
  adoptedByOwner: boolean | null
  evidenceHandleIds: string[]
}

export interface DeliveryStateV1 {
  version: 1
  stateRevision: number
  decision: CollaborationDecision
  parentGeneration: number
  packages: DeliveryPackageState[]
  verifier: {
    status: 'not_required' | 'pending' | 'accepted' | 'repair' | 'blocked'
    repaired: boolean
  }
  usage: DeliveryRunUsageSnapshot
}

export interface AgentProfileSummary {
  agentId: string
  name: string
  collaborationReady: boolean
}

export interface DeliveryBudgetSnapshot {
  totalRunTokenLimit: number
  ownerReservedTokens: number
  remainingTokens: number
  remainingWallClockMs: number
}

export interface DeliveryPreflightFacts {
  mode: DeliveryMode
  taskType: TaskType
  intentDomains: string[]
  structuredTargetCount: number
  /** Explicitly referenced, readable resources with enough real body text for
   *  a no-tools worker to analyze before the Owner runs. */
  groundedWorkerResourceCount: number
  contextRefIds: string[]
  selectedSkillId: string | null
  risk: 'ordinary' | 'awaiting_confirmation' | 'exclusive_action' | 'resource_conflict'
  profiles: AgentProfileSummary[]
  hostCriteria: Array<Record<string, unknown>>
  budget: DeliveryBudgetSnapshot
  hasUnknownRequiredFact: boolean
}

export type WorkPackageExecutorHint =
  | { kind: 'registered_agent'; agentId: string }
  | { kind: 'ephemeral'; role: 'researcher' | 'producer' | 'critic' }

export interface WorkPackage {
  packageId: string
  title: string
  objective: string
  deliverable: string
  expectedOutputs: string[]
  proposedCriteria: string[]
  contextRefIds: string[]
  executorHint: WorkPackageExecutorHint
  criticality: 'required' | 'optional'
}

export interface DispatchPlan {
  version: 1
  packages: WorkPackage[]
}

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === 'string' && (DELIVERY_MODES as readonly string[]).includes(value)
}

export function emptyDeliveryUsage(): DeliveryRunUsageSnapshot {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageSource: 'missing',
    providerCallCount: 0,
    missingCallCount: 0,
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

export function assertDeliveryState(value: unknown): asserts value is DeliveryStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[dynamic-delivery] delivery state must be an object')
  }
  const state = value as Partial<DeliveryStateV1>
  if (state.version !== 1) throw new Error(`[dynamic-delivery] unsupported delivery state version: ${String(state.version)}`)
  if (!isNonNegativeInteger(state.stateRevision)) throw new Error('[dynamic-delivery] stateRevision must be a non-negative integer')
  if (!(COLLABORATION_DECISIONS as readonly unknown[]).includes(state.decision)) {
    throw new Error(`[dynamic-delivery] invalid decision: ${String(state.decision)}`)
  }
  if (!isNonNegativeInteger(state.parentGeneration)) throw new Error('[dynamic-delivery] parentGeneration must be a non-negative integer')
  if (!Array.isArray(state.packages)) throw new Error('[dynamic-delivery] packages must be an array')
  if (!state.verifier || typeof state.verifier !== 'object') throw new Error('[dynamic-delivery] verifier state is required')
  const verifierStatus = state.verifier.status
  if (!['not_required', 'pending', 'accepted', 'repair', 'blocked'].includes(String(verifierStatus))) {
    throw new Error(`[dynamic-delivery] invalid verifier status: ${String(verifierStatus)}`)
  }
  if (typeof state.verifier.repaired !== 'boolean') throw new Error('[dynamic-delivery] verifier.repaired must be boolean')
  if (!state.usage || typeof state.usage !== 'object') throw new Error('[dynamic-delivery] usage snapshot is required')
  for (const entry of state.packages) {
    if (!entry || typeof entry !== 'object') throw new Error('[dynamic-delivery] package state must be an object')
    const pkg = entry as DeliveryPackageState
    if (!pkg.packageId || !pkg.childTaskId || !pkg.lifecycleId) throw new Error('[dynamic-delivery] package identity is incomplete')
    if (pkg.attempt !== 0 && pkg.attempt !== 1) throw new Error('[dynamic-delivery] package attempt must be 0 or 1')
    if (!['required', 'optional'].includes(pkg.criticality)) throw new Error('[dynamic-delivery] invalid package criticality')
    if (!['planned', 'running', 'completed', 'redispatching', 'degraded', 'blocked'].includes(pkg.status)) {
      throw new Error('[dynamic-delivery] invalid package status')
    }
    if (!Array.isArray(pkg.evidenceHandleIds) || pkg.evidenceHandleIds.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('[dynamic-delivery] evidenceHandleIds must be non-empty strings')
    }
  }
}

export function parseDeliveryStateJson(raw: string | null | undefined): DeliveryStateV1 | null {
  if (raw === null || raw === undefined || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('[dynamic-delivery] invalid delivery_state_json')
  }
  assertDeliveryState(parsed)
  return parsed
}
