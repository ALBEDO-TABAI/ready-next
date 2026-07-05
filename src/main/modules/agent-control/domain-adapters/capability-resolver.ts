import type { AIModelConfig } from '../../../../shared/ai-providers'
import { resolveAIConfigCapabilities } from '../../../../shared/ai-providers'
import type {
  CapabilityGroupId,
  CapabilityMode,
  CapabilityModeMap,
  CapabilityProfileId,
} from '../../../../shared/ai-capability-groups'
import {
  CAPABILITY_GROUPS,
  normalizeCapabilityModeMap,
} from '../../../../shared/ai-capability-groups'
import type { BrowserTaskDecisionMode } from '../../../../shared/browser-agent-task'

export type CapabilityGroupStatus = 'visible' | 'suppressed' | 'unavailable' | 'host_only' | 'inactive'
export type CapabilityGroupReason =
  | 'enabled'
  | 'host_only'
  | 'inactive'
  | 'profile_disabled'
  | 'disabled_by_config'
  | 'provider_disabled_tools'
  | 'environment_unavailable'
  | 'run_intent_suppressed'

export interface CapabilityGroupState {
  id: CapabilityGroupId
  mode: CapabilityMode
  status: CapabilityGroupStatus
  reason: CapabilityGroupReason
  label: string
}

export interface CapabilityResolution {
  visibleCapabilityGroupIds: CapabilityGroupId[]
  hostOnlyCapabilityIds: CapabilityGroupId[]
  suppressedCapabilityGroupIds: CapabilityGroupId[]
  uiProjectionGroupIds: CapabilityGroupId[]
  groupStates: Record<CapabilityGroupId, CapabilityGroupState>
  reasons: Partial<Record<CapabilityGroupId, CapabilityGroupReason>>
  /**
   * Stage S (PR-S6 / W4.1) — capability gate enforce in arbitration.
   *
   * Surface the three resolved capability flags from
   * `resolveAIConfigCapabilities` directly on `CapabilityResolution`
   * so `run-capability-controller.resolveRunCapabilities` and other
   * arbitration-time consumers can branch on them without re-resolving.
   * Optional because legacy code paths constructing a stub
   * `CapabilityResolution` (tests, fixtures) need to keep working.
   */
  supportsVision?: boolean
  supportsThinking?: boolean
  supportsLongContext?: boolean
}

export interface CapabilityRuntimeAvailability {
  browserHostAvailable: boolean
  feishuConnected: boolean
  /** Phase I（2026-07-05）—— 当前 run 的 scope 是否绑定了远程渠道线程
   * （agent_channel_threads 命中）。channel_outbound 组仅在绑定时可见。 */
  channelScopeBound?: boolean
}

