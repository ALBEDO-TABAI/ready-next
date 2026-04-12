import type { AIModelConfig } from '../../../shared/ai-providers'
import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type {
  CapabilityGroupId,
  CapabilityProfileId,
} from '../../../shared/ai-capability-groups'
import type {
  CapabilityRuntimeGroupSnapshot,
  CapabilityRuntimeSnapshot,
  CapabilityRuntimeStatus,
} from '../../../shared/ai-capability-runtime'
import { resolveCapabilityResolution, type CapabilityRuntimeAvailability } from './capability-resolver'
import { defaultToolGateway } from './tool-gateway'

function mapRuntimeStatus(params: {
  status: 'visible' | 'suppressed' | 'unavailable' | 'host_only' | 'inactive'
  reason: string
}): CapabilityRuntimeStatus {
  if (params.status === 'visible') return 'available'
  if (params.status === 'unavailable') return 'environment_unavailable'
  if (params.status === 'host_only') return 'host_only'
  if (params.status === 'inactive') return 'inactive'
  if (params.reason === 'run_intent_suppressed') return 'run_intent_suppressed'
  return 'closed'
}

export function buildCapabilityRuntimeSnapshot(params: {
  config: AIModelConfig
  profile: CapabilityProfileId
  browserDecisionMode: BrowserTaskDecisionMode
  runtimeAvailability: CapabilityRuntimeAvailability
  intentGroupModes?: Partial<Record<CapabilityGroupId, boolean>>
  enabledChannelTypes?: string[]
  connectedChannelTypes?: string[]
}): CapabilityRuntimeSnapshot {
  const capabilityResolution = resolveCapabilityResolution({
    config: params.config,
    profile: params.profile,
    browserDecisionMode: params.browserDecisionMode,
    runtimeAvailability: params.runtimeAvailability,
    intentGroupModes: params.intentGroupModes,
  })

  const groups = defaultToolGateway.listCapabilityGroups().reduce((acc, group) => {
    const state = capabilityResolution.groupStates[group.id]
    const snapshot: CapabilityRuntimeGroupSnapshot = {
      id: group.id,
      label: group.label,
      description: group.description,
      exposure: group.exposure,
      mode: state.mode,
      status: mapRuntimeStatus({
        status: state.status,
        reason: state.reason,
      }),
      reason: state.reason,
      settingsVisible: group.settingsVisible,
      hasDynamicSource: group.hasDynamicSource,
      toolCount: group.toolNames.length,
    }
    acc[group.id] = snapshot
    return acc
  }, {} as Record<CapabilityGroupId, CapabilityRuntimeGroupSnapshot>)

  return {
    generatedAt: new Date().toISOString(),
    profile: params.profile,
    groups,
    environment: {
      browserHostAvailable: params.runtimeAvailability.browserHostAvailable,
      feishuConnected: params.runtimeAvailability.feishuConnected,
      enabledChannelTypes: params.enabledChannelTypes || [],
      connectedChannelTypes: params.connectedChannelTypes || [],
    },
  }
}
