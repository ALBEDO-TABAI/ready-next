import type {
  CapabilityExposure,
  CapabilityGroupId,
  CapabilityMode,
  CapabilityProfileId,
} from './ai-capability-groups'

export type CapabilityRuntimeReason =
  | 'enabled'
  | 'host_only'
  | 'inactive'
  | 'profile_disabled'
  | 'disabled_by_config'
  | 'provider_disabled_tools'
  | 'environment_unavailable'
  | 'run_intent_suppressed'

export type CapabilityRuntimeStatus =
  | 'available'
  | 'closed'
  | 'environment_unavailable'
  | 'run_intent_suppressed'
  | 'host_only'
  | 'inactive'

export interface CapabilityRuntimeGroupSnapshot {
  id: CapabilityGroupId
  label: string
  description: string
  exposure: CapabilityExposure
  mode: CapabilityMode
  status: CapabilityRuntimeStatus
  reason: CapabilityRuntimeReason
  settingsVisible: boolean
  hasDynamicSource: boolean
  toolCount: number
}

export interface CapabilityRuntimeEnvironmentSummary {
  browserHostAvailable: boolean
  feishuConnected: boolean
  enabledChannelTypes: string[]
  connectedChannelTypes: string[]
}

export interface CapabilityRuntimeSnapshot {
  generatedAt: string
  profile: CapabilityProfileId
  groups: Record<CapabilityGroupId, CapabilityRuntimeGroupSnapshot>
  environment: CapabilityRuntimeEnvironmentSummary
}