export function resolveCapabilityResolution(params: {
  config: AIModelConfig
  profile: CapabilityProfileId
  browserDecisionMode: BrowserTaskDecisionMode
  runtimeAvailability: CapabilityRuntimeAvailability
  intentGroupModes?: Partial<Record<CapabilityGroupId, boolean>>
}): CapabilityResolution {
  const capabilityModes = normalizeCapabilityModeMap(params.config.capabilityModes)
  const resolvedCapabilities = resolveAIConfigCapabilities(params.config)
  const supportsModelTools = resolvedCapabilities?.supportsToolCalls ?? true

  const groupStates = {} as Record<CapabilityGroupId, CapabilityGroupState>
  const visibleCapabilityGroupIds: CapabilityGroupId[] = []
  const hostOnlyCapabilityIds: CapabilityGroupId[] = []
  const suppressedCapabilityGroupIds: CapabilityGroupId[] = []
  const uiProjectionGroupIds: CapabilityGroupId[] = []
  const reasons: Partial<Record<CapabilityGroupId, CapabilityGroupReason>> = {}

  const defaultIntentModes: Partial<Record<CapabilityGroupId, boolean>> = {
    browser_interaction:
      params.browserDecisionMode === 'browser_workflow' || params.browserDecisionMode === 'browser_upload_workflow',
    browser_content_tasks:
      params.browserDecisionMode === 'browser_workflow' || params.browserDecisionMode === 'browser_upload_workflow',
  }

  const mergedIntentModes = {
    ...defaultIntentModes,
    ...(params.intentGroupModes || {}),
  }

  for (const group of CAPABILITY_GROUPS) {
    const mode = capabilityModes[group.id] || group.defaultMode

    if (group.availability === 'inactive') {
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'inactive',
        reason: 'inactive',
        label: group.label,
      }
      uiProjectionGroupIds.push(group.id)
      reasons[group.id] = 'inactive'
      continue
    }

    if (group.exposure === 'host_only') {
      hostOnlyCapabilityIds.push(group.id)
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'host_only',
        reason: 'host_only',
        label: group.label,
      }
      reasons[group.id] = 'host_only'
      continue
    }

    const environmentAvailable = (() => {
      if (group.id === 'browser_interaction' || group.id === 'browser_content_tasks') {
        return params.runtimeAvailability.browserHostAvailable
      }
      if (group.id === 'channel_feishu') {
        return params.runtimeAvailability.feishuConnected
      }
      if (group.id === 'channel_outbound') {
        // Phase I —— 仅在 scope 绑定远程渠道线程时可见（本地会话零暴露）
        return params.runtimeAvailability.channelScopeBound === true
      }
      return true
    })()

    if (!environmentAvailable) {
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'unavailable',
        reason: 'environment_unavailable',
        label: group.label,
      }
      suppressedCapabilityGroupIds.push(group.id)
      uiProjectionGroupIds.push(group.id)
      reasons[group.id] = 'environment_unavailable'
      continue
    }

    if (!supportsModelTools) {
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'suppressed',
        reason: 'provider_disabled_tools',
        label: group.label,
      }
      suppressedCapabilityGroupIds.push(group.id)
      uiProjectionGroupIds.push(group.id)
      reasons[group.id] = 'provider_disabled_tools'
      continue
    }

    if (mode === 'off') {
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'suppressed',
        reason: 'disabled_by_config',
        label: group.label,
      }
      suppressedCapabilityGroupIds.push(group.id)
      uiProjectionGroupIds.push(group.id)
      reasons[group.id] = 'disabled_by_config'
      continue
    }

    const enabledByProfile = mode === 'on' || group.defaultProfiles.includes(params.profile)
    if (!enabledByProfile) {
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'suppressed',
        reason: 'profile_disabled',
        label: group.label,
      }
      suppressedCapabilityGroupIds.push(group.id)
      uiProjectionGroupIds.push(group.id)
      reasons[group.id] = 'profile_disabled'
      continue
    }

    const intentMode = mergedIntentModes[group.id]
    if (intentMode === false) {
      groupStates[group.id] = {
        id: group.id,
        mode,
        status: 'suppressed',
        reason: 'run_intent_suppressed',
        label: group.label,
      }
      suppressedCapabilityGroupIds.push(group.id)
      uiProjectionGroupIds.push(group.id)
      reasons[group.id] = 'run_intent_suppressed'
      continue
    }

    visibleCapabilityGroupIds.push(group.id)
    groupStates[group.id] = {
      id: group.id,
      mode,
      status: 'visible',
      reason: 'enabled',
      label: group.label,
    }
    reasons[group.id] = 'enabled'
  }

  return {
    visibleCapabilityGroupIds,
    hostOnlyCapabilityIds,
    suppressedCapabilityGroupIds,
    uiProjectionGroupIds,
    groupStates,
    reasons,
    // Stage S (PR-S6 / W4.1) — surface the three resolved capability
    // flags so arbitration-time consumers (run-capability-controller,
    // tool-gateway) can read them off `capabilityResolution` directly.
    supportsVision: resolvedCapabilities?.supportsVision ?? false,
    supportsThinking: resolvedCapabilities?.supportsThinking ?? false,
    supportsLongContext: resolvedCapabilities?.supportsLongContext ?? false,
  }
}
